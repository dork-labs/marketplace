/**
 * The canonical typed **dispatch policy** (§4) — the `/flow` engine's answer to
 * "what should I work on next?". Two passes, both config-driven:
 *
 * 1. **Eligibility** ({@link filterEligible}) — filter OUT items that cannot be
 *    dispatched right now (wrong state, not ready, blocked, in a dead project,
 *    or not claimable per the ownership policy).
 * 2. **Ranking** ({@link rankEligible}) — order the survivors by the 7-tier
 *    ladder, with later tiers breaking ties left by earlier ones.
 * 3. **WIP cap** ({@link truncateRankedToWipCap}) — truncate the ranked list to the global
 *    and per-project concurrency budgets, walking it in RANK order.
 *
 * {@link selectDispatch} runs all three passes and returns the ordered, eligible,
 * cap-bounded survivors.
 *
 * ## Why the WIP cap comes LAST
 *
 * The cap answers "how many things may be in flight?"; the ladder answers "which
 * things?". Enforcing the cap during eligibility conflates the two: the first
 * item that happens to arrive fills the budget, so with the default
 * `perProject: 1` the ladder only ever sorts a single survivor and the pick
 * becomes a function of adapter query order rather than of priority, unblockers,
 * size, or age. Ranking first and truncating after keeps both properties: the
 * cap still bounds concurrency exactly as before, and the pick is now
 * input-order independent.
 *
 * ## This is the library core, not dead code
 *
 * The prose `/flow` stage skills describe the *same* rules in natural language
 * (the dispatched session ranks inline, §4 "Resolved direction"). This module is
 * the **pinned typed oracle** for those rules and the **P5 promotion surface** —
 * when the P5 server build replaces the skill-driven loop with a typed engine,
 * it calls this function directly. The skill prose and this code must stay in
 * lockstep; this is the single executable definition of the ladder.
 *
 * ## Ownership is consumed as INPUT (the task 3.1 integration point)
 *
 * The eligibility filter needs each item's {@link OwnershipClass}, but the
 * `classifyOwnership` primitive itself is built later (task 3.1, §7). This
 * module therefore accepts ownership as an **injected input**: callers pass a
 * `classifyOwnership` callback (or a precomputed `ownershipOf` map) via
 * {@link DispatchOptions}. Task 3.1 supplies the real callback; tests inject a
 * stub. This module never classifies ownership itself.
 *
 * ## Graceful degradation
 *
 * Missing {@link WorkItem.priority} / {@link WorkItem.size} / {@link
 * WorkItem.createdAt} are treated as **NEUTRAL** in their respective tiers —
 * never fabricated into a real value. A neutral value sorts *after* every
 * concrete value, so a real estimate always outranks a missing one.
 *
 * Degradation is **total**, not just `undefined`-shaped. A conformant adapter
 * omits what it lacks, but the oracle is the runtime and must not crash on a
 * non-conformant one: `null`, a wrong-typed value, an unrecognized vocabulary,
 * and (for `relations` and `labels`) a missing or wrong-shaped collection all
 * degrade rather than throwing. "Neutral" stays strictly distinguishable from
 * "smallest" — a real `0`-point estimate is the smallest concrete size, an
 * ABSENT estimate is neutral and sorts behind every concrete one.
 *
 * This is a **conformance criterion, not a per-field habit** (charter G3 + G12):
 * substituting `undefined`, `null`, or a wrong type into ANY `WorkItem` field
 * must leave {@link selectDispatch} and {@link classifyDispatchOutcome} both
 * non-throwing and correctly ranked. `engine-tests/dispatch.test.ts` asserts it
 * as one table-driven sweep whose field list is **derived at runtime** from the
 * test fixture rather than hand-written — so there is no second list to keep in
 * sync, and a newly required `WorkItem` field is swept without anyone
 * remembering to think of it.
 *
 * @see specs/unified-workflow-system/02-specification.md §4 (dispatch policy)
 * @see .agents/flow/skills/linear-adapter/SKILL.md (the WorkItem contract + degradation rules)
 * @module @dorkos/flow/dispatch
 */

import type { DispatchSchema, OwnershipSchema, WipCapSchema } from './config-schema.ts';
import type { z } from 'zod';
import { hasLabel } from './work-item.ts';
import type { OwnershipClass, WorkItem } from './work-item.ts';

