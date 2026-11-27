/**
 * The work order written into a view's manual order (DOR-5068): the planner
 * moves as few items as it can, one dragged item costs one write, a second
 * plan over its own result writes nothing, and the comparison names the first
 * place a view and the order disagree.
 */

import { describe, expect, it } from 'vitest';

import type { ViewEntry } from '../scripts/tracker/types.ts';
import {
  compareView,
  firstDrift,
  longestIncreasing,
  planPositions,
  VIEW_DESCRIPTION,
} from '../scripts/view-order.ts';

/** View entries for keys, positions 1000 apart in the order given. */
function view(keys: string[], positions?: number[]): ViewEntry[] {
  return keys.map((key, i) => ({
    id: `id-${key}`,
    key,
    name: `Name ${key}`,
    position: positions?.[i] ?? (i + 1) * 1000,
  }));
}

/** The view after applying writes, sorted the way the tracker shows it. */
function apply(entries: ViewEntry[], writes: ReturnType<typeof planPositions>): ViewEntry[] {
  const next = new Map(writes.map((w) => [w.key, w.position]));
  return entries
    .map((entry) => ({ ...entry, position: next.get(entry.key) ?? entry.position }))
    .sort((a, b) => a.position - b.position);
}

describe('planPositions', () => {
  it('writes nothing when the view is already in order', () => {
    expect(planPositions('issues', view(['A', 'B', 'C']), ['A', 'B', 'C'])).toEqual([]);
  });

  it('moves one dragged item back with one write, between its neighbours', () => {
    // Someone dragged C to the top.
    const entries = view(['C', 'A', 'B', 'D']);
    const writes = planPositions('issues', entries, ['A', 'B', 'C', 'D']);
    expect(writes).toEqual([{ kind: 'issues', id: 'id-C', key: 'C', position: 3500 }]);
    expect(apply(entries, writes).map((e) => e.key)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('is idempotent: a plan over its own result writes nothing', () => {
    const entries = view(['E', 'D', 'C', 'B', 'A'], [5, 1, 3, 2, 4]);
    const ranked = ['A', 'B', 'C', 'D', 'E'];
    const once = apply(entries, planPositions('issues', entries, ranked));
    expect(once.map((e) => e.key)).toEqual(ranked);
    expect(planPositions('issues', once, ranked)).toEqual([]);
  });

  it('places an item above the first or below the last a step past the end', () => {
    const head = view(['B', 'C', 'A', 'D'], [2000, 3000, 4000, 5000]);
    expect(planPositions('issues', head, ['A', 'B', 'C', 'D'])).toEqual([
      { kind: 'issues', id: 'id-A', key: 'A', position: 1000 },
    ]);
    const tail = view(['D', 'A', 'B', 'C']);
    expect(planPositions('issues', tail, ['A', 'B', 'C', 'D'])).toEqual([
      { kind: 'issues', id: 'id-D', key: 'D', position: 5000 },
    ]);
  });

  it('never writes a position of exactly 0 (Linear reads it as "append" for a project)', () => {
    // A step below B (1000) would be 0: it lands half a step lower instead.
    const head = view(['B', 'C', 'A']);
    expect(planPositions('projects', head, ['A', 'B', 'C'])).toEqual([
      { kind: 'projects', id: 'id-A', key: 'A', position: 500 },
    ]);
    // Halfway between -1000 and 1000 would be 0.
    const middle = view(['A', 'B', 'X'], [-1000, 1000, 5000]);
    expect(planPositions('projects', middle, ['A', 'X', 'B'])).toEqual([
      { kind: 'projects', id: 'id-X', key: 'X', position: 500 },
    ]);
    const after = apply(middle, planPositions('projects', middle, ['A', 'X', 'B']));
    expect(after.map((e) => e.key)).toEqual(['A', 'X', 'B']);
  });

  it('pulls apart two items that share a position', () => {
    const entries = view(['A', 'B', 'C'], [1000, 1000, 2000]);
    const writes = planPositions('issues', entries, ['A', 'B', 'C']);
    expect(writes).toHaveLength(1);
    const after = apply(entries, writes);
    expect(after.map((e) => e.key)).toEqual(['A', 'B', 'C']);
    expect(new Set(after.map((e) => e.position)).size).toBe(3);
  });

  it('renumbers once when two neighbours are too close to split', () => {
    const entries = view(['A', 'C', 'B'], [1, 1 + Number.EPSILON, 2]);
    const writes = planPositions('issues', entries, ['A', 'B', 'C']);
    const after = apply(entries, writes);
    expect(after.map((e) => e.key)).toEqual(['A', 'B', 'C']);
    expect(planPositions('issues', after, ['A', 'B', 'C'])).toEqual([]);
  });

  it('renumbers when the floats near 1e10 cannot hold a value between two neighbours', () => {
    // Two doubles apart at 1e10 (one step is 2^-19): two new values between
    // them round onto the same double. A and C..E stay; X and Y must fit
    // between A and C, and cannot.
    const step = 2 ** -19;
    const a = 1e10;
    const c = a + 2 * step;
    const entries = view(['A', 'C', 'D', 'E', 'X', 'Y'], [a, c, c + 1, c + 2, 2e10, 2e10 + 1]);
    const ranked = ['A', 'X', 'Y', 'C', 'D', 'E'];
    const after = apply(entries, planPositions('issues', entries, ranked));
    expect(after.map((e) => e.key)).toEqual(ranked);
    expect(new Set(after.map((e) => e.position)).size).toBe(6);
    expect(planPositions('issues', after, ranked)).toEqual([]);
  });

  it('puts unranked members in a block after the last ranked one, in their current order', () => {
    // U and V are in the view but unranked (blocked, new at the top); Z is
    // ranked but not in the view, so it is never written.
    const entries = view(['V', 'B', 'U', 'A']);
    const writes = planPositions('issues', entries, ['A', 'Z', 'B']);
    expect(writes.some((write) => write.key === 'Z')).toBe(false);
    const after = apply(entries, writes);
    expect(after.map((e) => e.key)).toEqual(['A', 'B', 'V', 'U']);
    expect(planPositions('issues', after, ['A', 'Z', 'B'])).toEqual([]);
  });
});

describe('compareView', () => {
  it('names the first place the view and the order disagree', () => {
    const result = compareView(view(['A', 'C', 'B', 'U']), ['A', 'B', 'C', 'Z']);
    expect(result.drift).toEqual({ place: 2, expected: 'B', found: 'C' });
    expect(result.target).toEqual(['A', 'B', 'C', 'U']);
    expect(result.unranked).toEqual(['U']);
    expect(result.notInView).toEqual(['Z']);
  });

  it('reads the view in position order, whatever order the entries came in', () => {
    const entries = view(['B', 'A'], [2000, 1000]);
    expect(compareView(entries, ['A', 'B']).drift).toBeNull();
  });

  it('flags an unranked member above the last ranked one as drift', () => {
    // A new issue the tracker put at the top, above the order.
    expect(compareView(view(['N', 'A', 'B']), ['A', 'B']).drift).toEqual({
      place: 1,
      expected: 'A',
      found: 'N',
    });
    expect(compareView(view(['A', 'B', 'N']), ['A', 'B']).drift).toBeNull();
  });

  it('reports no drift for a view in order', () => {
    expect(compareView(view(['A', 'B']), ['A', 'B']).drift).toBeNull();
  });
});

describe('the pieces', () => {
  it('firstDrift names a missing tail', () => {
    expect(firstDrift(['A'], ['A', 'B'])).toEqual({ place: 2, expected: 'B', found: '(nothing)' });
    expect(firstDrift(['A', 'B'], ['A', 'B'])).toBeNull();
  });

  it('longestIncreasing keeps a longest strictly increasing run', () => {
    expect([...longestIncreasing([3, 1, 2, 5, 4])].sort()).toEqual([1, 2, 4]);
    expect(longestIncreasing([1, 1, 1]).size).toBe(1);
    expect(longestIncreasing([]).size).toBe(0);
  });

  it('the view description says nobody drags', () => {
    expect(VIEW_DESCRIPTION).toBe(
      'Nobody drags in this view: flow order rewrites it every hour from the fields. Change a field instead.'
    );
  });
});
