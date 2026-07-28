/**
 * Comment-response rules (§5) — reading the comms channel *back*. The typed
 * answer to "a comment landed on a tracker item the agent can see; should the
 * agent act on it, and why?".
 *
 * This is the inbound half of comms ({@link resolveCommsChannel} is the
 * outbound half). When the agent asks via `comment-and-assign` it parks on
 * `agent/needs-input`; the human's reply arrives through `getInbox` and must be
 * recognized as the answer (rule 3). But the same inbox also surfaces unrelated
 * comments — on the agent's own threads, on teammates' threads, @mentions — and
 * the worse failure mode is **over-responding** (a chatty bot on every thread).
 * So the rules are a short list of hard rules, then a conservative soft zone.
 *
 * ## Ownership is consumed as INPUT (the task 3.1 seam)
 *
 * Rules 4 and 5 branch on the item's {@link OwnershipClass}, but the
 * `classifyOwnership` primitive that derives it is built later (task 3.1, §7).
 * This module therefore takes the ownership class as an **injected input** on
 * {@link CommentDecisionContext.ownership} — exactly like the dispatch policy
 * (`dispatch.ts`) takes `classifyOwnership` as a callback. Task 3.1 supplies the
 * real classification; tests inject a class directly. This module never
 * classifies ownership itself.
 *
 * ## The rules, in precedence order
 *
 * 1. **Never answer its own comments** — `author == identity.agent`, OR the body
 *    carries `identity.marker`. In shared-account mode the marker is the *only*
 *    signal. Highest precedence: it breaks self-reply loops before any other
 *    rule can fire. → `ignore`.
 * 2. **Always respond when directly addressed** — an @mention of the agent
 *    account, or an explicit `/flow` / `@flow` token in the body. **Overrides
 *    ownership** — even on a teammate's (`other`-owned) thread. → `respond`.
 * 3. **Resume an `agent/needs-input` item on a non-agent comment** — that reply
 *    is the answer the agent parked for via `needsInput`. → `resume`.
 * 4. **Stay out of `other`-owned threads unless mentioned** — rule 2 already
 *    handled the mention case, so here an `other`-owned thread is left alone.
 *    → `ignore`.
 * 5. **Soft zone leans quiet** — anything left (the agent's own / unassigned /
 *    reviewer threads with no direct address and no parked question) is the
 *    ambiguous middle. With `comments.ambiguousBias: "quiet"` (the default) the
 *    safe default is silence; `"engage"` flips it to respond. Over-responding is
 *    the worse failure, so quiet is the ship default.
 *
 * **This module is the pinned oracle**, mirroring the prose rules the v1
 * `linear-adapter` skill documents (`getInbox` shape) and the P5 promotion
 * surface. `comments.respondWhen` and `comments.ambiguousBias` drive the soft
 * zone so re-tuning chattiness is a config edit, never a code change.
 *
 * @see specs/unified-workflow-system/02-specification.md §5 (comment-response)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (`getInbox` shape, the 5 rules)
 * @module @dorkos/flow/comment-response
 */

import type { z } from 'zod';
import type { CommentsSchema } from './config-schema.ts';
import { bodyOf, hasLabel, mentionsOf } from './work-item.ts';
import type { InboxComment, OwnershipClass, WorkItem } from './work-item.ts';

/** Resolved {@link CommentsSchema} config — `respondWhen` + `ambiguousBias`. */
export type CommentsConfig = z.infer<typeof CommentsSchema>;

/**
 * The `InboxComment` shape lives in `work-item.ts`, beside `WorkItem` and the
 * other adapter-output accessors (`hasLabel`, `mentionsOf`, `bodyOf`) it
 * shares with `PollingTransport` (`transport.ts`). Re-exported here so
 * existing imports from this module
 * (`import { type InboxComment } from './comment-response.ts'`) keep working.
 */
export type { InboxComment } from './work-item.ts';

/**
 * The resolved authorship identity the rules compare against (§7). Supplied by
 * the engine from `config.identity` after `agent: "auto"` is resolved to the
 * runtime account — this module consumes it as input, it does not resolve it.
 */
export interface CommentIdentity {
  /** The resolved agent account id (`identity.agent`, post-`"auto"` resolution). */
  agent: string;
  /**
   * The authorship marker the agent appends to every tracker write
   * (`identity.marker`, default `"— 🤖 /flow"`). In shared-account mode this is
   * the *only* signal that a comment is the agent's own (rule 1).
   */
  marker: string;
}

/**
 * The non-comment context the rules need: the item the comment is on (for its
 * `agent/needs-input` disposition, rule 3), its ownership class (the task 3.1
 * injected input, rules 4–5), and the resolved authorship identity (rule 1).
 */
export interface CommentDecisionContext {
  /** The work item the comment is on — its labels gate rule 3. */
  item: WorkItem;
  /**
   * The item's ownership class (the task 3.1 seam — injected, not classified
   * here). Drives rules 4 and 5.
   */
  ownership: OwnershipClass;
  /** The resolved agent identity to recognize the agent's own writes (rule 1). */
  identity: CommentIdentity;
}

