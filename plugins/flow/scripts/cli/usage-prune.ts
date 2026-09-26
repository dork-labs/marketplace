/**
 * `flow usage prune` (spec `flow-usage` Amendment 1, A6; `flow-cli-core` §1.2
 * "Removing an account"): list the usage files nobody needs, and delete them
 * only with `--yes`.
 *
 * In each `<dorkHome>/runtimes/<runtime>/usage/` it lists:
 *
 * - `<id>.json` and `<id>.json.corrupt-*` whose `<id>` is not a known account
 *   of that runtime (a registered, routable id; `default` while `default`
 *   stands alone, rev 6d). A known account's `<id>.json` never goes.
 * - `*.tmp`, `*.lock` and `*.lock.stale-*` more than 1 hour old. A younger one
 *   may belong to a write in progress.
 *
 * In the pre-rev-6 `<dorkHome>/usage/` it lists every `*.json`, and
 * `.statusline-*` and `*.corrupt-*` files by the same 1-hour rule.
 *
 * It skips a runtime whose `runtimes.<key>.accounts` is in `config.json` while
 * flow does not record for that runtime yet: its files may be DorkOS's. It
 * refuses everything when `config.json` cannot be read in full, since then
 * every account would look unregistered.
 *
 * Without `--yes` it lists and exits 0 (`--dry-run` is accepted and means the
 * same). With `--yes` it re-checks each file's rule right before deleting it,
 * and a ledger is deleted under its lock, so a writer merging at that moment
 * finishes first or starts after.
 *
 * Dependency-free: node builtins and local zero-dependency modules only.
 *
 * @module @dorkos/flow/cli/usage-prune
 */

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.ts';
import { loadAccounts, resolveDorkHome, type AccountEnvironment } from '../fleet/accounts.ts';
import {
  RUNTIMES,
  isValidAccountId,
  ledgerDir,
  removeLedger,
  type RuntimeSlug,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** A leftover younger than this may belong to a write in progress. */
export const PRUNE_MIN_AGE_MS = 60 * 60 * 1000;

/** Why a file is listed. */
type PruneReason = 'unregistered' | 'leftover' | 'legacy';

/** What happened to one listed file. */
type PruneStatus = 'listed' | 'removed' | 'missing' | 'dropped' | 'kept';

/** One file `prune` listed. */
interface PruneEntry {
  /** The runtime folder it is in, or `legacy` for `<dorkHome>/usage/`. */
  runtime: RuntimeSlug | 'legacy';
  /** The file's absolute path. */
  file: string;
  /** Why it is listed. */
  reason: PruneReason;
  /** The account id, for a ledger or its corrupt backup. */
  accountId?: string;
  /** `listed` without `--yes`; else what deleting it did (`kept` when the re-check failed). */
  status: PruneStatus;
}

/** The ledger id a name belongs to: `<id>.json` or `<id>.json.corrupt-*`. */
function ledgerIdOf(name: string): { id: string; corrupt: boolean } | null {
  const corrupt = name.match(/^(.+)\.json\.corrupt-.+$/);
  if (corrupt !== null)
    return isValidAccountId(corrupt[1]) ? { id: corrupt[1], corrupt: true } : null;
  if (!name.endsWith('.json')) return null;
  const id = name.slice(0, -'.json'.length);
  return isValidAccountId(id) ? { id, corrupt: false } : null;
}

/** Whether a name is a temp or lock file of the shared writer. */
function isLeftover(name: string): boolean {
  return name.endsWith('.tmp') || name.endsWith('.lock') || /\.lock\.stale-[^/]+$/.test(name);
}

/** A regular file's age in ms, or `null` when it is missing or not a regular file. */
function ageMs(file: string, nowMs: number): number | null {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? nowMs - stat.mtimeMs : null;
  } catch {
    return null;
  }
}

