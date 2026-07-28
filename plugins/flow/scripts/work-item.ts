/**
 * The generic, tracker-agnostic `WorkItem` shape — the `/flow` engine's single
 * work model. Every tracker adapter (Linear in v1; Jira / GitHub Issues in the
 * P5 server build) normalizes its native issues into this shape, so the generic
 * layer — the dispatch policy (§4), comment handling (§5), ownership
 * classification (§7), and the inbox — never sees a tracker-specific field name.
 *
 * This is the **TypeScript mirror** of the prose `WorkItem` contract documented
 * in `.agents/flow/skills/linear-adapter/SKILL.md` ("The `WorkItem`
 * normalization shape"). The skill is the runtime contract the agent follows in
 * v1 (server-free, skill-based); this module is the typed shape the dispatch
 * library and downstream tasks (2.4 comms, 3.1 `classifyOwnership`, 3.2 inbox)
 * import and program against. Keep the two in lockstep.
 *
 * ## `stateCategory` is matched on CATEGORY, never on display name
 *
 * Tracker workflow states each belong to one of five **categories**
 * (`backlog · unstarted · started · completed · canceled`). The display
 * {@link WorkItem.stateName | `stateName`} ("Triage", "In Progress", "Shipped",
 * …) is team-customizable and varies per team — matching on it is brittle. The
 * generic layer branches **only** on {@link WorkItem.stateCategory}.
 *
 * ## Graceful degradation
 *
 * The adapter populates every field it can and leaves the rest `undefined`; it
 * never fabricates a value to satisfy the shape. The dispatch policy treats
 * missing {@link WorkItem.priority} / {@link WorkItem.size} as **neutral**
 * (never as a real value) — "neutral" must never be confused with "smallest" or
 * "lowest priority". A missing optional is **absent**, never `null`: the
 * conformance harness rejects `null`, and the dispatch oracle degrades it to
 * neutral rather than trusting the shape.
 *
 * @see specs/unified-workflow-system/02-specification.md §3 (PMClient contract), §4 (dispatch)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (the prose WorkItem contract)
 * @module @dorkos/flow/work-item
 */

import { StateCategorySchema } from './config-schema.ts';
import type { z } from 'zod';

/**
 * A tracker workflow-state category. Re-exported from the inferred type of
 * {@link StateCategorySchema} so the work model and the config schema share one
 * definition. The generic layer branches on this, never on display name.
 */
export type StateCategory = z.infer<typeof StateCategorySchema>;

/**
 * The work-item `type`, sourced from the `type/*` label group. Mutually
 * exclusive — exactly one per issue.
 */
export type WorkItemType =
  'idea' | 'research' | 'hypothesis' | 'task' | 'monitor' | 'signal' | 'meta';

/**
 * Tracker-native priority, normalized to the canonical 0–4 scale:
 * `0` none · `1` urgent · `2` high · `3` medium · `4` low. A missing priority is
 * represented as `undefined` (neutral), never `0`.
 */
export type WorkItemPriority = 0 | 1 | 2 | 3 | 4;

/**
 * Agent state-machine disposition, derived from the durable `agent/*` label
 * group (the state machine is the labels, not the ephemeral plan field):
 * `agent/ready` → `ready`, `agent/claimed` → `claimed`,
 * `agent/completed` → `completed`, `agent/needs-input` → `needs-input`.
 */
export type AgentDisposition = 'ready' | 'claimed' | 'completed' | 'needs-input';

/**
 * The four ownership classes the {@link classifyOwnership | `classifyOwnership`}
 * primitive (§7, built in task 3.1) assigns to a work item by comparing its
 * `assignee` / `project.lead` against `identity.agent` / `identity.reviewer`.
 * Drives **both** dispatch eligibility (§4) and comment handling (§5).
 *
 * @see specs/unified-workflow-system/02-specification.md §7
 */
export type OwnershipClass = 'mine' | 'reviewer' | 'other' | 'unassigned';

/**
 * A project as normalized onto a {@link WorkItem}. `stateCategory` may be
 * `undefined` for trackers without project workflow categories (e.g. GitHub
 * Issues) — the project-status dispatch tier is then a no-op for the item.
 */
