/**
 * Confirm a tracker write landed (spec `flow-cli-core` §4): after every
 * `applyWorkState`, the CLI re-reads the item and exits 4 when the tracker
 * disagrees with the change. A write the tracker reported as done but did not
 * keep is the one failure the durable `agent/*` labels cannot recover from, so
 * it is caught here rather than trusted.
 *
 * Dependency-free: node builtins and zero-dependency local modules only.
 *
 * @module @dorkos/flow/tracker/verify-write
 */

import { TrackerError } from '../errors.ts';
import { AGENT_LABEL_PREFIX, STAGE_LABEL_PREFIX, type WorkStateChange } from '../work-state.ts';
import type { CodeAdapter, ItemWithComments, WorkItem } from './types.ts';

/**
 * The labels of one family, sorted, for comparison.
 *
 * @param labels - Every label on an item.
 * @param prefix - The family prefix (`agent/` or `stage/`).
 * @returns The family's labels, sorted.
 */
function family(labels: readonly string[], prefix: string): string[] {
  return labels.filter((label) => label.startsWith(prefix)).sort();
}

/**
 * Every way an item disagrees with a change: a wrong state category, or an
 * `agent/*` or `stage/*` family that is not exactly what the change set.
 *
 * @param item - The item as re-read after the write.
 * @param change - The change that was written.
 * @returns Plain sentences, one per disagreement; empty when the write landed.
 */
export function writeDisagreements(item: WorkItem, change: WorkStateChange): string[] {
  const problems: string[] = [];
  if (change.stateCategory !== undefined && item.stateCategory !== change.stateCategory) {
    problems.push(`its state is ${item.stateCategory}, not ${change.stateCategory}`);
  }
  const labels = Array.isArray(item.labels) ? item.labels : [];
  const families: [string, string, string | null | undefined][] = [
    ['agent/*', AGENT_LABEL_PREFIX, change.agentLabel],
    ['stage/*', STAGE_LABEL_PREFIX, change.stageLabel],
  ];
  for (const [name, prefix, wanted] of families) {
    if (wanted === undefined) continue;
    const actual = family(labels, prefix);
    const expected = wanted === null ? [] : [wanted];
    if (actual.join('\n') !== expected.join('\n')) {
      problems.push(
        `its ${name} labels are ${actual.length === 0 ? 'none' : actual.join(', ')}, not ${expected.length === 0 ? 'none' : expected.join(', ')}`
      );
    }
  }
  return problems;
}

/**
 * Re-read an item after a write and confirm the tracker kept the change.
 *
 * @param adapter - The adapter the write went through.
 * @param item - The item that was written.
 * @param change - The change that was written.
 * @returns The item as re-read.
 * @throws {TrackerError} When the re-read disagrees with the change.
 */
export async function verifyWrite(
  adapter: CodeAdapter,
  item: WorkItem,
  change: WorkStateChange
): Promise<ItemWithComments> {
  const reread = await adapter.getItem(item.identifier);
  const problems = writeDisagreements(reread, change);
  if (problems.length > 0) {
    throw new TrackerError(
      `the tracker did not keep the change to ${item.identifier}: ${problems.join('; ')}; run the command again, or check the item in the tracker`
    );
  }
  return reread;
}