/** Resolved {@link DispatchSchema} config — the ranking factors + size order. */
export type DispatchConfig = z.infer<typeof DispatchSchema>;
/** Resolved {@link OwnershipSchema} config — which classes may be claimed. */
export type OwnershipConfig = z.infer<typeof OwnershipSchema>;
/** Resolved {@link WipCapSchema} config — global + per-project WIP caps. */
export type WipCap = z.infer<typeof WipCapSchema>;

/** A single ranking factor (mirrors `DispatchRankSchema`). */
export type RankFactor = DispatchConfig['rank'][number];

/**
 * State categories an item may be dispatched FROM. An item that is already
 * `completed` or `canceled` is terminal; the engine never picks it up.
 */
const DISPATCHABLE_STATE_CATEGORIES = new Set(['backlog', 'unstarted', 'started']);

/** Project state categories that make every item under them un-dispatchable. */
const DEAD_PROJECT_STATE_CATEGORIES = new Set(['completed', 'canceled']);

/** The durable `agent/ready` label that gates dispatch in PM-driven mode. */
const AGENT_READY_LABEL = 'agent/ready';

/**
 * Ordinal scale for **t-shirt** estimates — the vocabulary trackers that have no
 * numeric estimate field use. Smaller ordinal = smaller work. An unrecognized
 * word is NEUTRAL (see {@link sizeOrdinal}).
 *
 * ## Every lookup table in this module is a `Map`, never a plain object
 *
 * Tracker data is the KEY here, and a plain `{}` answers a lookup for every
 * member it inherits from `Object.prototype`. `SIZE_SCALE['constructor']` would
 * return the `Object` function — a truthy non-number that the size tier then
 * compares against, so garbage outranks a real `xs`. This is the same defect as
 * `PRIORITY_RANK["1"]` reading a string priority as *urgent*: an object used as
 * a lookup table is not a lookup table. A `Map` only answers for keys actually
 * put in it, which retires the whole class rather than guarding one key at a
 * time.
 */
const SIZE_SCALE = new Map<string, number>([
  ['xs', 0],
  ['sm', 1],
  ['small', 1],
  ['md', 2],
  ['medium', 2],
  ['lg', 3],
  ['large', 3],
  ['xl', 4],
  ['xxl', 5],
]);

/**
 * Ascending `[points, ordinal]` breakpoints mapping a **numeric** estimate onto
 * the same ordinal scale as {@link SIZE_SCALE}, so the two vocabularies are
 * directly comparable in one tier.
 *
 * A numeric estimate takes the ordinal of the largest breakpoint at or below it.
 * That keeps estimate scales this table does not enumerate — Linear's
 * exponential (1·2·4·8·16), a linear 1–5 scale, a 21-point epic — monotonic
 * instead of silently degrading to neutral the moment a team picks a scale other
 * than Fibonacci.
 */
const NUMERIC_SIZE_BREAKPOINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 1],
  [3, 2],
  [5, 3],
  [8, 4],
  [13, 5],
];

/**
 * Priority ordinal: lower sorts first. Urgent (1) → high (2) → … → none (0/∞).
 * A `Map` for the reason given on {@link SIZE_SCALE}, and additionally because a
 * `Map` keyed by `number` does not answer for the STRING `"1"` — the coercion
 * that made a non-conformant string priority read as *urgent*.
 */
const PRIORITY_RANK = new Map<number, number>([
  [1, 0], // urgent
  [2, 1], // high
  [3, 2], // medium
  [4, 3], // low
  [0, 4], // none — explicitly last among concrete values
]);

/** A neutral rank: sorts AFTER every concrete value in a tier. */
const NEUTRAL = Number.POSITIVE_INFINITY;

/**
 * Maps a config {@link OwnershipClass} onto the {@link OwnershipConfig} flag that
 * declares whether the agent may claim it. `'mine'` is always claimable (the
 * agent's own work); the other three are policy-gated.
 *
 * The `default` case is a **compile-time** exhaustiveness guard, not runtime
 * noise: assigning `cls` to `never` makes adding a fifth {@link OwnershipClass}
 * a type error here rather than a silently unclaimable class. Its runtime half
 * matters too — without a `default` this function fell off the end and returned
 * `undefined` for any off-union value, which is falsy and so *accidentally*
 * fail-closed. Now it is deliberately `false`.
 *
 * @param cls - The item's ownership class.
 * @param ownership - The resolved ownership claim policy.
 * @returns `true` if the agent may claim an item of this class.
 */
