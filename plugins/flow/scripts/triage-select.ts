/**
 * Which open items the daily triage takes up (DOR-4546). Every item is triaged
 * as it is filed, so the daily run must not touch one again: a second pass
 * would move its last-changed time, and a Could would never reach the groom's
 * expiry (`groom.couldExpiryDays`, 60 days unless set).
 *
 * An item needs triage when it is waiting (a `backlog` or `unstarted` state),
 * has no `agent/*` label and no assignee but the agent, and either:
 *
 * - no MoSCoW bucket yet (no priority 1-4) or no project; or
 * - it is a Must (priority 1 or 2) and not a `type/meta` tracker (never
 *   readied): a Must is readied or parked, and either one gives it an
 *   `agent/*` label, so it is taken up once.
 *
 * A Should or Could (priority 3 or 4) with a project is triaged already: it
 * waits in the backlog for the groom, and the daily run leaves it alone. There
 * is no adapter verb that moves an item between two states of the backlog
 * category (out of a tracker's intake state), so this selection, not a state
 * move, is what keeps the daily run off it.
 *
 * Dependency-free and pure.
 *
 * @module @dorkos/flow/triage-select
 */

import type { WorkItem } from './work-item.ts';

/**
 * Whether the daily triage takes this item up.
 *
 * @param item - An open item, normalized.
 * @param agent - The agent's account id, whose assignment does not count as a person's.
 * @returns `true` when it still needs a bucket, a project, or (a Must) its readying.
 */
export function needsTriage(
  item: Pick<WorkItem, 'stateCategory' | 'labels' | 'priority' | 'project' | 'assignee'>,
  agent?: string
): boolean {
  if (item.stateCategory !== 'backlog' && item.stateCategory !== 'unstarted') return false;
  if (item.labels.some((label) => label.startsWith('agent/'))) return false;
  if (item.assignee !== undefined && item.assignee !== agent) return false;
  const bucketed = item.priority !== undefined && item.priority >= 1 && item.priority <= 4;
  if (!bucketed || item.project === undefined) return true;
  if (item.labels.includes('type/meta')) return false;
  return item.priority === 1 || item.priority === 2;
}