export interface WorkItemProject {
  /** Tracker-native project id. */
  id: string;
  /** Human-readable project name. */
  name: string;
  /**
   * Project workflow-state category, or `undefined` for trackers without
   * project workflow categories. Branched on by category, never display name.
   */
  stateCategory?: StateCategory;
  /** Account id of the project lead, or `undefined` when unset. */
  lead?: string;
}

/**
 * The typed dependency graph for a {@link WorkItem}, read from the tracker's
 * native typed relations (never from description prose). {@link blockedBy} feeds
 * the dispatch eligibility filter (§4); {@link blocks} feeds the tier-1
 * "unblockers first" ranking.
 *
 * Relation arrays carry the **identifiers** of the related items (the human key,
 * e.g. `"DOR-123"`), so the dispatch policy can resolve them against the
 * candidate set without re-fetching the tracker.
 */
export interface WorkItemRelations {
  /** Identifiers of items THIS item blocks (feeds tier-1 "unblockers"). */
  blocks: string[];
  /** Identifiers of items that block THIS item (feeds dispatch eligibility). */
  blockedBy: string[];
  /** Identifiers of sub-issues (children) of THIS item. */
  children: string[];
  /** Identifiers of related (non-blocking) items. */
  relatedTo: string[];
  /** Identifier of the item THIS item duplicates, if any. */
  duplicateOf?: string;
}

/**
 * The generic, tracker-agnostic work model. Every read verb on the tracker
 * adapter returns work normalized into this shape; the generic layer never sees
 * a tracker-specific field name.
 *
 * @see .agents/flow/skills/linear-adapter/SKILL.md (the prose contract this mirrors)
 */
export interface WorkItem {
  /** Tracker-native id (e.g. a Linear node id). */
  id: string;
  /** Human key, e.g. `"DOR-123"` — the worktree/branch key and relation key. */
  identifier: string;
  /** Issue title. */
  title: string;
  /** Issue description / body. */
  description: string;
  /** The `type/*` label group value (exactly one per issue). */
  type: WorkItemType;
  /**
   * Workflow-state category (`backlog · unstarted · started · completed ·
   * canceled`). The generic layer branches **only** on this, never on
   * {@link stateName}.
   */
  stateCategory: StateCategory;
  /**
   * Display-only state name ("In Progress", "Triage", …). Carried for rendering;
   * **never matched on** — it is team-customizable and brittle.
   */
  stateName: string;
  /**
   * Tracker-native priority on the 0–4 scale, or `undefined` (neutral) when the
   * tracker has no priority field for the item. Never fabricated.
   */
  priority?: WorkItemPriority;
  /**
   * Tracker-native estimate, or `undefined` (neutral) when unset. Drives
   * sub-issue promotion and the dispatch size tier.
   *
   * Both shapes real trackers emit are canonical, and the adapter passes its
   * tracker's native one through **unconverted**:
   *
   * - a **number** — points, from Linear's native `estimate` field and every
   *   other points-based tracker (any scale: Fibonacci, exponential, linear);
   * - a **string** — a t-shirt size (`xs` · `sm` · `md` · `lg` · `xl` · `xxl`)
   *   for trackers with no numeric estimate field.
   *
   * The dispatch policy maps both onto one shared ordinal scale, so the two
   * vocabularies rank against each other correctly.
   *
   * Never fabricated — "neutral" is not "smallest". A `0`-point estimate is a
   * real, smallest-concrete size; an item with no estimate leaves this
   * `undefined` (absent, never `null` and never `0`) and ranks neutral, behind
   * every concrete estimate.
   */
  size?: string | number;
  /** The project this item belongs to, or `undefined` when unset. */
  project?: WorkItemProject;
  /** Identifier of the parent item (sub-issue), or `null` for a top-level item. */
  parent: string | null;
  /** The typed dependency graph. */
  relations: WorkItemRelations;
  /** ALL labels on the item, including `stage/*` and `agent/*`. */
  labels: string[];
  /**
   * Account id of the assignee, or `undefined` when unassigned. Raw input to
   * {@link classifyOwnership | `classifyOwnership`}; the work model does not
   * itself classify.
   */
  assignee?: string;
  /** Agent state-machine disposition derived from the `agent/*` label group. */
  agentDisposition?: AgentDisposition;
  /**
   * ISO-8601 timestamp the item was created. Feeds the dispatch age tier
   * (oldest first). Optional so non-Linear adapters that omit it degrade to a
   * neutral age tier.
   */
  createdAt?: string;
}