export function isClaimable(cls: OwnershipClass, ownership: OwnershipConfig): boolean {
  switch (cls) {
    case 'mine':
      return ownership.claimAssignedToAgent;
    case 'unassigned':
      return ownership.claimUnassigned;
    case 'reviewer':
      return ownership.claimAssignedToHuman;
    case 'other':
      return ownership.claimAssignedToOthers;
    default: {
      const unhandled: never = cls;
      void unhandled;
      // Unknown class: never claim. Fail closed, deliberately.
      return false;
    }
  }
}

/**
 * The live in-progress load the WIP cap measures — the only inputs
 * {@link truncateRankedToWipCap} reads. Split out of {@link DispatchOptions} so
 * the cap's signature names exactly what it uses and cannot be read as needing
 * ownership resolution too.
 */
export interface WipLoad {
  /**
   * Count of items already in progress (claimed), keyed by project id, used for
   * the per-project WIP cap. Defaults to all-zero. The candidate items
   * themselves are NOT pre-counted — the cap measures existing load.
   */
  inProgressByProject?: Record<string, number>;
  /**
   * Total count of items already in progress across all projects, for the global
   * WIP cap. Defaults to `0`.
   */
  inProgressTotal?: number;
}

/**
 * Options for the dispatch passes. Supplies the runtime inputs the policy cannot
 * derive from a {@link WorkItem} alone: ownership classification (task 3.1) and
 * the live in-progress WIP counts ({@link WipLoad}).
 */
export interface DispatchOptions extends WipLoad {
  /**
   * Resolves an item's {@link OwnershipClass}. The task 3.1 integration point —
   * pass the real `classifyOwnership`; tests pass a stub. Either this or
   * {@link ownershipOf} must be provided.
   */
  classifyOwnership?: (item: WorkItem) => OwnershipClass;
  /**
   * Precomputed ownership by item `identifier`, used when ownership was resolved
   * upstream. Takes precedence over {@link classifyOwnership} for a given item.
   */
  ownershipOf?: Record<string, OwnershipClass>;
}

/**
 * Resolves an item's ownership class from {@link DispatchOptions}, preferring a
 * precomputed entry over the callback.
 *
 * `Object.hasOwn` rather than a bare lookup: `ownershipOf` is a caller-supplied
 * plain object keyed by tracker data, so an item identified `constructor`
 * matched an INHERITED `Object.prototype` member. That is `!== undefined`, so
 * the precomputed branch won, `classifyOwnership` never ran, and a function was
 * returned as an `OwnershipClass` — leaving {@link isClaimable} to drop the item
 * silently. Only an OWN key is a real precomputed entry. The public shape stays
 * a `Record` so callers are unaffected; see {@link SIZE_SCALE} for why the
 * module's own tables are `Map`s instead.
 *
 * @throws If neither `ownershipOf[id]` nor `classifyOwnership` is available.
 */
function resolveOwnership(item: WorkItem, opts: DispatchOptions): OwnershipClass {
  const precomputed =
    opts.ownershipOf && Object.hasOwn(opts.ownershipOf, item.identifier)
      ? opts.ownershipOf[item.identifier]
      : undefined;
  if (precomputed !== undefined) return precomputed;
  if (opts.classifyOwnership) return opts.classifyOwnership(item);
  throw new Error(
    `dispatch: no ownership for "${item.identifier}" — provide classifyOwnership or ownershipOf`
  );
}

/**
 * Whether an item's `blockedBy` set contains any item that is still open
 * (present in the candidate set with a non-terminal state). A blocker that is
 * `completed`/`canceled` (or absent from the set) does not block.
 *
 * @param item - The item under evaluation.
 * @param openIdentifiers - Identifiers of all open candidate items.
 */
function hasOpenBlocker(item: WorkItem, openIdentifiers: Set<string>): boolean {
  return relationIds(item, 'blockedBy').some((id) => openIdentifiers.has(id));
}

