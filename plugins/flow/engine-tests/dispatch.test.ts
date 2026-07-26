/**
 * Unit suite for the dispatch policy (§4) — eligibility filter + 7-tier ranking
 * ladder. Imports from the relative module paths (NOT the `@dorkos/flow`
 * barrel), since the orchestrator wires barrel exports later.
 *
 * @see specs/unified-workflow-system/02-specification.md §4
 */

import { describe, expect, it, vi } from 'vitest';
import { DispatchSchema, OwnershipSchema, WipCapSchema } from '../scripts/config-schema.ts';
import {
  classifyDispatchOutcome,
  filterEligible,
  isClaimable,
  rankEligible,
  selectDispatch,
  sizeOrdinal,
  truncateRankedToWipCap,
  type DispatchOptions,
} from '../scripts/dispatch-policy.ts';
import type { OwnershipClass, WorkItem, WorkItemPriority } from '../scripts/work-item.ts';

const DISPATCH = DispatchSchema.parse({});
const OWNERSHIP = OwnershipSchema.parse({});
const WIP = WipCapSchema.parse({}); // { global: 2, perProject: 1 }
/** A wide cap, for tests that isolate non-WIP behavior from cap interference. */
const WIDE_WIP = WipCapSchema.parse({ global: 100, perProject: 100 });

/** Build a fully-formed, eligible WorkItem with overridable fields. */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['agent/ready'],
    assignee: 'agent-account',
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Ownership resolver: everything is `mine` unless overridden by the map. */
function ownershipOpts(map: Record<string, OwnershipClass> = {}): DispatchOptions {
  return {
    classifyOwnership: () => 'mine',
    ownershipOf: map,
  };
}

/** Convenience: identifiers of the dispatch result, in order. */
function ids(items: WorkItem[]): string[] {
  return items.map((i) => i.identifier);
}

describe('isClaimable', () => {
  it('maps ownership classes onto the default claim policy', () => {
    // defaults: claimAssignedToAgent + claimUnassigned true; human/others false
    expect(isClaimable('mine', OWNERSHIP)).toBe(true);
    expect(isClaimable('unassigned', OWNERSHIP)).toBe(true);
    expect(isClaimable('reviewer', OWNERSHIP)).toBe(false);
    expect(isClaimable('other', OWNERSHIP)).toBe(false);
  });

  it('honors a policy that opens up human + other claims', () => {
    const open = OwnershipSchema.parse({
      claimAssignedToHuman: true,
      claimAssignedToOthers: true,
    });
    expect(isClaimable('reviewer', open)).toBe(true);
    expect(isClaimable('other', open)).toBe(true);
  });
});

describe('filterEligible', () => {
  it('keeps a fully-eligible item', () => {
    const items = [makeItem({ identifier: 'DOR-1' })];
    const survivors = filterEligible(items, OWNERSHIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-1']);
  });

  it('filters items in a non-dispatchable state (completed/canceled)', () => {
    const items = [
      makeItem({ identifier: 'DOR-1', stateCategory: 'completed' }),
      makeItem({ identifier: 'DOR-2', stateCategory: 'canceled' }),
      makeItem({ identifier: 'DOR-3', stateCategory: 'started' }),
    ];
    const survivors = filterEligible(items, OWNERSHIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-3']);
  });

  it('filters items lacking the agent/ready label (PM-driven mode)', () => {
    const items = [
      makeItem({ identifier: 'DOR-1', labels: [] }),
      makeItem({ identifier: 'DOR-2', labels: ['stage/triage'] }),
      makeItem({ identifier: 'DOR-3' }), // has agent/ready
    ];
    const survivors = filterEligible(items, OWNERSHIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-3']);
  });

  it('filters items blockedBy an OPEN item but keeps those blocked only by closed items', () => {
    const items = [
      // blocked by an open item → filtered
      makeItem({
        identifier: 'DOR-1',
        relations: {
          blocks: [],
          blockedBy: ['DOR-2'],
          children: [],
          relatedTo: [],
        },
      }),
      // the open blocker
      makeItem({ identifier: 'DOR-2', stateCategory: 'started' }),
      // blocked only by a completed item (not in open set) → eligible
      makeItem({
        identifier: 'DOR-3',
        relations: {
          blocks: [],
          blockedBy: ['DOR-DONE'],
          children: [],
          relatedTo: [],
        },
      }),
      // the closed blocker
      makeItem({ identifier: 'DOR-DONE', stateCategory: 'completed' }),
    ];
    const survivors = filterEligible(items, OWNERSHIP, ownershipOpts());
    expect(ids(survivors).sort()).toEqual(['DOR-2', 'DOR-3']);
  });

  it('filters items whose project is completed/canceled', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_done', name: 'Done', stateCategory: 'completed' },
      }),
      makeItem({
        identifier: 'DOR-2',
        project: { id: 'proj_x', name: 'X', stateCategory: 'canceled' },
      }),
      makeItem({ identifier: 'DOR-3' }), // started project
    ];
    const survivors = filterEligible(items, OWNERSHIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-3']);
  });

  it('filters other-owned and reviewer-owned items per the claim policy', () => {
    const items = [
      makeItem({ identifier: 'DOR-1' }), // mine
      makeItem({ identifier: 'DOR-2' }), // other
      makeItem({ identifier: 'DOR-3' }), // reviewer
      makeItem({ identifier: 'DOR-4' }), // unassigned
    ];
    const survivors = filterEligible(
      items,
      OWNERSHIP,
      ownershipOpts({
        'DOR-1': 'mine',
        'DOR-2': 'other',
        'DOR-3': 'reviewer',
        'DOR-4': 'unassigned',
      })
    );
    // defaults claim mine + unassigned only
    expect(ids(survivors).sort()).toEqual(['DOR-1', 'DOR-4']);
  });

  it('does NOT apply the WIP cap — eligibility is a per-item predicate', () => {
    // Three items in ONE project with perProject: 1. Eligibility keeps all
    // three; bounding concurrency is truncateRankedToWipCap's job, after ranking.
    const items = ['DOR-1', 'DOR-2', 'DOR-3'].map((identifier) =>
      makeItem({
        identifier,
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      })
    );
    const survivors = filterEligible(items, OWNERSHIP, ownershipOpts());
    expect(ids(survivors)).toEqual(['DOR-1', 'DOR-2', 'DOR-3']);
  });

  it('throws when no ownership source is provided', () => {
    const items = [makeItem({ identifier: 'DOR-1' })];
    expect(() => filterEligible(items, OWNERSHIP, {})).toThrow(/ownership/);
  });
});

