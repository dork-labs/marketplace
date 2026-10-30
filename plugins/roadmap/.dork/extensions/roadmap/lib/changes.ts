/**
 * What one commit changed on the board, worked out by comparing the file
 * before and after it, never by reading the commit message (the message is
 * only ever shown as the reason).
 *
 * Removing an ask is reported as just that. Nothing here reads a removed ask
 * as answered or approved: the file has no field for an answer, on purpose.
 *
 * @module @dorkos/roadmap/extension/lib/changes
 */

import {
  HORIZONS,
  type Board,
  type Horizon,
  type Item,
  type Moscow,
  type Status,
} from './roadmap.ts';

/** One change between two versions of the file. */
export type Change =
  | { kind: 'created' }
  | { kind: 'unreadable' }
  | { kind: 'fixed' }
  | { kind: 'milestones' }
  | { kind: 'reordered'; horizon: Horizon }
  | { kind: 'added'; id: string; title: string; horizon: Horizon }
  | { kind: 'removed'; id: string; title: string }
  | { kind: 'moved'; id: string; title: string; from: Horizon; to: Horizon }
  | { kind: 'moscow'; id: string; title: string; to: Moscow }
  | { kind: 'status'; id: string; title: string; to: Status }
  | { kind: 'asked'; id: string; title: string; ask: string }
  | { kind: 'ask-removed'; id: string; title: string; ask: string }
  | { kind: 'edited'; id: string; title: string; fields: string[] };

/** The fields compared for an "edited" change, in the order they are named. */
const EDIT_FIELDS = ['title', 'owner', 'target', 'why', 'links'] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The changes to one bet that is in both versions. */
function itemChanges(before: Item, after: Item): Change[] {
  const { id, title } = after;
  const changes: Change[] = [];
  if (before.horizon !== after.horizon) {
    changes.push({ kind: 'moved', id, title, from: before.horizon, to: after.horizon });
  }
  if (before.moscow !== after.moscow) changes.push({ kind: 'moscow', id, title, to: after.moscow });
  if (before.status !== after.status) changes.push({ kind: 'status', id, title, to: after.status });
  const beforeAsks = new Map(before.needs.map((n) => [n.id, n]));
  const afterAsks = new Set(after.needs.map((n) => n.id));
  for (const need of before.needs) {
    if (!afterAsks.has(need.id)) changes.push({ kind: 'ask-removed', id, title, ask: need.ask });
  }
  for (const need of after.needs) {
    if (!beforeAsks.has(need.id)) changes.push({ kind: 'asked', id, title, ask: need.ask });
  }
  const fields = EDIT_FIELDS.filter((field) => !same(before[field], after[field]));
  if (fields.length > 0) changes.push({ kind: 'edited', id, title, fields: [...fields] });
  return changes;
}

/** The ids of the bets in a column that are in both versions, in file order. */
function columnOrder(board: Board, horizon: Horizon, shared: Set<string>): string[] {
  return board.items.filter((i) => i.horizon === horizon && shared.has(i.id)).map((i) => i.id);
}

/**
 * The changes from one version of the file to the next.
 *
 * @param before - The earlier board, or null when the file did not exist.
 * @param after - The later board, or null when that version does not parse.
 * @returns The changes, bets in the later file's order, then added and removed bets.
 */
export function diffBoards(before: Board | null, after: Board | null): Change[] {
  if (after === null) return [{ kind: 'unreadable' }];
  if (before === null) return [{ kind: 'created' }];
  const changes: Change[] = [];
  if (!same(before.milestones, after.milestones)) changes.push({ kind: 'milestones' });
  const beforeById = new Map(before.items.map((i) => [i.id, i]));
  const afterIds = new Set(after.items.map((i) => i.id));
  const removed: Change[] = [];
  const added: Change[] = [];
  for (const item of after.items) {
    const old = beforeById.get(item.id);
    if (old) changes.push(...itemChanges(old, item));
    else added.push({ kind: 'added', id: item.id, title: item.title, horizon: item.horizon });
  }
  for (const item of before.items) {
    if (!afterIds.has(item.id)) removed.push({ kind: 'removed', id: item.id, title: item.title });
  }
  // A reorder is only worth naming when the bets that stayed in a column
  // changed places; one moving in or out is already its own change.
  const stayed = new Set(
    after.items.filter((i) => beforeById.get(i.id)?.horizon === i.horizon).map((i) => i.id)
  );
  for (const horizon of HORIZONS) {
    if (!same(columnOrder(before, horizon, stayed), columnOrder(after, horizon, stayed))) {
      changes.push({ kind: 'reordered', horizon });
    }
  }
  return [...changes, ...removed, ...added];
}