/**
 * Reads one edge list off an item's relation graph, degrading an absent or
 * wrong-typed `relations` object to "no edges" rather than throwing.
 *
 * The two graph-derived behaviors then degrade **differently**, and the words
 * are not interchangeable:
 *
 * - the tier-1 unblocker score falls to `0` — genuinely **neutral**, the item
 *   neither gains nor loses rank;
 * - the `blockedBy` eligibility check **fails open** — the item is treated as
 *   unblocked and stays dispatchable.
 *
 * Fail-open is the deliberate choice (and what {@link
 * ../skills/building-adapters/SKILL.md | `building-adapters`} documents): a
 * non-conformant adapter must not silently starve the whole queue. Either way it
 * does not take the dispatch pass down with it.
 *
 * @param item - The item under evaluation.
 * @param edge - Which edge list to read.
 * @returns The identifiers on that edge, or `[]` when unavailable.
 */
function relationIds(item: WorkItem, edge: 'blocks' | 'blockedBy'): readonly string[] {
  const ids = item.relations?.[edge];
  return Array.isArray(ids) ? ids : [];
}

/**
 * Whether an item carries the durable `agent/ready` dispatch gate label.
 * Delegates to the shared {@link hasLabel} accessor (`work-item.ts`), which
 * degrades an absent or wrong-typed `labels` value to "no labels" rather than
 * throwing — the eligibility filter and {@link classifyDispatchOutcome} (the
 * charter G3 starvation detector) must both survive a non-conformant adapter.
 */
function isAgentReady(item: WorkItem): boolean {
  return hasLabel(item, AGENT_READY_LABEL);
}

/**
 * **Pass 1 — Eligibility.** Filters OUT every item that cannot be dispatched
 * right now (§4). An item survives only if ALL hold: its `stateCategory` is
 * dispatchable; it carries the `agent/ready` label (PM-driven mode); it is not
 * `blockedBy` any open item; its `project.stateCategory` is not
 * completed/canceled; and its ownership class is claimable per the `ownership`
 * policy.
 *
 * Eligibility is a **per-item predicate** — every check here is a property of
 * the item alone, so the result is independent of input order and of how many
 * other items are in the set. The WIP cap is deliberately NOT here: it is a
 * property of the QUEUE, and enforcing it during this pass would let arrival
 * order decide the pick. It runs after ranking, in {@link truncateRankedToWipCap}.
 *
 * @param items - The candidate work items.
 * @param ownership - The resolved ownership claim policy.
 * @param opts - Ownership resolution inputs.
 * @returns The eligible survivors, in input order.
 */
export function filterEligible(
  items: readonly WorkItem[],
  ownership: OwnershipConfig,
  opts: DispatchOptions
): WorkItem[] {
  const openIdentifiers = buildOpenSet(items);

  return items.filter((item) => {
    if (!DISPATCHABLE_STATE_CATEGORIES.has(item.stateCategory)) return false;
    if (!isAgentReady(item)) return false;
    if (hasOpenBlocker(item, openIdentifiers)) return false;
    if (
      item.project?.stateCategory &&
      DEAD_PROJECT_STATE_CATEGORIES.has(item.project.stateCategory)
    )
      return false;
    return isClaimable(resolveOwnership(item, opts), ownership);
  });
}

/**
 * **Pass 3 — WIP cap.** Truncates an already-RANKED list to the global and
 * per-project concurrency budgets, seeded from the live in-progress load.
 *
 * Walks the list in rank order and admits each item while both budgets allow it.
 * A project that is already at its cap is skipped without ending the walk, so a
 * lower-ranked item in a *different* project can still be admitted under the
 * global budget; hitting the global cap ends the walk entirely, since nothing
 * after it could be admitted.
 *
 * Because the input is ranked, "which items get cut" is decided by the ladder —
 * the cap only decides *how many* survive.
 *
 * **The "already ranked" precondition is in the name on purpose.** This function
 * is exported from the package barrel, and truncating an UNRANKED list is
 * exactly the defect this module was rewritten to remove (DOR-515): the cap
 * would silently answer "which?" in arrival order. A `@param` note is too easy
 * to skip past for an invariant that regresses the whole policy, so the call
 * reads `truncateRankedToWipCap(rankEligible(…), …)` and a caller who has not
 * ranked can see it.
 *
 * @param ranked - The eligible survivors in ladder order ({@link rankEligible}).
 * @param wipCap - The resolved global + per-project WIP caps.
 * @param load - Live in-progress counts (the existing load the cap measures).
 * @returns The highest-ranked items that fit inside the caps, in rank order.
 */