describe('truncateRankedToWipCap — bounds concurrency over an already-ranked list', () => {
  it('enforces the per-project WIP cap (perProject: 1)', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-2',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-3',
        project: { id: 'proj_b', name: 'B', stateCategory: 'started' },
      }),
    ];
    // proj_a capped at 1 (DOR-1 admitted, DOR-2 skipped); proj_b admits DOR-3.
    // global cap is 2 → both admitted survivors fit.
    expect(ids(truncateRankedToWipCap(items, WIP, {}))).toEqual(['DOR-1', 'DOR-3']);
  });

  it('enforces the global WIP cap (global: 2) across projects', () => {
    const items = ['p1', 'p2', 'p3'].map((p, i) =>
      makeItem({
        identifier: `DOR-${i + 1}`,
        project: { id: p, name: p, stateCategory: 'started' },
      })
    );
    expect(ids(truncateRankedToWipCap(items, WIP, {}))).toEqual(['DOR-1', 'DOR-2']); // 3rd hits global cap
  });

  it('counts existing in-progress load against the caps', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
    ];
    // proj_a already has 1 in progress → at its perProject cap → dropped.
    expect(
      truncateRankedToWipCap(items, WIP, {
        inProgressByProject: { proj_a: 1 },
        inProgressTotal: 1,
      })
    ).toEqual([]);
  });

  it('admits a lower-ranked item from another project when one project is capped', () => {
    const items = [
      makeItem({
        identifier: 'DOR-1',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-2',
        project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-3',
        project: { id: 'proj_b', name: 'B', stateCategory: 'started' },
      }),
    ];
    // A full project SKIPS its item; it does not end the walk.
    expect(ids(truncateRankedToWipCap(items, WIP, {}))).toEqual(['DOR-1', 'DOR-3']);
  });

  it('preserves rank order — it truncates, it never reorders', () => {
    const items = ['DOR-C', 'DOR-A', 'DOR-B'].map((identifier) =>
      makeItem({
        identifier,
        project: { id: identifier, name: identifier, stateCategory: 'started' },
      })
    );
    // Input is the ranked order; the cap keeps the first two AS GIVEN.
    expect(ids(truncateRankedToWipCap(items, WIP, {}))).toEqual(['DOR-C', 'DOR-A']);
  });
});