/**
 * Reads an item's label set, degrading an absent or wrong-typed `labels`
 * value to "no labels" rather than throwing.
 *
 * The `Array.isArray` check is load-bearing twice over. It stops a missing
 * `labels` array from crashing every reader of this shape — the dispatch
 * eligibility filter, the charter G3 starvation detector, and the
 * comment-response rules (§5) all key off a durable label. And it rejects a
 * bare string: `'agent/ready'.includes(…)` is a SUBSTRING test, so a scalar
 * `labels: "agent/ready"` would otherwise sail through a readiness or
 * needs-input check on a shape the contract never allowed.
 *
 * The canonical accessor for {@link WorkItem.labels}: every module that reads
 * labels imports this (and {@link hasLabel}) rather than re-deriving the
 * guard, so a non-conformant `labels` value is fixed once, here, next to the
 * contract it defends.
 *
 * @param item - The item under evaluation.
 * @returns The item's labels, or `[]` when unavailable.
 */
export function labelsOf(item: WorkItem): readonly string[] {
  return Array.isArray(item.labels) ? item.labels : [];
}

/**
 * Whether an item carries a given durable label (e.g. `agent/ready`,
 * `agent/needs-input`), degrading gracefully via {@link labelsOf} rather than
 * throwing on a non-conformant `labels` value.
 *
 * @param item - The item under evaluation.
 * @param label - The exact label to test for (membership, never substring).
 * @returns `true` if `label` is present in the item's label set.
 */
export function hasLabel(item: WorkItem, label: string): boolean {
  return labelsOf(item).includes(label);
}

/**
 * A single tracker comment as the adapter's `getInbox` normalizes it (the
 * `InboxEntry.comment` shape). The generic layer reads only these fields; the
 * adapter owns the tracker-native mapping.
 *
 * This is an adapter output exactly like {@link WorkItem}, and lives beside it
 * for the same reason {@link hasLabel} lives beside {@link WorkItem.labels}:
 * every reader of a non-conformant `InboxComment` — the comment-response rules
 * (§5) AND {@link PollingTransport | the inbound transport} that produces the
 * events those rules consume — must degrade the same way, not re-derive its
 * own guard. `PollingTransport` is strictly upstream of `shouldRespondToComment`
 * (`transport.ts` maps `InboxEntry.comment` onto a `TrackerEvent` before the
 * comment-response rules ever see it), so a guard that only lives downstream
 * leaves the unhardened producer reachable first (DOR-535 follow-up).
 */
export interface InboxComment {
  /**
   * Account id of the comment author, compared against `identity.agent` (rule 1)
   * and used to detect non-agent replies (rule 3).
   */
  author: string;
  /**
   * Account ids @mentioned in the comment. An @mention of the agent account is a
   * "directly addressed" signal (rule 2).
   */
  mentions: string[];
  /**
   * The comment text. Carries the `identity.marker` on the agent's own comments
   * (rule 1, shared-account mode) and may carry an explicit `/flow` / `@flow`
   * token that directly addresses the engine (rule 2).
   */
  body: string;
}

/**
 * Reads a comment's @mention list, degrading an absent or wrong-typed
 * `mentions` value to "no mentions" rather than throwing. `mentions` is
 * required under the adapter's `getInbox` contract, but every reader —
 * {@link PollingTransport}'s bare-mention detection as much as the
 * comment-response rules — must survive a non-conformant one.
 *
 * @param comment - The inbound comment under evaluation.
 * @returns The comment's mentions, or `[]` when unavailable.
 */
export function mentionsOf(comment: InboxComment): readonly string[] {
  return Array.isArray(comment.mentions) ? comment.mentions : [];
}

/**
 * Reads a comment's body text, degrading an absent or wrong-typed `body`
 * value to the empty string rather than throwing. Same rationale as
 * {@link mentionsOf}.
 *
 * @param comment - The inbound comment under evaluation.
 * @returns The comment's body, or `''` when unavailable.
 */
export function bodyOf(comment: InboxComment): string {
  return typeof comment.body === 'string' ? comment.body : '';
}
