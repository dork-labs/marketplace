/**
 * `flow snapshot [--include-closed] [--out <file>]` (spec `flow-cli-core` §6):
 * one pull of the configured team's backlog through the adapter's
 * `getBacklogSnapshot`.
 *
 * - Human output: the item counts by state category and by label family.
 * - `--json`: the `BacklogSnapshot` itself.
 * - `--out <file>`: also writes that JSON to a file, for `--snapshot` reuse by
 *   `next`, `audit` and `status`, so one pull serves a whole drain tick.
 *
 * @module @dorkos/flow/cli/snapshot
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { requireCapabilities } from '../tracker/load.ts';
import type { BacklogSnapshot } from '../tracker/types.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';

/** The state categories in workflow order, so the summary always reads the same way. */
const STATE_ORDER = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];

/**
 * Count items per key, keeping first-seen order.
 *
 * @param keys - One key per item (or several, for labels).
 * @returns The counts.
 */
function countBy(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/**
 * Render the human summary: counts by state category, then by label family
 * (each family's leaves with their counts).
 *
 * @param snapshot - The pulled snapshot.
 * @param includeClosed - Whether closed titles were asked for.
 * @returns The text.
 */
export function renderSnapshotSummary(snapshot: BacklogSnapshot, includeClosed: boolean): string {
  const team = snapshot.team.key ?? snapshot.team.id ?? 'the configured team';
  const lines = [
    `Backlog of ${team} (${snapshot.tracker}), pulled ${snapshot.fetchedAt}`,
    `Open items: ${snapshot.items.length}`,
  ];

  const byState = countBy(snapshot.items.map((item) => item.stateCategory));
  const states = [...byState.keys()].sort(
    (a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b)
  );
  if (states.length > 0) {
    lines.push(
      '',
      'By state:',
      formatColumns(states.map((s) => [`  ${s}`, String(byState.get(s))]))
    );
  }

  const families = new Map<string, Map<string, number>>();
  for (const item of snapshot.items) {
    for (const label of item.labels) {
      const slash = label.indexOf('/');
      const family = slash === -1 ? '(no family)' : label.slice(0, slash);
      const leaf = slash === -1 ? label : label.slice(slash + 1);
      const leaves = families.get(family) ?? new Map<string, number>();
      leaves.set(leaf, (leaves.get(leaf) ?? 0) + 1);
      families.set(family, leaves);
    }
  }
  if (families.size > 0) {
    const rows = [...families.keys()].sort().map((family) => {
      const leaves = families.get(family) ?? new Map<string, number>();
      const text = [...leaves.keys()]
        .sort()
        .map((leaf) => `${leaf} ${leaves.get(leaf)}`)
        .join(', ');
      return [`  ${family}`, text];
    });
    lines.push('', 'By label family:', formatColumns(rows));
  }

  if (includeClosed) lines.push('', `Closed items: ${snapshot.closed.length}`);
  return lines.join('\n');
}

/**
 * Write the snapshot JSON to a file through a temp file and a rename, so a
 * reader never sees half of it.
 *
 * @param file - The absolute target path.
 * @param json - The JSON text.
 */
function writeSnapshotFile(file: string, json: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, json);
  renameSync(temp, file);
}

/**
 * Run `flow snapshot`.
 *
 * @param ctx - The verb's context.
 * @returns The snapshot as JSON, or its summary as text.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const includeClosed = ctx.args.flags['include-closed'] === true;
  const out = ctx.args.flags.out;

  const adapter = await ctx.adapter();
  requireCapabilities(adapter, ['getBacklogSnapshot']);
  const snapshot = await adapter.getBacklogSnapshot({ includeClosed });

  // `v` first, the same order `--json` prints, so the file equals the output.
  const { v, ...rest } = snapshot;
  const json = { v, ...rest };
  if (typeof out === 'string')
    writeSnapshotFile(path.resolve(ctx.cwd, out), `${JSON.stringify(json)}\n`);

  return {
    json: json as unknown as Record<string, unknown>,
    text: renderSnapshotSummary(snapshot, includeClosed),
  };
}
