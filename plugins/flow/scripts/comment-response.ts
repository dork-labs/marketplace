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
 * 1. **Never answer its own comments** — the agent's own comment (see
 *    {@link authoredByAgent}), OR any comment carrying `identity.marker`. Only
 *    the account proves authorship; the marker alone only ever silences. In
 *    two-account mode the agent's account is enough. In shared-account mode the
 *    person posts as that same account, so the account alone would silence
 *    every comment they write: there the agent's own comment is the shared
 *    account plus its marker, its last-line `agent:provenance` signature (a
 *    tracker may garble the marker, DOR-2351), or `flow review`'s two records
 *    of what the person did. Another account's signature line
 *    counts for nothing. That split only decides what flow stays quiet on: every
 *    agent here posts as the shared account too, so a comment from it that is
 *    not the agent's own still never grants. The trust check below turns any
 *    acting decision on it into an ignore (Security M1 on #152); the person
 *    answers from DorkOS or with `flow answer`. Highest precedence: it breaks
 *    self-reply loops before any other rule can fire. → `ignore`.
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
 * tracker adapter skill documents (`getInbox` shape) and the P5 promotion
 * surface. `comments.respondWhen` and `comments.ambiguousBias` drive the soft
 * zone so re-tuning chattiness is a config edit, never a code change.
 *
 * @see specs/unified-workflow-system/02-specification.md §5 (comment-response)
 * @see the tracker adapter's SKILL.md, at `adapter.path` from `config-files.ts` (`getInbox` shape, the 5 rules)
 * @module @dorkos/flow/comment-response
 */

import type { z } from 'zod';
import type { CommentsSchema } from './config-schema.ts';
import { endsWithSignature } from './signature-line.ts';
import { authorOf, bodyOf, hasLabel, isTrustedAuthor, mentionsOf } from './work-item.ts';
import type { InboxComment, OwnershipClass, WorkItem } from './work-item.ts';

/** Resolved {@link CommentsSchema} config — `respondWhen` + `ambiguousBias`. */
export type CommentsConfig = z.infer<typeof CommentsSchema>;

/**
 * The `InboxComment` shape lives in `work-item.ts`, beside `WorkItem` and the
 * other adapter-output accessors (`hasLabel`, `mentionsOf`, `bodyOf`, `authorOf`) it
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
   * The reviewer account (`identity.reviewer`). `null`, or the agent's own
   * account, means shared-account mode: the person, and every agent, posts as
   * {@link agent} too.
   */
  reviewer: string | null;
  /**
   * The authorship marker the agent appends to every tracker write
   * (`identity.marker`, default `"— 🤖 /flow"`). Rule 1 ignores a comment that
   * carries it, from any account; alone it never proves authorship.
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
  /**
   * Set when `rule` would have acted but the author is not a trusted member
   * (DOR-3669), so `action` is `ignore`. The caller warns that the comment was
   * left alone; an ordinary ignore never carries it.
   */
  untrusted?: true;
  /**
   * Set with {@link untrusted} when the author is the shared account and the
   * comment is not the agent's own (Security M1 on #152): every agent posts
   * as that account, so its comment may be an agent's, never the person's for
   * sure. The person answers from DorkOS or with `flow answer` instead.
   */
  sharedAccount?: true;
}

/** The durable label that marks an item parked on a human reply (rule 3). */
const NEEDS_INPUT_LABEL = 'agent/needs-input';
/**
 * An explicit in-body `/flow` or `@flow` that directly addresses the engine
 * (rule 2): a whole word, so `/flow:verify` and `**@flow**` count, and a path
 * like `plugins/flow/x`, a URL, `/flows`, `/flow.ts` or `@flow.ai` does not.
 */
const FLOW_ADDRESS_TOKEN = /(?<![\w/.@~-])[/@]flow(?![\w/-]|\.\w)/;

/** `flow review --approve`'s comment for a person: flow's record, not a new comment. */
export const SHIPPED_RECORD = 'Shipped from DorkOS.';
/** How `flow review --changes` starts its comment for a person; flow's record too. */
export const SENT_BACK_PREFIX = 'Sent back: ';
/** The last line `flow answer --text` posts under a person's answer; flow's record too. */
export const ANSWERED_IN_DORKOS = 'Answered in DorkOS.';

/**
 * A marker's characters a tracker keeps: its letters, digits and punctuation,
 * minus `?`, with every run of dashes (and the minus sign) as one `-`, since a
 * tracker may turn `—` into `-`, `--` or `–`.
 */
function markerCore(text: string): string {
  return text.replace(/[\p{Pd}\u2212]+/gu, '-').replace(/[^\p{L}\p{N}\p{P}]|\?/gu, '');
}

/**
 * Whether the last line is the marker with its emoji lost or replaced. Without
 * this, a tracker that garbles the emoji and drops the hidden line leaves
 * `— /flow`, which reads as addressing flow, so flow would answer itself on
 * every tick. Only a whole line matches, so the person's own `/flow` still
 * reaches flow.
 */
function endsWithGarbledMarker(body: string, marker: string): boolean {
  const last = body.trimEnd().split('\n').at(-1) ?? '';
  return markerCore(last).length > 0 && markerCore(last) === markerCore(marker);
}

/** Whether the person shares the agent's account (`reviewer` unset or the agent). */
function sharedAccount(identity: CommentIdentity): boolean {
  return identity.reviewer === null || identity.reviewer === identity.agent;
}

