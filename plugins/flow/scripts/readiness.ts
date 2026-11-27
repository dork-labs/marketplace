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
import { hasDoneWhen } from './sections.ts';
import { compareIdentifiers } from './identifiers.ts';
import type { Readiness } from './work-order.ts';
import { hasLabel, type WorkItem } from './work-item.ts';
import { AGENT_NEEDS_INPUT } from './work-state.ts';

/** What {@link readinessOf} may look at besides the item. */
export interface ReadinessContext {
  /** Every open item of the team, by identifier. */
  open: ReadonlyMap<string, WorkItem>;
}

/**
 * Whether an item is ready to start, and the reasons when it is not, always
 * in this order:
 *
 * 1. `needs a size`: it has no estimate.
 * 2. `needs a done-when`: its description has no done-when section with text
 *    in it (`## Done when` or `## Validation criteria`, read by
 *    `sections.ts`, the reader `flow create` and the groom's GRM-5 share).
 * 3. `needs a decision (<id>)`: it carries `agent/needs-input`, the one signal
 *    flow writes when it asks a person a question on an item (`flow triage
 *    --park`, a parked drain run). The id is the item's own: the question waits
 *    on it. Nothing else counts as an open decision; a decision tracked in its
 *    own item blocks this one through a `blocks` relation and reads as reason 4.
 * 4. `blocked by <id>`: one per open item that blocks it, in identifier order.
 *    A blocker that is closed, or not in `ctx.open`, does not count.
 *
 * @param item - The item.
 * @param ctx - The open items it may point at.
 * @returns Its readiness.
 */
export function readinessOf(item: WorkItem, ctx: ReadinessContext): Readiness {
  const reasons: string[] = [];
  if (sizeOrdinal(item?.size) === undefined) reasons.push('needs a size');
  const description = item?.description;
  if (typeof description !== 'string' || !hasDoneWhen(description)) {
    reasons.push('needs a done-when');
  }
  if (hasLabel(item, AGENT_NEEDS_INPUT)) reasons.push(`needs a decision (${item.identifier})`);
  const blockedBy = item?.relations?.blockedBy;
  for (const id of Array.isArray(blockedBy) ? [...blockedBy].sort(compareIdentifiers) : []) {
    if (ctx.open.has(id)) reasons.push(`blocked by ${id}`);
  }
  return { ready: reasons.length === 0, reasons };
}