export function truncateRankedToWipCap(
  ranked: readonly WorkItem[],
  wipCap: WipCap,
  load: WipLoad
): WorkItem[] {
  // Running WIP budget seeded from existing in-progress load. A Map, not a
  // plain object: `projectId` is tracker data, and an object keyed by it
  // answers every lookup inherited from Object.prototype. A project id of
  // `"constructor"` made `perProjectCount[projectId]` a function, `>=
  // wipCap.perProject` false against it, and EVERY item admitted — the cap
  // silently defeated (charter G7). See {@link SIZE_SCALE}.
  let globalCount = load.inProgressTotal ?? 0;
  const perProjectCount = new Map<string, number>(Object.entries(load.inProgressByProject ?? {}));

  const admitted: WorkItem[] = [];
  for (const item of ranked) {
    if (globalCount >= wipCap.global) break;

    const projectId = item.project?.id;
    const projectCount = projectId ? (perProjectCount.get(projectId) ?? 0) : 0;
    if (projectId && projectCount >= wipCap.perProject) continue;

    admitted.push(item);
    globalCount += 1;
    if (projectId) perProjectCount.set(projectId, projectCount + 1);
  }

  return admitted;
}

/**
 * A pre-resolved set of open candidate identifiers, shared by the `blockedBy`
 * eligibility check ({@link hasOpenBlocker}) and the tier-1 unblockers score
 * ({@link unblockerScore}).
 *
 * Both readers MUST be built from the same pool — the **full candidate set**
 * `filterEligible` receives, never a filtered subset — or "open" silently
 * means two different things depending which pass asks (DOR-531). An item
 * that is `backlog`/`unstarted`/`started` but still lacks `agent/ready` is
 * "open" here: this set is a STATE-CATEGORY filter only, deliberately blind to
 * the readiness label, so an untriaged item still counts as something a
 * `blocks` edge can point at.
 */
function buildOpenSet(items: readonly WorkItem[]): Set<string> {
  return new Set(
    items
      .filter((it) => DISPATCHABLE_STATE_CATEGORIES.has(it.stateCategory))
      .map((it) => it.identifier)
  );
}

/**
 * Tier 1 — how many OPEN items this item blocks (more = ranks first).
 *
 * "Open" here is the same full-candidate-set definition {@link
 * hasOpenBlocker} uses for the `blockedBy` eligibility check (DOR-531): an
 * item that unblocks work still stuck behind triage — `backlog`/`unstarted`/
 * `started` but not yet `agent/ready` — scores for it. That is deliberate: the
 * whole point of the unblocker tier is to surface work whose completion
 * releases OTHER work, and untriaged work is precisely the work most likely to
 * stay stuck without a nudge. Scoping the score to already-ready items would
 * make the tier highest for items whose dependents were going to get picked up
 * anyway, which defeats its purpose.
 */
function unblockerScore(item: WorkItem, openIdentifiers: Set<string>): number {
  return relationIds(item, 'blocks').filter((id) => openIdentifiers.has(id)).length;
}

/**
 * Tier 2 — priority ordinal; a missing, `null`, or off-scale priority is NEUTRAL
 * (sorts last). The `typeof` guard is what makes that promise true rather than
 * accidental: without it, degradation would rest on a lookup happening to miss,
 * and it did NOT miss for a string — a plain-object `PRIORITY_RANK["1"]` read a
 * string priority as *urgent*. The guard and the {@link SIZE_SCALE | `Map`} now
 * close that from both sides.
 */
function priorityRank(item: WorkItem): number {
  if (typeof item.priority !== 'number') return NEUTRAL;
  return PRIORITY_RANK.get(item.priority) ?? NEUTRAL;
}

/** Tier 3 — `started` projects (in progress) before `unstarted`/`backlog`. */
function projectStatusRank(item: WorkItem): number {
  return item.project?.stateCategory === 'started' ? 0 : 1;
}

/**
 * Maps a numeric estimate onto the shared ordinal scale via
 * {@link NUMERIC_SIZE_BREAKPOINTS}. Non-finite or negative points are not an
 * estimate at all → `undefined` (neutral).
 *
 * @param points - The numeric estimate.
 * @returns The shared ordinal, or `undefined` when the value is not an estimate.
 */