/**
 * The action the agent should take on a comment:
 * - `respond` — engage with the comment (rule 2, or soft-zone `engage`).
 * - `resume` — the comment is the answer to a parked `needsInput`; un-park the
 *   item and continue the loop (rule 3). Distinct from `respond` so the caller
 *   knows to resume the run, not merely post a reply.
 * - `ignore` — stay silent (rule 1, rule 4, or soft-zone `quiet`).
 */
export type CommentAction = 'respond' | 'resume' | 'ignore';

/**
 * The resolved comment-response decision: the action plus the rule that produced
 * it (for audit/logging — "why did the agent stay quiet on DOR-123?").
 */
export interface CommentDecision {
  /** What the agent should do with the comment. */
  action: CommentAction;
  /**
   * Which rule produced the decision (1–5), for audit. Rule 5 (the soft zone) is
   * the only one whose action is config-dependent (`ambiguousBias`).
   */
  rule: 1 | 2 | 3 | 4 | 5;
}

/** The durable label that marks an item parked on a human reply (rule 3). */
const NEEDS_INPUT_LABEL = 'agent/needs-input';
/** Explicit in-body tokens that directly address the engine (rule 2, shared mode). */
const FLOW_ADDRESS_TOKENS = ['/flow', '@flow'];

/**
 * Whether the comment is the agent's own (rule 1): authored by the agent account,
 * or — in shared-account mode — carrying the `identity.marker`. The marker check
 * is the only signal when multiple agents share one tracker account.
 */
function isAgentsOwnComment(comment: InboxComment, identity: CommentIdentity): boolean {
  if (comment.author === identity.agent) return true;
  // Shared-account mode: the marker is the only authorship signal. A non-empty
  // marker present in the body means the agent wrote it.
  return identity.marker.length > 0 && bodyOf(comment).includes(identity.marker);
}

/**
 * Whether the comment directly addresses the agent (rule 2): an @mention of the
 * agent account, or an explicit `/flow` / `@flow` token in the body (shared-mode
 * address). A directly-addressed comment overrides ownership.
 */
function isDirectlyAddressed(comment: InboxComment, identity: CommentIdentity): boolean {
  if (mentionsOf(comment).includes(identity.agent)) return true;
  const body = bodyOf(comment);
  return FLOW_ADDRESS_TOKENS.some((token) => body.includes(token));
}

/**
 * Decide whether — and why — the agent should act on a tracker comment (§5).
 *
 * Walks the five rules in precedence order, returning on the first match. The
 * hard rules (1–4) are deterministic; only the soft zone (rule 5) consults
 * config (`comments.ambiguousBias`), and it defaults to `quiet` because
 * over-responding is the worse failure. Ownership ({@link
 * CommentDecisionContext.ownership}) is consumed as an injected input — the
 * task 3.1 `classifyOwnership` seam — so this module never classifies.
 *
 * Precedence (first match wins):
 * 1. own comment (author or marker) → `ignore` — breaks self-reply loops first;
 * 2. directly addressed (@mention or `/flow` token) → `respond` — overrides ownership;
 * 3. `agent/needs-input` item + non-agent comment → `resume` — the parked answer;
 * 4. `other`-owned thread (and not addressed) → `ignore` — stay out;
 * 5. soft zone → `respond` if `ambiguousBias: "engage"`, else `ignore`.
 *
 * @param comment - The inbound comment (the adapter's `getInbox` shape).
 * @param ctx - The item, its injected ownership class, and the agent identity.
 * @param comments - The resolved `comments` config (`respondWhen`/`ambiguousBias`).
 * @returns The action to take and the rule that produced it.
 */
export function shouldRespondToComment(
  comment: InboxComment,
  ctx: CommentDecisionContext,
  comments: CommentsConfig
): CommentDecision {
  // Rule 1 — never answer its own comments. Highest precedence: it must fire
  // before "directly addressed" so an agent that @mentions itself or echoes the
  // marker can never trigger a self-reply loop.
  if (isAgentsOwnComment(comment, ctx.identity)) {
    return { action: 'ignore', rule: 1 };
  }

  // Rule 2 — always respond when directly addressed. Overrides ownership, even
  // on a teammate's (`other`-owned) thread.
  if (isDirectlyAddressed(comment, ctx.identity)) {
    return { action: 'respond', rule: 2 };
  }

  // Rule 3 — resume when a parked `agent/needs-input` item gets a non-agent
  // comment (rule 1 already excluded the agent's own comments). That reply is
  // the answer the agent parked for via `needsInput`. `hasLabel` (the shared
  // `work-item.ts` accessor) degrades a missing, `null`, or bare-string
  // `labels` value instead of crashing — see DOR-535: `labels` is required
  // under the adapter contract, but the runtime must not crash on a
  // non-conformant adapter, and a bare string would otherwise substring-match.
  if (hasLabel(ctx.item, NEEDS_INPUT_LABEL)) {
    return { action: 'resume', rule: 3 };
  }

  // Rule 4 — stay out of `other`-owned threads unless mentioned (rule 2 already
  // handled the mention case).
  if (ctx.ownership === 'other') {
    return { action: 'ignore', rule: 4 };
  }

  // Rule 5 — the soft zone (own/unassigned/reviewer threads, not addressed, not
  // parked). Leans quiet by default; `engage` flips it. Over-responding is the
  // worse failure, so silence is the safe default.
  return {
    action: comments.ambiguousBias === 'engage' ? 'respond' : 'ignore',
    rule: 5,
  };
}
