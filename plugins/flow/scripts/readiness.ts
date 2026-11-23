/**
 * Readiness as an output of the work order (DOR-5069): whether an item is
 * ready for an agent to start, and if not, what is missing. Readiness never
 * moves an item in the order; the drain reads it to decide whether to start
 * the top item or make it ready first. The `agent/ready` label stays the claim
 * gate.
 *
 * Pure: reads only the item and the open items it points at.
 *
 * @see research/20261122_work-sequencing.md §3.3 "Readiness is an output" (dorkos repo)
 * @module @dorkos/flow/readiness
 */

import { sizeOrdinal } from './dispatch-policy.ts';
import { compareIdentifiers, type Readiness } from './work-order.ts';
import type { WorkItem } from './work-item.ts';

/** What {@link readinessOf} may look at besides the item. */
export interface ReadinessContext {
  /** Every open item of the team, by identifier. */
  open: ReadonlyMap<string, WorkItem>;
}

/**
 * Whether an item is ready to start, and the reasons when it is not:
 * `needs a size` when it has no estimate, and `blocked by DOR-y` for each
 * open item that blocks it.
 *
 * @param item - The item.
 * @param ctx - The open items it may point at.
 * @returns Its readiness.
 */
export function readinessOf(item: WorkItem, ctx: ReadinessContext): Readiness {
  const reasons: string[] = [];
  if (sizeOrdinal(item?.size) === undefined) reasons.push('needs a size');
  const blockedBy = item?.relations?.blockedBy;
  for (const id of Array.isArray(blockedBy) ? [...blockedBy].sort(compareIdentifiers) : []) {
    if (ctx.open.has(id)) reasons.push(`blocked by ${id}`);
  }
  return { ready: reasons.length === 0, reasons };
}