function numericSizeOrdinal(points: number): number | undefined {
  if (!Number.isFinite(points) || points < 0) return undefined;
  // points >= 0 always matches the leading [0, 0] breakpoint.
  let ordinal = 0;
  for (const [breakpoint, value] of NUMERIC_SIZE_BREAKPOINTS) {
    if (points < breakpoint) break;
    ordinal = value;
  }
  return ordinal;
}

/**
 * Resolves an estimate to the shared ordinal scale, accepting BOTH shapes the
 * adapter contract allows: a numeric estimate (Linear's native `estimate` field
 * and every other points-based tracker) and a t-shirt string (trackers with no
 * numeric field). Anything else — absent, `null`, a wrong type, an unrecognized
 * word, an empty string — is `undefined`, i.e. NEUTRAL.
 *
 * A real `0`-point estimate returns ordinal `0` (the smallest concrete size) and
 * is therefore never confused with a missing one.
 *
 * **Exported because it is the only sanctioned way to compare a `size` against a
 * t-shirt threshold.** Since `size` became the union `number | string`, any rule
 * phrased as `size ≥ decomposition.subIssueThreshold` — a t-shirt word — is a
 * comparison between two different vocabularies. Compare ordinals instead:
 * `sizeOrdinal(item.size) >= sizeOrdinal(threshold)`. Without this export every
 * generated adapter and every prose rule has to invent its own numeric→t-shirt
 * conversion, which is exactly the class of contradiction DOR-515 was.
 *
 * **Monotonic, not injective.** The numeric breakpoints are coarser than the
 * point scales they accept, so distinct estimates can share an ordinal: on a
 * linear 1–5 scale `3` and `4` both map to `2`, and every value `≥ 13` maps to
 * `5`. Order is always preserved (a larger estimate never gets a smaller
 * ordinal), but two different estimates may tie in the size tier and fall
 * through to a later one.
 *
 * @param size - The raw estimate (a {@link WorkItem.size} or a t-shirt threshold).
 * @returns The shared ordinal, or `undefined` for neutral.
 */
export function sizeOrdinal(size: WorkItem['size']): number | undefined {
  if (typeof size === 'number') return numericSizeOrdinal(size);
  if (typeof size !== 'string') return undefined; // undefined, null, or wrong-typed
  const token = size.trim().toLowerCase();
  if (token === '') return undefined;
  // A numeric estimate that arrived as a string ("8", "21") is still numeric.
  const asNumber = Number(token);
  if (!Number.isNaN(asNumber)) return numericSizeOrdinal(asNumber);
  return SIZE_SCALE.get(token);
}

/** Tier 5 — size ordinal honoring `sizeOrder`; missing/unknown size is NEUTRAL. */
function sizeRank(item: WorkItem, sizeOrder: DispatchConfig['sizeOrder']): number {
  const ordinal = sizeOrdinal(item.size);
  if (ordinal === undefined) return NEUTRAL;
  // large-first inverts the ascending scale; NEUTRAL stays last either way.
  return sizeOrder === 'large-first' ? -ordinal : ordinal;
}

/**
 * Tier 6 — creation time ordinal (oldest first); a missing, `null`, or
 * non-ISO-8601 time is NEUTRAL.
 *
 * The `typeof` guard is load-bearing, not defensive noise: `Date.parse` coerces
 * its argument to a string first, so a numeric epoch (`1234`) would parse as the
 * YEAR 1234 and silently rank as the oldest item in the queue. The contract
 * promises an ISO-8601 string; anything else is neutral, never guessed at.
 */
function ageRank(item: WorkItem): number {
  if (typeof item.createdAt !== 'string') return NEUTRAL;
  const ms = Date.parse(item.createdAt);
  return Number.isNaN(ms) ? NEUTRAL : ms;
}

/**
 * Resolves the per-type weight for tier 4 from the `dispatch.rank` config. v1
 * config carries no per-type weighting (the `type` factor is a placeholder in
 * the ladder), so every type weighs equally (`0`) and the tier is a no-op tie.
 * Kept as a seam: when per-type weights land in config, only this returns change.
 */
function typeRank(_item: WorkItem): number {
  return 0;
}