describe('rankEligible — 7-tier ladder', () => {
  it('tier 1: unblockers (items that block others) rank first', () => {
    const items = [
      makeItem({ identifier: 'DOR-A', priority: 3 }),
      makeItem({
        identifier: 'DOR-B',
        priority: 3,
        relations: {
          blocks: ['DOR-A'],
          blockedBy: [],
          children: [],
          relatedTo: [],
        },
      }),
    ];
    // Same priority; DOR-B blocks an open item so it leads despite identifier order.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-B', 'DOR-A']);
  });

  it('tier 2: priority orders urgent → high → medium → low → none', () => {
    const items = [
      makeItem({ identifier: 'DOR-NONE', priority: 0 }),
      makeItem({ identifier: 'DOR-LOW', priority: 4 }),
      makeItem({ identifier: 'DOR-URGENT', priority: 1 }),
      makeItem({ identifier: 'DOR-MED', priority: 3 }),
      makeItem({ identifier: 'DOR-HIGH', priority: 2 }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual([
      'DOR-URGENT',
      'DOR-HIGH',
      'DOR-MED',
      'DOR-LOW',
      'DOR-NONE',
    ]);
  });

  it('tier 3: items in started (in-progress) projects rank before planned ones', () => {
    const items = [
      makeItem({
        identifier: 'DOR-PLANNED',
        project: { id: 'p_plan', name: 'Planned', stateCategory: 'unstarted' },
      }),
      makeItem({
        identifier: 'DOR-PROG',
        project: {
          id: 'p_prog',
          name: 'In Progress',
          stateCategory: 'started',
        },
      }),
    ];
    // Equal on tiers 1–2; tier 3 promotes the started-project item.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-PROG', 'DOR-PLANNED']);
  });

  it('tier 5: size — small-first orders smaller estimates ahead', () => {
    const items = [
      makeItem({ identifier: 'DOR-LG', size: 'lg' }),
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-SM', 'DOR-LG', 'DOR-XL']);
  });

  it('tier 5: size — large-first inverts the order', () => {
    const largeFirst = DispatchSchema.parse({ sizeOrder: 'large-first' });
    const items = [
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
      makeItem({ identifier: 'DOR-LG', size: 'lg' }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    expect(ids(rankEligible(items, largeFirst))).toEqual(['DOR-XL', 'DOR-LG', 'DOR-SM']);
  });

  it('tier 5: Fibonacci point estimates rank alongside t-shirt sizes', () => {
    const items = [
      makeItem({ identifier: 'DOR-8', size: '8' }),
      makeItem({ identifier: 'DOR-1', size: '1' }),
      makeItem({ identifier: 'DOR-3', size: '3' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-1', 'DOR-3', 'DOR-8']);
  });

  it('tier 6: age — oldest created first', () => {
    const items = [
      makeItem({
        identifier: 'DOR-NEW',
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
      makeItem({
        identifier: 'DOR-OLD',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      makeItem({
        identifier: 'DOR-MID',
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-OLD', 'DOR-MID', 'DOR-NEW']);
  });

  it('tier 7: identifier breaks an otherwise-total tie deterministically', () => {
    const items = [
      makeItem({ identifier: 'DOR-30' }),
      makeItem({ identifier: 'DOR-10' }),
      makeItem({ identifier: 'DOR-20' }),
    ];
    // All fields identical → only the identifier tiebreak distinguishes them.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-10', 'DOR-20', 'DOR-30']);
  });

  it('later tiers break ties left by earlier ones (priority then size)', () => {
    const items = [
      makeItem({ identifier: 'DOR-A', priority: 2, size: 'lg' }),
      makeItem({ identifier: 'DOR-B', priority: 2, size: 'sm' }),
      makeItem({ identifier: 'DOR-C', priority: 1, size: 'xl' }),
    ];
    // C wins on priority; A vs B tie on priority → size (small-first) puts B first.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-C', 'DOR-B', 'DOR-A']);
  });
});

describe('rankEligible — graceful degradation (missing fields are neutral)', () => {
  it('treats missing priority as neutral (sorts after every concrete priority)', () => {
    const items = [
      makeItem({ identifier: 'DOR-NEUTRAL', priority: undefined }),
      makeItem({ identifier: 'DOR-LOW', priority: 4 }),
    ];
    // A real "low" still outranks a missing priority.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-LOW', 'DOR-NEUTRAL']);
  });

  it('treats missing size as neutral, not as smallest', () => {
    const items = [
      makeItem({ identifier: 'DOR-NEUTRAL', size: undefined }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    // Even the largest concrete size beats a missing one (neutral sorts last).
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-XL', 'DOR-NEUTRAL']);
  });

  it('treats an unrecognized size estimate as neutral', () => {
    const items = [
      makeItem({ identifier: 'DOR-WEIRD', size: 'gigantic' }),
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-SM', 'DOR-WEIRD']);
  });

  it('treats missing createdAt as neutral in the age tier', () => {
    const items = [
      makeItem({ identifier: 'DOR-NOAGE', createdAt: undefined }),
      makeItem({
        identifier: 'DOR-DATED',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-DATED', 'DOR-NOAGE']);
  });

  it('does not mutate the input array', () => {
    const items = [
      makeItem({ identifier: 'DOR-B', priority: 4 }),
      makeItem({ identifier: 'DOR-A', priority: 1 }),
    ];
    const before = ids(items);
    rankEligible(items, DISPATCH);
    expect(ids(items)).toEqual(before);
  });
});

describe('selectDispatch — full policy (filter then rank)', () => {
  it('filters ineligible items AND returns survivors in ladder order', () => {
    const items: WorkItem[] = [
      // Eligible, urgent → should lead.
      makeItem({
        identifier: 'DOR-URGENT',
        priority: 1,
        project: { id: 'p1', name: 'p1', stateCategory: 'started' },
      }),
      // Eligible, low priority.
      makeItem({
        identifier: 'DOR-LOW',
        priority: 4,
        project: { id: 'p2', name: 'p2', stateCategory: 'started' },
      }),
      // Filtered: not ready.
      makeItem({ identifier: 'DOR-NOTREADY', priority: 1, labels: [] }),
      // Filtered: blocked by an open item.
      makeItem({
        identifier: 'DOR-BLOCKED',
        priority: 1,
        relations: {
          blocks: [],
          blockedBy: ['DOR-URGENT'],
          children: [],
          relatedTo: [],
        },
      }),
      // Filtered: other-owned.
      makeItem({ identifier: 'DOR-OTHER', priority: 1 }),
      // Filtered: completed state.
      makeItem({
        identifier: 'DOR-DONE',
        priority: 1,
        stateCategory: 'completed',
      }),
    ];
    const result = selectDispatch(
      items,
      { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: WIP },
      ownershipOpts({
        'DOR-URGENT': 'mine',
        'DOR-LOW': 'mine',
        'DOR-NOTREADY': 'mine',
        'DOR-BLOCKED': 'mine',
        'DOR-OTHER': 'other',
        'DOR-DONE': 'mine',
      })
    );
    expect(ids(result)).toEqual(['DOR-URGENT', 'DOR-LOW']);
  });

  it('produces the complete 7-tier ordering on a mixed survivor set', () => {
    const items: WorkItem[] = [
      makeItem({
        identifier: 'DOR-UNBLOCKER',
        priority: 3,
        project: { id: 'p1', name: 'p1', stateCategory: 'started' },
        relations: {
          blocks: ['DOR-MED'],
          blockedBy: [],
          children: [],
          relatedTo: [],
        },
      }),
      makeItem({
        identifier: 'DOR-URGENT',
        priority: 1,
        project: { id: 'p2', name: 'p2', stateCategory: 'started' },
      }),
      makeItem({
        identifier: 'DOR-MED',
        priority: 3,
        project: { id: 'p3', name: 'p3', stateCategory: 'started' },
      }),
    ];
    // Global cap is 2 → only first two admitted in input order, then ranked.
    const wideWip = WipCapSchema.parse({ global: 10, perProject: 10 });
    const result = selectDispatch(
      items,
      { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: wideWip },
      ownershipOpts()
    );
    // Tier 1: DOR-UNBLOCKER blocks an open item → first. Then priority orders the rest.
    expect(ids(result)).toEqual(['DOR-UNBLOCKER', 'DOR-URGENT', 'DOR-MED']);
  });
});

describe('sizeRank — the estimate type the adapter actually emits', () => {
  it('ranks a NUMERIC Fibonacci estimate (what Linear natively returns)', () => {
    const items = [
      makeItem({ identifier: 'DOR-8', size: 8 }),
      makeItem({ identifier: 'DOR-1', size: 1 }),
      makeItem({ identifier: 'DOR-3', size: 3 }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-1', 'DOR-3', 'DOR-8']);
  });

  it('ranks numeric and t-shirt estimates on one shared scale', () => {
    const items = [
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
      makeItem({ identifier: 'DOR-2', size: 2 }),
      makeItem({ identifier: 'DOR-LG', size: 'lg' }),
    ];
    // 2 pts (sm) < lg < xl
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-2', 'DOR-LG', 'DOR-XL']);
  });

  it('treats a numeric 0-point estimate as SMALLEST, not neutral', () => {
    const items = [
      makeItem({ identifier: 'DOR-ZERO', size: 0 }),
      makeItem({ identifier: 'DOR-NEUTRAL', size: undefined }),
      makeItem({ identifier: 'DOR-SM', size: 'sm' }),
    ];
    // 0 points is a real estimate (smallest); only an ABSENT estimate is neutral.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-ZERO', 'DOR-SM', 'DOR-NEUTRAL']);
  });

  it('degrades a NULL estimate to neutral instead of throwing', () => {
    const items = [
      // `null` is non-conformant (a missing optional must be absent), but the
      // oracle must degrade, not crash — the module header promises exactly this.
      makeItem({ identifier: 'DOR-NULL', size: null as unknown as undefined }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    expect(() => rankEligible(items, DISPATCH)).not.toThrow();
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-XL', 'DOR-NULL']);
  });

  it('degrades a NaN / non-finite estimate to neutral', () => {
    const items = [
      makeItem({ identifier: 'DOR-NAN', size: Number.NaN }),
      makeItem({ identifier: 'DOR-XL', size: 'xl' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-XL', 'DOR-NAN']);
  });
});

describe('priorityRank / ageRank — same defect shape as sizeRank', () => {
  // NOTE ON WHAT THESE TWO `null` TESTS DEFEND. `null` was never a crash on
  // either field — `PRIORITY_RANK[null]` misses the record and `?? NEUTRAL`
  // catches it, and `Date.parse(null)` stringifies to `"null"` → `NaN` →
  // already neutral. So NO seed that only removes the `typeof` guard can turn
  // either of them red. They assert that the TIER RAN (the identifiers are
  // chosen so the tier-7 tiebreak would order them the other way), not that the
  // guard exists. The guards are defended by the two wrong-TYPE tests below,
  // which are the only cases in this block that a guard-only seed can fail.

  it('degrades a NULL priority to neutral instead of throwing', () => {
    const items = [
      makeItem({
        identifier: 'DOR-AAA',
        priority: null as unknown as undefined,
      }),
      makeItem({ identifier: 'DOR-ZZZ', priority: 4 }),
    ];
    expect(() => rankEligible(items, DISPATCH)).not.toThrow();
    // Identifiers are chosen so the tier-7 identifier tiebreak would put the
    // NEUTRAL item FIRST: this only passes if the priority tier really ran.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-ZZZ', 'DOR-AAA']);
  });

  it('degrades a NON-NUMBER priority to neutral instead of reading it as urgent', () => {
    const items = [
      // The `typeof` guard's real job, and the only priority case that fails
      // without it. `PRIORITY_RANK` is a JS object, so its keys are STRINGS:
      // `PRIORITY_RANK["1"]` returns `0` — the urgent ordinal. A string priority
      // the contract never promised would silently outrank a genuinely urgent
      // item. Neutral is the honest answer.
      makeItem({
        identifier: 'DOR-AAA',
        priority: '1' as unknown as undefined,
      }),
      makeItem({ identifier: 'DOR-ZZZ', priority: 4 }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-ZZZ', 'DOR-AAA']);
  });

  it('degrades a NULL createdAt to neutral instead of throwing', () => {
    const items = [
      makeItem({
        identifier: 'DOR-AAA',
        createdAt: null as unknown as undefined,
      }),
      makeItem({
        identifier: 'DOR-ZZZ',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    expect(() => rankEligible(items, DISPATCH)).not.toThrow();
    // As above: the identifier tiebreak favours the neutral item, so this only
    // passes if the age tier actually ranked the dated item ahead of it.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-ZZZ', 'DOR-AAA']);
  });

  it('degrades a NON-STRING createdAt to neutral instead of misreading it as an ancient date', () => {
    const items = [
      // `Date.parse(1234)` stringifies to "1234" and parses as the YEAR 1234 —
      // a number the adapter contract never promised, silently ranked as the
      // oldest item in the queue. Neutral is the honest answer.
      makeItem({
        identifier: 'DOR-AAA',
        createdAt: 1234 as unknown as string,
      }),
      makeItem({
        identifier: 'DOR-ZZZ',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-ZZZ', 'DOR-AAA']);
  });

  it('degrades missing relations without throwing AND keeps the item dispatchable', () => {
    const items = [
      makeItem({
        identifier: 'DOR-NOREL',
        relations: undefined as unknown as WorkItem['relations'],
      }),
      // Ranks BEHIND DOR-NOREL on priority, so surviving is not enough — the
      // assertion below also pins where the graph-less item lands.
      makeItem({ identifier: 'DOR-BLOCKER', priority: 4 }),
    ];
    const config = {
      dispatch: DISPATCH,
      ownership: OWNERSHIP,
      wipCap: WIDE_WIP,
    };

    expect(() => selectDispatch(items, config, ownershipOpts())).not.toThrow();
    // Not throwing is the floor, not the contract. The `blockedBy` filter FAILS
    // OPEN (no graph ⇒ nothing blocks it, so it stays eligible) and the tier-1
    // unblocker score falls to a true neutral `0`, leaving priority to decide.
    expect(ids(selectDispatch(items, config, ownershipOpts()))).toEqual([
      'DOR-NOREL',
      'DOR-BLOCKER',
    ]);
  });

  it('degrades missing labels without throwing — in BOTH the filter and the G3 detector', () => {
    // `labels` is required under the adapter contract, exactly as `relations`
    // is, and the same argument applies: the oracle is the runtime and must not
    // crash on a non-conformant adapter. This one is worse — an unguarded
    // dereference also takes down classifyDispatchOutcome, the charter G3
    // starvation detector, so the loop cannot even report WHY it stopped.
    const items = [
      makeItem({
        identifier: 'DOR-NOLABELS',
        labels: undefined as unknown as string[],
      }),
      makeItem({ identifier: 'DOR-READY' }),
    ];
    const config = {
      dispatch: DISPATCH,
      ownership: OWNERSHIP,
      wipCap: WIDE_WIP,
    };

    // No labels ⇒ no `agent/ready` ⇒ held out of dispatch, but counted as
    // shapeable: work a triage pass could ready. That is the honest reading.
    const outcome = classifyDispatchOutcome(items, config, ownershipOpts());
    expect(ids(outcome.picked)).toEqual(['DOR-READY']);
    expect(outcome.shapeableCount).toBe(1);
  });

  it('rejects a bare-string labels scalar instead of substring-matching it', () => {
    // `"agent/ready".includes("agent/ready")` is TRUE — a scalar `labels` would
    // sail through the readiness gate on a shape the contract never allowed,
    // and `filterEligible` would dispatch it. Array-shaped or nothing.
    const items = [
      makeItem({
        identifier: 'DOR-STRINGLABEL',
        labels: 'agent/ready' as unknown as string[],
      }),
    ];
    expect(filterEligible(items, OWNERSHIP, ownershipOpts())).toEqual([]);
  });
});

describe('WIP cap — bounds concurrency without overriding the ladder', () => {
  it('picks the higher-ranked item under perProject:1 REGARDLESS of input order', () => {
    // Two identical, equally-eligible items in ONE project; only priority differs.
    const high = makeItem({
      identifier: 'DOR-502',
      priority: 2,
      project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
    });
    const low = makeItem({
      identifier: 'DOR-514',
      priority: 3,
      project: { id: 'proj_a', name: 'A', stateCategory: 'started' },
    });
    const config = { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: WIP }; // perProject: 1

    const forward = selectDispatch([high, low], config, ownershipOpts());
    const reversed = selectDispatch([low, high], config, ownershipOpts());

    // The cap still admits exactly one — but RANK decides which, not input order.
    expect(ids(forward)).toEqual(['DOR-502']);
    expect(ids(reversed)).toEqual(['DOR-502']);
    expect(ids(forward)).toEqual(ids(reversed));
  });

  it('is input-order independent across every tier of the ladder', () => {
    const items = [
      makeItem({ identifier: 'DOR-A', priority: 4, size: 'xl' }),
      makeItem({ identifier: 'DOR-B', priority: 1, size: 'lg' }),
      makeItem({ identifier: 'DOR-C', priority: 2, size: 'sm' }),
    ];
    const config = { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: WIP };
    const forward = ids(selectDispatch(items, config, ownershipOpts()));
    const reversed = ids(selectDispatch([...items].reverse(), config, ownershipOpts()));
    expect(forward).toEqual(['DOR-B']); // urgent wins the ladder
    expect(reversed).toEqual(forward);
  });
});

describe('rankEligible — two NEUTRALs in one tier are a TIE, not a NaN', () => {
  // The ladder subtracts tier ordinals, and NEUTRAL is `Infinity`. A bare
  // `Infinity - Infinity` is `NaN`; `NaN !== 0` is true, so the comparator used
  // to RETURN NaN the moment two items were both neutral in the same tier —
  // skipping every later tier AND the tier-7 identifier tiebreak, and leaving
  // V8 to treat the pair as equal, i.e. in INPUT ORDER. Both `size: undefined`
  // (the default state of an untriaged queue) and `priority: undefined` land
  // there, so this was reachable on real data, not a contrived shape.
  //
  // Each case pairs two items neutral in the SAME tier with identifiers whose
  // sorted order is the OPPOSITE of the input order, so the assertion fails
  // unless tier 7 was actually reached.
  const bothNeutral: [name: string, overrides: Partial<WorkItem>][] = [
    ['size: null on both', { size: null as unknown as undefined }],
    ['size: undefined on both', { size: undefined }],
    ['size: an unrecognized word on both', { size: 'gigantic' }],
    ['priority: null on both', { priority: null as unknown as undefined }],
    ['priority: undefined on both', { priority: undefined }],
    ['createdAt: undefined on both', { createdAt: undefined }],
  ];

  it.each(bothNeutral)('sorts by identifier from either input order — %s', (_name, overrides) => {
    const zzz = makeItem({ identifier: 'DOR-ZZZ', ...overrides });
    const aaa = makeItem({ identifier: 'DOR-AAA', ...overrides });

    expect(ids(rankEligible([zzz, aaa], DISPATCH))).toEqual(['DOR-AAA', 'DOR-ZZZ']);
    expect(ids(rankEligible([aaa, zzz], DISPATCH))).toEqual(['DOR-AAA', 'DOR-ZZZ']);
  });

  it('still falls through to a LATER tier when an earlier one is neutral on both', () => {
    // Both neutral on priority; the size tier must still get to decide. Under
    // the NaN comparator the priority tier aborted the ladder and size never ran.
    const items = [
      makeItem({ identifier: 'DOR-AAA', priority: undefined, size: 'xl' }),
      makeItem({ identifier: 'DOR-ZZZ', priority: undefined, size: 'xs' }),
    ];
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-ZZZ', 'DOR-AAA']);
  });
});

describe('rankEligible — input-order independence as a PROPERTY, not two hand-picked orders', () => {
  /**
   * Deterministic 32-bit PRNG (mulberry32). Seeded so a failure reproduces
   * exactly; no dependency, no flake.
   */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher-Yates over a copy, driven by the seeded PRNG. */
  function shuffle<T>(input: readonly T[], next: () => number): T[] {
    const out = [...input];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /**
   * A queue drawn from the values that actually occur in production, INCLUDING
   * the degraded ones — that mix is the point. Two hand-written orders cannot
   * find an order-dependence that needs a particular pair to be adjacent.
   */
  function generateQueue(next: () => number, size: number): WorkItem[] {
    const priorities = [0, 1, 2, 3, 4, undefined, null];
    const sizes = [0, 1, 3, 8, 21, 'xs', 'lg', 'xl', 'gigantic', '', undefined, null, Number.NaN];
    const createdAts = [
      '2026-01-01T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
      'not-a-date',
      undefined,
      null,
      1234,
    ];
    const projects = [
      { id: 'p1', name: 'p1', stateCategory: 'started' as const },
      { id: 'p2', name: 'p2', stateCategory: 'unstarted' as const },
      undefined,
    ];
    const pick = <T>(pool: readonly T[]): T => pool[Math.floor(next() * pool.length)] as T;

    return Array.from({ length: size }, (_unused, i) =>
      makeItem({
        // Zero-padded so identifier order is total and unambiguous.
        identifier: `DOR-${String(i).padStart(3, '0')}`,
        priority: pick(priorities) as WorkItem['priority'],
        size: pick(sizes) as WorkItem['size'],
        createdAt: pick(createdAts) as WorkItem['createdAt'],
        project: pick(projects),
      })
    );
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'ranks a shuffled 24-item queue identically to the canonical order (seed %i)',
    (seed) => {
      const next = rng(seed);
      const queue = generateQueue(next, 24);

      // Ten independent shuffles per seed: order-dependence that only shows up
      // for a particular adjacency has ten chances to surface. The shuffles are
      // compared against EACH OTHER as well as against the canonical order, and
      // the canonical is computed AFTER the loop — so the canonical is not the
      // call that happens to establish the answer everything else is checked
      // against.
      const results: string[][] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        results.push(ids(rankEligible(shuffle(queue, next), DISPATCH)));
      }
      const canonical = ids(rankEligible(queue, DISPATCH));
      for (const result of results) {
        expect(result).toEqual(results[0]);
        expect(result).toEqual(canonical);
      }
    }
  );

  it('is a PURE function of its input — two fresh module instances agree', async () => {
    // Shuffling inside one process cannot see shared mutable state, and adding
    // seeds does not help. Verified, not assumed: a first-seen memo seeded into
    // `typeRank` left every shuffle-based assertion above GREEN 8/8. The reason
    // is structural — the first call in the process warms the state, and every
    // later call then agrees with it, whichever call came first. Comparing the
    // shuffles against each other does not fix that either; that was measured
    // too, and it was also green.
    //
    // The only observable difference is WHICH order the state converged to, so
    // the check has to span two processes' worth of state. `vi.resetModules()`
    // plus a dynamic import gives exactly that: instance A is warmed by the
    // SHUFFLED order, instance B by the canonical one. A pure ladder returns
    // the same answer from both; anything carrying state across calls diverges.
    //
    // Worth having because `buildOpenSet` is rebuilt on every call and is the
    // obvious future memoization target in this exact file.
    const queue = generateQueue(rng(4242), 24);
    const shuffled = shuffle(queue, rng(7));

    vi.resetModules();
    const instanceA = await import('../scripts/dispatch-policy.ts');
    const fromShuffled = ids(instanceA.rankEligible(shuffled, DISPATCH));

    vi.resetModules();
    const instanceB = await import('../scripts/dispatch-policy.ts');
    const fromCanonical = ids(instanceB.rankEligible(queue, DISPATCH));

    expect(fromShuffled).toEqual(fromCanonical);
  });

  it('is a TOTAL order — the canonical ranking is a permutation, never a truncation', () => {
    const queue = generateQueue(rng(99), 24);
    const ranked = ids(rankEligible(queue, DISPATCH));
    expect(ranked).toHaveLength(queue.length);
    expect([...ranked].sort()).toEqual(ids(queue).sort());
  });
});

describe('non-conformance sweep — the runtime never crashes on a bad adapter (G3 + G12)', () => {
  // "Degrade, never throw" is a CONFORMANCE CRITERION, not a per-field habit.
  // Guarding fields one at a time is how `size`, `createdAt`, `relations` and
  // `labels` each shipped broken in turn: each was fixed only once someone
  // thought of it. This sweep substitutes a hostile value into EVERY WorkItem
  // field mechanically, so the next field added is covered without anyone
  // remembering to think of it.
  const HOSTILE_VALUES: [label: string, value: unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'nonsense'],
    ['an empty object', {}],
    ['an empty array', []],
  ];

  // The field list is DERIVED AT RUNTIME from the fixture, never hand-written.
  //
  // A literal `(keyof WorkItem)[]` would not do the job it looks like it does:
  // TypeScript constrains list MEMBERSHIP, never EXHAUSTIVENESS, so adding a
  // `WorkItem` field and forgetting the list produces no error anywhere — and
  // `tsc` cannot run in this package at all right now (DOR-537), so even a
  // type-level guard would be inert today. Deriving from `makeItem` means there
  // is no second list to keep in sync: `makeItem` returns `WorkItem`, so a new
  // REQUIRED field cannot be added to the contract without appearing here too.
  // (A new OPTIONAL field left out of the fixture would still be missed — that
  // is the honest residual, and it is why `makeItem` populates every field
  // rather than only the required ones.)
  //
  // `identifier` is excluded deliberately: it is the relation key and the tier-7
  // tiebreak, so a queue without one is not a degraded queue, it is a different
  // problem — the sweep would be asserting on an unidentifiable item.
  const FIELDS = (Object.keys(makeItem({ identifier: 'DOR-PROBE' })) as (keyof WorkItem)[]).filter(
    (field) => field !== 'identifier'
  );

  it('derives its field list from the fixture, and the fixture is complete', () => {
    // Guards the derivation itself, in both directions. If `makeItem` stops
    // populating a field the sweep silently SHRINKS; if a field is added the
    // sweep GROWS (verified: adding one field to the fixture alone took the
    // sweep from 90 cases to 96, with no list edited anywhere). Either way the
    // count below makes the change deliberate and announced rather than silent.
    expect(FIELDS).toHaveLength(15);
    expect(FIELDS).not.toContain('identifier');
    expect(FIELDS).toEqual(expect.arrayContaining(['relations', 'labels', 'size', 'createdAt']));
  });

  const CONFIG = { dispatch: DISPATCH, ownership: OWNERSHIP, wipCap: WIDE_WIP };

  const cases = FIELDS.flatMap((field) =>
    HOSTILE_VALUES.map(([label, value]) => [field, label, value] as const)
  );

  it.each(cases)(
    'survives %s = %s on one item while the rest of the queue still ranks',
    (field, _label, value) => {
      // A conformant control item that MUST still be picked and MUST still rank
      // first: the assertion is not merely "no throw", it is that one bad item
      // does not degrade the ranking of its neighbours.
      const control = makeItem({ identifier: 'DOR-CONTROL', priority: 1 });
      const hostile = {
        ...makeItem({ identifier: 'DOR-HOSTILE', priority: 4 }),
        [field]: value,
      };
      const items = [hostile, control];

      const outcome = classifyDispatchOutcome(items, CONFIG, ownershipOpts());

      // G3: the starvation detector must answer even on a non-conformant queue.
      expect(outcome.picked).toContain(control);
      expect(outcome.picked[0]).toBe(control);
      expect(outcome.eligibleCount).toBe(outcome.picked.length);
      expect(Number.isInteger(outcome.shapeableCount)).toBe(true);
      // G12: a degraded item is either eligible or shapeable — never silently
      // vanished from both counts, which is how a queue starves without saying so.
      expect(outcome.picked.length + outcome.shapeableCount).toBeGreaterThanOrEqual(1);
    }
  );

  it('survives EVERY field hostile at once', () => {
    const control = makeItem({ identifier: 'DOR-CONTROL', priority: 1 });
    const wrecked = { identifier: 'DOR-WRECKED' } as unknown as WorkItem;
    expect(() =>
      classifyDispatchOutcome([wrecked, control], CONFIG, ownershipOpts())
    ).not.toThrow();
    expect(
      ids(classifyDispatchOutcome([wrecked, control], CONFIG, ownershipOpts()).picked)
    ).toEqual(['DOR-CONTROL']);
  });
});

describe('sizeOrdinal — the one sanctioned way to compare a size against a t-shirt threshold', () => {
  it('puts both estimate vocabularies on the SAME scale, so a threshold comparison is honest', () => {
    // `size` is a union (`number | string`), so `8 >= "xl"` is not a comparison
    // any adapter can make. Comparing ordinals is: `subIssueThreshold` is a
    // t-shirt word, and it resolves onto the same scale a points estimate does.
    const threshold = sizeOrdinal('xl');
    expect(threshold).toBe(4);
    expect(sizeOrdinal(8)).toBe(threshold); // an 8-point estimate promotes
    expect(sizeOrdinal(21)).toBeGreaterThan(threshold as number);
    expect(sizeOrdinal(3)).toBeLessThan(threshold as number); // and a 3-point one does not
  });

  it('is monotonic but NOT injective — distinct estimates can share an ordinal', () => {
    // Documented rather than assumed: on a linear 1–5 scale `3` and `4` collapse
    // to the same ordinal, and everything at or above 13 collapses to the top.
    expect(sizeOrdinal(3)).toBe(sizeOrdinal(4));
    expect(sizeOrdinal(13)).toBe(sizeOrdinal(100));
    // Monotonic: a larger estimate never gets a SMALLER ordinal.
    const ascending = [0, 1, 2, 3, 5, 8, 13, 21, 100].map((p) => sizeOrdinal(p) as number);
    expect([...ascending].sort((a, b) => a - b)).toEqual(ascending);
  });

  it('returns undefined (neutral) for every non-estimate, but 0 for a real 0-point one', () => {
    expect(sizeOrdinal(0)).toBe(0);
    for (const bad of [undefined, null, '', '   ', 'gigantic', Number.NaN, -1, {}, []]) {
      expect(sizeOrdinal(bad as WorkItem['size'])).toBeUndefined();
    }
  });
});

describe('prototype-key coercion — a plain object is not a lookup table', () => {
  // The string-priority defect (`PRIORITY_RANK["1"]` returning the urgent
  // ordinal) was not a one-off: it is what a plain `{}` does when tracker data
  // is used as a key. Every inherited `Object.prototype` member answers a
  // lookup that should have missed. This block pins all three remaining sites.
  // The realistic likelihood on Linear data is nil (UUID project ids, `DOR-nnn`
  // identifiers) — these are fixed because a `Map` retires the entire class
  // permanently, and this is the fourth silent-wrong-answer found in one file.
  const PROTOTYPE_KEYS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];

  it.each(PROTOTYPE_KEYS)('holds the per-project WIP cap for project id %s (G7)', (key) => {
    // The worst of the three: `perProjectCount[projectId]` inherits a function
    // from Object.prototype, `>= wipCap.perProject` is false against it, and
    // EVERY item is admitted. That silently OVER-admits — worse than the
    // original DOR-515 bug, which merely picked the wrong single item — and it
    // breaches charter G7 (concurrent work is WIP-capped).
    const items = ['DOR-1', 'DOR-2', 'DOR-3'].map((identifier) =>
      makeItem({
        identifier,
        project: { id: key, name: key, stateCategory: 'started' },
      })
    );
    // perProject: 1 — exactly one item from this project may be in flight.
    expect(ids(truncateRankedToWipCap(items, WIP, {}))).toEqual(['DOR-1']);
  });

  it.each(PROTOTYPE_KEYS)('treats the prototype-key size %s as neutral, not as a rank', (key) => {
    // `SIZE_SCALE[token]` returns a FUNCTION for `constructor`, so the size tier
    // compares against `Object` itself and garbage outranks a real `xs`.
    // `toString`/`valueOf`/`hasOwnProperty` are shielded only by accident —
    // `sizeOrdinal` lowercases, so `"tostring"` misses — but `constructor` and
    // `__proto__` are already lowercase, so the accident does not cover them.
    expect(sizeOrdinal(key)).toBeUndefined();
    const items = [
      makeItem({ identifier: 'DOR-A', size: key }),
      makeItem({ identifier: 'DOR-Z', size: 'xs' }),
    ];
    // A real xs beats a neutral, even though the identifier tiebreak favours A.
    expect(ids(rankEligible(items, DISPATCH))).toEqual(['DOR-Z', 'DOR-A']);
  });

  it.each(PROTOTYPE_KEYS)('resolves ownership for an item identified %s', (key) => {
    // `ownershipOf[identifier]` returns the inherited member, which is `!==
    // undefined`, so the precomputed branch wins and `classifyOwnership` never
    // runs. `isClaimable` then falls off the end of its switch and returns
    // `undefined`, so the item is silently filtered. Fail-closed, so mild — but
    // the same coercion, and a dropped item is still a wrong answer.
    const items = [makeItem({ identifier: key })];
    // The map is EMPTY: nothing was precomputed, so the callback must decide.
    expect(ids(filterEligible(items, OWNERSHIP, ownershipOpts({})))).toEqual([key]);
  });

  it('fails CLOSED on an ownership class outside the union', () => {
    // The exhaustiveness guard's runtime half. `isClaimable` had no `default`,
    // so an off-union value returned `undefined` — falsy, and therefore
    // accidentally fail-closed. Now it is deliberately `false`, and the `never`
    // assignment makes a NEW OwnershipClass member a compile error rather than
    // a silently unclaimable one.
    expect(isClaimable('nonsense' as OwnershipClass, OWNERSHIP)).toBe(false);
  });
});

describe('type sanity', () => {
  it('accepts the full WorkItemPriority range', () => {
    const priorities: WorkItemPriority[] = [0, 1, 2, 3, 4];
    const items = priorities.map((p, i) => makeItem({ identifier: `DOR-${i}`, priority: p }));
    expect(rankEligible(items, DISPATCH)).toHaveLength(5);
  });
});
