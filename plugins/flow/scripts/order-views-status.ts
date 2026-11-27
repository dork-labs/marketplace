/**
 * The last result of `flow order --write-order` or `--check-order` (DOR-5068),
 * kept in `<main checkout>/.dork/flow/order-views.json` so `flow status` and
 * the Flow page can say whether the work order views are in order without
 * reading the tracker. `cli/order-views.ts` writes it through the atomic JSON
 * helper; this module only names the file and reads it.
 *
 * Dependency-free, so the Flow extension's server half reads it too.
 *
 * @module @dorkos/flow/order-views-status
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The file, relative to the main checkout. */
export const ORDER_VIEWS_FILE = path.join('.dork', 'flow', 'order-views.json');

/** The lock a writing run holds, relative to the main checkout. */
export const ORDER_VIEWS_LOCK = path.join('.dork', 'flow', 'order-views.lock');

/** The last result. */
export interface OrderViewsStatus {
  /** Shape version. */
  v: 1;
  /** When the run finished, ISO. */
  at: string;
  /** Which run: a write or a check. */
  mode: 'write' | 'check';
  /** Whether both views were in order at the end of the run. */
  inOrder: boolean;
  /** The first item out of place, and in which view, or `null`. */
  drift: { view: 'issues' | 'projects'; place: number; expected: string; found: string } | null;
  /** Positions written, for a write; `null` for a check. */
  wrote: number | null;
  /**
   * Set only when a write stopped at `order.maxWrites`: how many positions
   * the views needed. `null` otherwise, and for a check.
   */
  needed: number | null;
  /**
   * When this trouble began: the first run that saw the same first drift (or
   * the same failed write) that this one saw. `null` while in order.
   */
  driftSince: string | null;
}

/**
 * Whether two results describe the same trouble: the same first drift, both
 * a failed write, or both a write stopped at its cap.
 *
 * @param a - One result.
 * @param b - The other.
 * @returns True when they match.
 */
export function sameTrouble(
  a: Pick<OrderViewsStatus, 'inOrder' | 'drift' | 'needed'>,
  b: Pick<OrderViewsStatus, 'inOrder' | 'drift' | 'needed'>
): boolean {
  if (a.inOrder || b.inOrder) return false;
  if ((a.needed === null) !== (b.needed === null)) return false;
  if (a.drift === null || b.drift === null) return a.drift === b.drift;
  return (
    a.drift.view === b.drift.view &&
    a.drift.place === b.drift.place &&
    a.drift.expected === b.drift.expected &&
    a.drift.found === b.drift.found
  );
}

/**
 * The last result, or `null` when none was saved or the file cannot be read.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The status, or `null`.
 */
export function readOrderViewsStatus(mainCheckout: string): OrderViewsStatus | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path.join(mainCheckout, ORDER_VIEWS_FILE), 'utf8'));
  } catch {
    return null;
  }
  const record = value as Partial<OrderViewsStatus> | null;
  if (
    record === null ||
    typeof record !== 'object' ||
    record.v !== 1 ||
    typeof record.at !== 'string' ||
    !Number.isFinite(Date.parse(record.at)) ||
    (record.mode !== 'write' && record.mode !== 'check') ||
    typeof record.inOrder !== 'boolean'
  ) {
    return null;
  }
  const drift = record.drift;
  const driftOk =
    drift === null ||
    (typeof drift === 'object' &&
      (drift.view === 'issues' || drift.view === 'projects') &&
      typeof drift.place === 'number' &&
      typeof drift.expected === 'string' &&
      typeof drift.found === 'string');
  if (!driftOk) return null;
  return {
    v: 1,
    at: record.at,
    mode: record.mode,
    inOrder: record.inOrder,
    drift: drift ?? null,
    wrote: typeof record.wrote === 'number' ? record.wrote : null,
    needed: typeof record.needed === 'number' ? record.needed : null,
    driftSince:
      typeof record.driftSince === 'string' && Number.isFinite(Date.parse(record.driftSince))
        ? record.driftSince
        : null,
  };
}

/**
 * One line for a person, or `null` when the views are in order. Out of order
 * with no drift means the last write stopped at its cap (`needed` set) or
 * failed part way.
 *
 * @param status - The last result.
 * @returns The line.
 */
export function orderViewsDriftLine(status: OrderViewsStatus): string | null {
  if (status.inOrder) return null;
  if (status.drift === null && status.needed !== null) {
    return `The last write to the work order views stopped at its cap after ${status.wrote ?? 0} of ${status.needed} positions; the next run writes the rest.`;
  }
  if (status.drift === null) {
    return 'The last write to the work order views failed; flow order --write-order says why.';
  }
  const view = status.drift.view === 'issues' ? 'issue view' : 'project view';
  return `The work order's ${view} is out of order at place ${status.drift.place}: it shows ${status.drift.found} where the order has ${status.drift.expected}.`;
}