/**
 * Subtracts two tier ordinals **NaN-safely**, which a bare `a - b` is not.
 *
 * {@link NEUTRAL} is `Infinity`, and `Infinity - Infinity` is `NaN`. A `NaN`
 * delta is not `0`, so {@link rankEligible}'s `if (delta !== 0) return delta`
 * would return it — aborting the ladder before every later tier AND before the
 * tier-7 identifier tiebreak, and leaving V8 to treat the pair as "equal", i.e.
 * in input order. Two items that are both neutral in the SAME tier is not an
 * edge case: `size: undefined` is the default state of an untriaged queue.
 *
 * Equal ordinals — including two NEUTRALs — are a genuine tie, so the ladder
 * must fall through to the next tier.
 *
 * @param a - `a`'s ordinal in this tier.
 * @param b - `b`'s ordinal in this tier.
 * @returns Negative if `a` ranks first, positive if `b` does, `0` when tied.
 */
function compareOrdinals(a: number, b: number): number {
  return a === b ? 0 : a - b;
}

/**
 * Comparator for two items under one ranking factor. Returns a negative number
 * if `a` should rank before `b`, positive if after, `0` if tied (deferred to a
 * later tier).
 */
function compareByFactor(
  factor: RankFactor,
  a: WorkItem,
  b: WorkItem,
  openIdentifiers: Set<string>,
  config: DispatchConfig
): number {
  switch (factor) {
    case 'unblockers':
      // More blocked-open-items first → descending score.
      return compareOrdinals(
        unblockerScore(b, openIdentifiers),
        unblockerScore(a, openIdentifiers)
      );
    case 'priority':
      return compareOrdinals(priorityRank(a), priorityRank(b));
    case 'projectStatus':
      return compareOrdinals(projectStatusRank(a), projectStatusRank(b));
    case 'type':
      return compareOrdinals(typeRank(a), typeRank(b));
    case 'size':
      return compareOrdinals(sizeRank(a, config.sizeOrder), sizeRank(b, config.sizeOrder));
    case 'age':
      return compareOrdinals(ageRank(a), ageRank(b));
  }
}

/**
 * **Pass 2 — Ranking.** Orders eligible survivors by the configured tier ladder
 * (`config.rank`), with later tiers breaking ties left by earlier ones (§4). A
 * final deterministic `identifier` tiebreak (tier 7) guarantees a total,
 * stable order regardless of input order.
 *
 * Ranking is non-destructive: it copies before sorting and never mutates the
 * input. Tier weights live entirely in {@link DispatchConfig} — re-prioritizing
 * is a config edit, never a code change.
 *
 * **`candidatePool` and DOR-531.** The tier-1 unblockers score
 * ({@link unblockerScore}) needs the full "open" universe — every dispatchable
 * item, ready or not — to agree with {@link filterEligible}'s `blockedBy`
 * check on what "open" means. Left to default to `items` alone, a caller that
 * ranks only the (already-filtered) eligible survivors silently shrinks
 * "open" to "ready", and an item that unblocks three untriaged issues scores
 * `0` instead of `3`. {@link selectDispatch} passes the pre-filter candidate
 * set explicitly so the two passes can never drift apart again; a caller that
 * ranks standalone (as most of this module's own tests do) gets the same
 * items back by default, which is correct when nothing was filtered out.
 *
 * @param items - The eligible survivors (output of {@link filterEligible}).
 * @param config - The resolved dispatch config (`rank` order + `sizeOrder`).
 * @param candidatePool - The full candidate set "open" is resolved against for
 *   the tier-1 unblockers score — the SAME set {@link filterEligible} used for
 *   its `blockedBy` check. Defaults to `items` for a standalone caller that has
 *   not filtered (rank-only usage, e.g. this module's own test suite).
 * @returns A new array ordered by the ladder.
 */
