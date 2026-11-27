/**
 * The work order, written into a saved tracker view's manual order (DOR-5068).
 *
 * A tracker view sorts by one field, and the work order is a ladder of eight,
 * so no view can show it on its own. Flow writes the computed order into the
 * view's manual positions instead: `flow order --write-order` moves only the
 * items whose place changed, and `flow order --check-order` reports the first
 * place where the view and the order disagree.
 *
 * The ranked items the view shows take the top, best first. A view member the
 * order does not rank (a blocked item, one waiting for triage, a new item the
 * tracker put at the top) goes in one block after the last ranked item, in
 * the order it has now. A ranked item the view does not show is left alone,
 * because the view's filter decides what it shows.
 *
 * The moves are as few as the order allows: the longest run of items already
 * in order (a longest increasing subsequence of their positions) stays put,
 * and each other item gets a position between its new neighbours, so one
 * dragged item costs one write. When the floats between two neighbours
 * cannot hold a new position strictly between them, the whole view is
 * renumbered once.
 *
 * Pure: no clock, no network. Dependency-free.
 *
 * @module @dorkos/flow/view-order
 */

import type { PositionWrite, ViewEntry, ViewKind } from './tracker/types.ts';

/**
 * The description each ordered view carries, and what `flow order
 * --check-order` prints on drift: the view is computed, so a drag is undone.
 */
export const VIEW_DESCRIPTION =
  'Nobody drags in this view: flow order rewrites it every hour from the fields. Change a field instead.';

/** The gap a renumbered list leaves between two neighbours, and past either end. */
export const POSITION_STEP = 1000;

/** Where a view first disagrees with the order. */
export interface ViewDrift {
  /** The 1-based place in the view. */
  place: number;
  /** The key the order puts there. */
  expected: string;
  /** The key the view has there. */
  found: string;
}

/** One view compared with the order. */
export interface ViewComparison {
  /** What the view should show: the ranked keys it has, then its unranked ones as they stand. */
  target: string[];
  /** What the view shows, in its order. */
  current: string[];
  /** The first difference, or `null` when the view is in order. */
  drift: ViewDrift | null;
  /** View members the order does not rank: they go after the ranked ones. */
  unranked: string[];
  /** Ranked keys the view does not show: never written. */
  notInView: string[];
}

/**
 * Compare a view's current order with the order's ranked keys.
 *
 * @param entries - The view's entries, as the adapter read them (any order;
 *   sorted here by position, then key, the order the tracker shows them in).
 * @param ranked - The order's keys, best first.
 * @returns The comparison.
 */
export function compareView(
  entries: readonly ViewEntry[],
  ranked: readonly string[]
): ViewComparison {
  const sorted = sortEntries(entries);
  const members = new Set(sorted.map((entry) => entry.key));
  const rankedSet = new Set(ranked);
  const current = sorted.map((entry) => entry.key);
  const unranked = current.filter((key) => !rankedSet.has(key));
  const target = [...ranked.filter((key) => members.has(key)), ...unranked];
  return {
    target,
    current,
    drift: firstDrift(current, target),
    unranked,
    notInView: ranked.filter((key) => !members.has(key)),
  };
}

/**
 * The first place two key lists disagree.
 *
 * @param current - What the view has.
 * @param target - What the order says.
 * @returns The drift, or `null` when they agree.
 */
export function firstDrift(
  current: readonly string[],
  target: readonly string[]
): ViewDrift | null {
  const length = Math.max(current.length, target.length);
  for (let i = 0; i < length; i += 1) {
    if (current[i] !== target[i]) {
      return { place: i + 1, expected: target[i] ?? '(nothing)', found: current[i] ?? '(nothing)' };
    }
  }
  return null;
}

/**
 * The position writes that put a view in the order's order (ranked members
 * first, then the unranked block), changing as few positions as it can.
 *
 * @param kind - What the view lists.
 * @param entries - The view's entries, as the adapter read them.
 * @param ranked - The order's keys, best first.
 * @returns The writes, in the order's order. Empty when the view is in order.
 */
export function planPositions(
  kind: ViewKind,
  entries: readonly ViewEntry[],
  ranked: readonly string[]
): PositionWrite[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const { target } = compareView(entries, ranked);
  const line = target.map((key) => byKey.get(key) as ViewEntry);
  const kept = longestIncreasing(line.map((entry) => entry.position));
  const positions = fillBetween(
    line.map((entry) => entry.position),
    kept
  );
  const final = positions ?? renumbered(line);
  return line.flatMap((entry, i) =>
    final[i] === entry.position ? [] : [{ kind, id: entry.id, key: entry.key, position: final[i] }]
  );
}

/** Entries in the order the tracker shows them: position, then key. */
function sortEntries(entries: readonly ViewEntry[]): ViewEntry[] {
  return [...entries].sort((a, b) =>
    a.position !== b.position ? a.position - b.position : a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );
}

/**
 * The indices of one longest strictly increasing subsequence of `values`
 * (patience sorting, O(n log n)). Ties are never both kept, so two items
 * sharing a position are pulled apart.
 *
 * @param values - The positions, in the order's order.
 * @returns A set of indices whose values increase strictly.
 */
export function longestIncreasing(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < values[i]) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[i] = tails[low - 1];
    tails[low] = i;
  }
  const kept = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i !== -1; i = previous[i]) {
    kept.add(i);
  }
  return kept;
}

/**
 * New positions: kept indices keep theirs; each run of moved ones is spread
 * evenly between the kept neighbours around it (or a step past the end).
 *
 * @param values - The current positions, in the order's order.
 * @param kept - The indices that stay.
 * @returns The positions, or `null` when the floats cannot hold them in order.
 */
function fillBetween(values: readonly number[], kept: ReadonlySet<number>): number[] | null {
  const out = [...values];
  let i = 0;
  while (i < values.length) {
    if (kept.has(i)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < values.length && !kept.has(end)) end += 1;
    const count = end - i;
    const before = i > 0 ? out[i - 1] : undefined;
    const after = end < values.length ? values[end] : undefined;
    const gap =
      before !== undefined && after !== undefined ? (after - before) / (count + 1) : POSITION_STEP;
    for (let j = 0; j < count; j += 1) {
      let position: number;
      if (before === undefined && after === undefined) position = (j + 1) * POSITION_STEP;
      else if (before === undefined) position = (after as number) - (count - j) * POSITION_STEP;
      else position = before + gap * (j + 1);
      // A tracker may read a position of exactly 0 as "append", so 0 becomes
      // half a gap up. That is safe: the next value in this run is a whole gap
      // up, and the check below renumbers if it ever is not.
      out[i + j] = position === 0 ? gap / 2 : position;
    }
    i = end;
  }
  // Floats run out near large values: a value meant to sit between two
  // neighbours can round onto one of them. Every position must be strictly
  // above the one before it, or the whole view is renumbered.
  for (let k = 1; k < out.length; k += 1) if (!(out[k] > out[k - 1])) return null;
  return out;
}

/**
 * Every entry renumbered a step apart, starting at the lowest position among
 * them, never at 0. Used only when a gap is too small to split.
 */
function renumbered(line: readonly ViewEntry[]): number[] {
  const start = Math.min(...line.map((entry) => entry.position));
  return line.map((_, i) => {
    const position = start + i * POSITION_STEP;
    return position === 0 ? POSITION_STEP / 2 : position;
  });
}