/**
 * Whether the agent wrote the comment: the only proof of authorship. Anything
 * that grants (an answer's anchor, the agent's question) must use this, never
 * the marker alone.
 *
 * In two-account mode, the agent's account. In shared-account mode the person
 * posts as that account too, so it is the account plus the agent's signature:
 * its marker, its marker's garbled form as the last line, a valid last-line
 * `agent:provenance` line, or a `flow review` or `flow answer` record, which is
 * flow's note of what the person already did. A guest cannot forge any of them:
 * the account comes from the tracker. Any agent posting as the shared account
 * could, but that only silences its own comment: a shared-account comment never
 * grants (see {@link shouldRespondToComment}). With `identity.marker` set to
 * nothing, flow may post with no signature at all, so the account alone stays
 * the answer: a comment wrongly silenced beats flow answering itself.
 *
 * @param comment - The comment.
 * @param identity - The resolved agent identity.
 * @returns `true` only for the agent's own comment.
 */
export function authoredByAgent(comment: InboxComment, identity: CommentIdentity): boolean {
  // An unknown author (`''`) is never the agent, even if `identity.agent` is
  // somehow empty too: silence on a missing author must come from the rules
  // below, not from mistaking nobody for the agent.
  const author = authorOf(comment);
  if (author.length === 0 || author !== identity.agent) return false;
  if (!sharedAccount(identity) || identity.marker.length === 0) return true;
  const body = bodyOf(comment);
  return (
    signedAsAgent(comment, identity) ||
    endsWithSignature(body) ||
    endsWithGarbledMarker(body, identity.marker) ||
    body.trim() === SHIPPED_RECORD ||
    body.startsWith(SENT_BACK_PREFIX) ||
    body.trimEnd().split('\n').at(-1)?.trim() === ANSWERED_IN_DORKOS
  );
}

/**
 * Whether the comment carries `identity.marker`, from any account.
 *
 * Anyone can type the marker, so it only ever silences a comment, which is
 * safe. It must never grant anything: the drain's answer search anchors on the
 * agent's account, not the marker (DOR-3677). Keep the marker from other
 * accounts here, too: it holds `/flow`, so another flow agent's comment would
 * otherwise read as directly addressed (rule 2).
 *
 * The hidden `agent:provenance` line counts here for nothing (DOR-2351): any
 * harness signs with it, so reading it from any account would silence another
 * agent that addresses this one. It counts only on the agent's own shared
 * account ({@link authoredByAgent}).
 */
function signedAsAgent(comment: InboxComment, identity: CommentIdentity): boolean {
  return identity.marker.length > 0 && bodyOf(comment).includes(identity.marker);
}

/**
 * Whether the comment directly addresses the agent (rule 2): an @mention of the
 * agent account, or an explicit `/flow` / `@flow` token in the body (shared-mode
 * address). A directly-addressed comment overrides ownership.
 */
function isDirectlyAddressed(comment: InboxComment, identity: CommentIdentity): boolean {
  if (mentionsOf(comment).includes(identity.agent)) return true;
  return FLOW_ADDRESS_TOKEN.test(bodyOf(comment));
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
 * 1. own comment ({@link authoredByAgent}, or the marker) → `ignore` — breaks self-reply loops first;
 * 2. directly addressed (@mention or `/flow` token) → `respond` — overrides ownership;
 * 3. `agent/needs-input` item + non-agent comment → `resume` — the parked answer;
 * 4. `other`-owned thread (and not addressed) → `ignore` — stay out;
 * 5. soft zone → `respond` if `ambiguousBias: "engage"`, else `ignore`.
 *
 * Then the trust check: an acting decision for an author who is not a trusted
 * member becomes `ignore` with `untrusted: true` (DOR-3669), and so does one
 * for the shared account in shared mode, with `sharedAccount: true`.
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
  const decision = applyRules(comment, ctx, comments);
  // The one trust check (DOR-3669): whatever rule wants to act, only a member
  // the adapter vouched for gets a turn. Kept outside the rules so none can
  // skip it.
  if (decision.action !== 'ignore' && !isTrustedAuthor(comment)) {
    return { action: 'ignore', rule: decision.rule, untrusted: true };
  }
  // In shared mode every agent posts as the shared account, so a comment from
  // it that rule 1 did not take for the agent's own may still be an agent's: a
  // worker answering its own question, or a prompt-injected one starting a
  // turn. It is silenced well, but it never grants (Security M1 on #152).
  if (
    decision.action !== 'ignore' &&
    sharedAccount(ctx.identity) &&
    authorOf(comment) === ctx.identity.agent
  ) {
    return { action: 'ignore', rule: decision.rule, untrusted: true, sharedAccount: true };
  }
  return decision;
}

/** The five rules, before the trust check. */
function applyRules(
  comment: InboxComment,
  ctx: CommentDecisionContext,
  comments: CommentsConfig
): CommentDecision {
  // Rule 1 — never answer its own comments. Highest precedence: it must fire
  // before "directly addressed" so an agent that @mentions itself or echoes the
  // marker can never trigger a self-reply loop.
  if (authoredByAgent(comment, ctx.identity) || signedAsAgent(comment, ctx.identity)) {
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
  //
  // DOR-638 let a reply with no author resume on its text alone. DOR-3669
  // reverses that on purpose: nobody can vouch for an author-less comment, so
  // the trust check turns this resume into an ignore, and the item stays parked.
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