export function rankEligible(
  items: readonly WorkItem[],
  config: DispatchConfig,
  candidatePool: readonly WorkItem[] = items
): WorkItem[] {
  const openIdentifiers = buildOpenSet(candidatePool);
  return [...items].sort((a, b) => {
    for (const factor of config.rank) {
      const delta = compareByFactor(factor, a, b, openIdentifiers, config);
      if (delta !== 0) return delta;
    }
    // Tier 7 — deterministic final tiebreak on the human identifier.
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}

/**
 * Run the full dispatch policy: {@link filterEligible} → {@link rankEligible} →
 * {@link truncateRankedToWipCap}. Returns the eligible survivors ordered by the 7-tier
 * ladder and truncated to the concurrency budget — the engine's pick list
 * (head = "work on this next").
 *
 * The cap runs LAST so the ladder decides *which* items survive it; see the
 * module header for why enforcing it earlier made the pick a function of adapter
 * query order.
 *
 * @param items - The candidate work items (from the adapter's `getEligibleWork`).
 * @param config - The resolved `dispatch`, `ownership`, and `wipCap` config.
 * @param opts - Ownership resolution (the task 3.1 seam) + live WIP counts.
 * @returns The ordered, eligible, cap-bounded survivors.
 */
export function selectDispatch(
  items: readonly WorkItem[],
  config: {
    dispatch: DispatchConfig;
    ownership: OwnershipConfig;
    wipCap: WipCap;
  },
  opts: DispatchOptions
): WorkItem[] {
  const eligible = filterEligible(items, config.ownership, opts);
  // Rank against the FULL candidate pool, not just the eligible survivors —
  // see rankEligible's `candidatePool` doc and DOR-531.
  const ranked = rankEligible(eligible, config.dispatch, items);
  return truncateRankedToWipCap(ranked, config.wipCap, opts);
}

/**
 * The result of {@link classifyDispatchOutcome} — the dispatch pick plus the two
 * signals the loop needs to tell **"genuinely done"** from **"starved behind the
 * readiness gate"** (the charter G3 "never starve silently" contract).
 */
export interface DispatchOutcome {
  /** The ranked, eligible survivors (the output of {@link selectDispatch}). */
  picked: WorkItem[];
  /** `picked.length` — how many items are dispatchable right now. */
  eligibleCount: number;
  /**
   * `true` when nothing is eligible **but** shapeable work sits behind the
   * `agent/ready` gate: the queue is starved, not done. Defined as
   * `eligibleCount === 0 && shapeableCount > 0`. A triage / decompose pass could
   * ready that work, so the loop surfaces it rather than stopping silently.
   */
  starved: boolean;
  /**
   * Count of dispatchable-category items (`backlog` / `unstarted` / `started`, in
   * a non-dead project) that LACK the `agent/ready` label: the lever a triage
   * pass pulls. This is a readiness / category fact (ownership is not consulted),
   * and it deliberately does NOT count blocked or WIP-capped ready items: those
   * are a different fix than readying more work.
   */
  shapeableCount: number;
}

/**
 * Classify the dispatch outcome: run the full policy AND report whether an empty
 * pick means **done** or **starved**. This is the charter G3 contract: the loop
 * must never set `ready: 0` and stop silently while shapeable work waits behind
 * the `agent/ready` gate.
 *
 * `shapeableCount` counts dispatchable-category items (in a non-dead project) that
 * are missing the `agent/ready` label: the readiness lever a triage / decompose
 * pass pulls. It reuses the same module constants as {@link filterEligible}
 * ({@link DISPATCHABLE_STATE_CATEGORIES}, {@link DEAD_PROJECT_STATE_CATEGORIES},
 * {@link AGENT_READY_LABEL}) so "shapeable" stays the exact inverse of the
 * readiness gate dispatch enforces.
 *
 * @param items - The candidate work items (from the adapter's `getEligibleWork`).
 * @param config - The resolved `dispatch`, `ownership`, and `wipCap` config.
 * @param opts - Ownership resolution (the task 3.1 seam) + live WIP counts.
 * @returns The pick list plus the starvation signals.
 */
export function classifyDispatchOutcome(
  items: readonly WorkItem[],
  config: {
    dispatch: DispatchConfig;
    ownership: OwnershipConfig;
    wipCap: WipCap;
  },
  opts: DispatchOptions
): DispatchOutcome {
  const picked = selectDispatch(items, config, opts);
  const eligibleCount = picked.length;
  const shapeableCount = items.filter(
    (item) =>
      DISPATCHABLE_STATE_CATEGORIES.has(item.stateCategory) &&
      !(
        item.project?.stateCategory && DEAD_PROJECT_STATE_CATEGORIES.has(item.project.stateCategory)
      ) &&
      !isAgentReady(item)
  ).length;

  return {
    picked,
    eligibleCount,
    starved: eligibleCount === 0 && shapeableCount > 0,
    shapeableCount,
  };
}