/** The file names in a folder; none when it is missing. */
function names(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Each runtime's ledger ids (spec §1.1a rev 6d), or `null` when `config.json`
 * cannot be read in full. An aliased `default` is its row's id, so that file is
 * kept and a leftover `default.json` (a second reading of the same account) is
 * not; a `default` that stands alone keeps `default.json`.
 */
function knownIds(
  dorkHome: string,
  environment: AccountEnvironment
): Record<RuntimeSlug, Set<string>> | null {
  const registry = loadAccounts(dorkHome, environment);
  if (!registry.registryReadable) return null;
  const known = {} as Record<RuntimeSlug, Set<string>>;
  for (const runtime of RUNTIMES) {
    known[runtime] = new Set(
      registry.accounts.flatMap((account) =>
        account.runtime === runtime && account.ledgerId !== null ? [account.ledgerId] : []
      )
    );
  }
  return known;
}

/**
 * Whether one file in a runtime's usage folder is listed, and why.
 *
 * @returns The reason and account id, or `null` when it stays.
 */
function classifyRuntimeFile(
  name: string,
  file: string,
  known: ReadonlySet<string>,
  nowMs: number
): { reason: PruneReason; accountId?: string } | null {
  const ledger = ledgerIdOf(name);
  if (ledger !== null) {
    if (known.has(ledger.id)) return null;
    return ageMs(file, nowMs) === null ? null : { reason: 'unregistered', accountId: ledger.id };
  }
  if (isLeftover(name)) {
    const age = ageMs(file, nowMs);
    return age !== null && age > PRUNE_MIN_AGE_MS ? { reason: 'leftover' } : null;
  }
  return null;
}

/** Whether one file in the legacy `<dorkHome>/usage/` folder is listed. */
function classifyLegacyFile(name: string, file: string, nowMs: number): boolean {
  const age = ageMs(file, nowMs);
  if (age === null) return false;
  if (name.endsWith('.json')) return true;
  if (name.startsWith('.statusline-') || /\.corrupt-[^/]+$/.test(name)) {
    return age > PRUNE_MIN_AGE_MS;
  }
  return false;
}

/** Everything `prune` would delete right now. */
function plan(
  dorkHome: string,
  environment: AccountEnvironment,
  nowMs: number
): { entries: PruneEntry[] } | null {
  const known = knownIds(dorkHome, environment);
  if (known === null) return null;
  const entries: PruneEntry[] = [];
  for (const runtime of RUNTIMES) {
    const dir = ledgerDir(dorkHome, runtime);
    for (const name of names(dir)) {
      const file = path.join(dir, name);
      const hit = classifyRuntimeFile(name, file, known[runtime], nowMs);
      if (hit !== null) entries.push({ runtime, file, ...hit, status: 'listed' });
    }
  }
  const legacy = path.join(dorkHome, 'usage');
  for (const name of names(legacy)) {
    const file = path.join(legacy, name);
    if (classifyLegacyFile(name, file, nowMs)) {
      entries.push({ runtime: 'legacy', file, reason: 'legacy', status: 'listed' });
    }
  }
  return { entries };
}

/** Whether `entry`'s rule still holds right now (the `--yes` re-check). */
function stillListed(
  entry: PruneEntry,
  dorkHome: string,
  environment: AccountEnvironment,
  nowMs: number
): boolean {
  const name = path.basename(entry.file);
  if (entry.runtime === 'legacy') return classifyLegacyFile(name, entry.file, nowMs);
  const known = knownIds(dorkHome, environment);
  if (known === null) return false;
  return classifyRuntimeFile(name, entry.file, known[entry.runtime], nowMs) !== null;
}

/** Delete one listed file after re-checking its rule. */
async function remove(
  entry: PruneEntry,
  dorkHome: string,
  environment: AccountEnvironment,
  nowMs: number
): Promise<PruneStatus> {
  if (!stillListed(entry, dorkHome, environment, nowMs)) return 'kept';
  const name = path.basename(entry.file);
  if (entry.runtime !== 'legacy' && entry.accountId !== undefined && name.endsWith('.json')) {
    return (await removeLedger(dorkHome, entry.runtime, entry.accountId)).status;
  }
  try {
    rmSync(entry.file);
    return 'removed';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Why a file is listed, for people. */
function because(entry: PruneEntry): string {
  if (entry.reason === 'unregistered') {
    return `${entry.runtime}:${entry.accountId} is not a known account`;
  }
  if (entry.reason === 'leftover') return 'a leftover from a write, over an hour old';
  return 'from an older version of flow';
}

/**
 * Run `flow usage prune`.
 *
 * @param ctx - The verb context.
 * @returns What was listed, and with `--yes` what deleting each file did.
 * @throws {ConfigError} When `config.json` cannot be read in full (exit 3).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const apply = ctx.args.flags.yes === true && !ctx.dryRun;
  const environment: AccountEnvironment = { home: ctx.io.osHome };
  const planned = plan(dorkHome, environment, ctx.now().getTime());
  if (planned === null) {
    throw new ConfigError(
      `${dorkHome}/config.json could not be read in full, so every account would look unregistered; nothing was removed. Fix the file, then retry.`
    );
  }
  const { entries } = planned;
  if (apply) {
    for (const entry of entries) {
      // A fresh clock and a fresh read of config.json for each re-check.
      entry.status = await remove(entry, dorkHome, environment, ctx.now().getTime());
      if (entry.status === 'dropped') ctx.warn(`${entry.file} stayed locked; run prune again.`);
    }
  }

  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push('Nothing to remove.');
  } else {
    for (const entry of entries) {
      const verb = {
        listed: 'Would remove',
        removed: 'Removed',
        missing: 'Already gone:',
        dropped: 'Could not remove (locked, retry)',
        kept: 'Kept (it changed since it was listed)',
      }[entry.status];
      lines.push(`${verb} ${entry.file} (${because(entry)}).`);
    }
    if (!apply) lines.push('Nothing was removed. Run again with --yes to remove these.');
  }
  return {
    json: { ok: true, applied: apply, dorkHome, files: entries },
    text: lines.join('\n'),
  };
}
