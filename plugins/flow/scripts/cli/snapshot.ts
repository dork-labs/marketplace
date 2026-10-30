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

import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { UsageError } from '../errors.ts';
import { ensureIgnored } from '../git-exclude.ts';
import { sourceKey, updateIntakeMarks } from '../intake.ts';
import { resolveMainCheckout } from '../main-checkout.ts';
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
 * Refuse an `--out` target that is not a snapshot file. Commands allow
 * `flow <verb>` without asking, so `--out` must not become a way to overwrite
 * any file (a shell profile, a settings file) with tracker text: the target
 * ends in `.json`, is not a symlink, and, when it exists, is already a flow
 * snapshot (a JSON object with `v` and an `items` array).
 *
 * @param file - The absolute target path.
 * @throws {UsageError} When the target is anything else.
 */
function checkSnapshotTarget(file: string): void {
  if (!file.endsWith('.json')) {
    throw new UsageError(`--out must name a .json file, got ${file}`);
  }
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return; // A new file.
  }
  if (!stat.isFile()) {
    throw new UsageError(`--out must name a plain file, not a link or folder: ${file}`);
  }
  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    existing = undefined;
  }
  const isSnapshot =
    typeof existing === 'object' &&
    existing !== null &&
    'v' in existing &&
    Array.isArray((existing as { items?: unknown }).items);
  if (!isSnapshot) {
    throw new UsageError(
      `--out will only replace an earlier flow snapshot, and ${file} is not one. Pick a new file.`
    );
  }
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
 * Record that the configured team was read (DOR-3259), so `flow status` can say
 * when. A mark that cannot be written only warns: the snapshot still prints.
 *
 * @param ctx - The verb's context.
 * @param snapshot - The pulled snapshot.
 */
function markTeamRead(ctx: VerbContext, snapshot: BacklogSnapshot): void {
  const ids = [snapshot.team.key, snapshot.team.id].filter(
    (id): id is string => typeof id === 'string' && id !== ''
  );
  if (ids.length === 0) return;
  try {
    const main = resolveMainCheckout(ctx.projectDir);
    const at = ctx.now().toISOString();
    updateIntakeMarks(main, (marks) => {
      for (const id of ids) {
        const key = sourceKey({ kind: 'tracker', id });
        marks.sources[key] = { ...marks.sources[key], lastReadAt: at };
      }
    });
    ensureIgnored(main, '.dork/flow/intake.json', '.dork/flow/');
  } catch (error) {
    ctx.warn(`flow could not record this read of the team: ${(error as Error).message}`);
  }
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
  const target = typeof out === 'string' ? path.resolve(ctx.cwd, out) : undefined;
  if (target !== undefined) checkSnapshotTarget(target);

  const adapter = await ctx.adapter();
  requireCapabilities(adapter, ['getBacklogSnapshot']);
  const snapshot = await adapter.getBacklogSnapshot({ includeClosed });

  // `v` first, the same order `--json` prints, so the file equals the output.
  markTeamRead(ctx, snapshot);

  const { v, ...rest } = snapshot;
  const json = { v, ...rest };
  if (target !== undefined) {
    // Groom keeps its snapshot in .dork/flow/tmp/groom/: keep flow's folder out of git.
    const rel = path.relative(ctx.cwd, target);
    if (rel.split(path.sep).slice(0, 2).join('/') === '.dork/flow') {
      ensureIgnored(ctx.cwd, rel, '.dork/flow/');
    }
    writeSnapshotFile(target, `${JSON.stringify(json)}\n`);
  }

  return {
    json: json as unknown as Record<string, unknown>,
    text: renderSnapshotSummary(snapshot, includeClosed),
  };
}
