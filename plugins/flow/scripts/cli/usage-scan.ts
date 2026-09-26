/**
 * `flow usage scan` (spec `flow-usage` §2.4): recover past limit hits from the
 * conversation transcripts Claude Code keeps under each account's
 * `<path>/projects/`, and save the latest one per window to the account's usage
 * ledger.
 *
 * Only files changed in the last `--days` (default 8, one weekly window plus a
 * day) are read, unless `--all`. A line is parsed only when it contains the text
 * `"rate_limit"`, so throughput is bound by disk reads. Running it twice changes
 * nothing: the ledger's merge rule keeps a reading that is as new or newer.
 *
 * Dependency-free: node builtins and other zero-dependency local modules only.
 *
 * @module @dorkos/flow/cli/usage-scan
 */

import { createReadStream, existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PreconditionError, UsageError } from '../errors.ts';
import {
  loadAccounts,
  resolveAccountRef,
  resolveDorkHome,
  type RuntimeAccount,
} from '../fleet/accounts.ts';
import { fromTranscriptEntry } from '../fleet/observations.ts';
import {
  mergeLedger,
  readLedger,
  recordUsage,
  type FactObservation,
  type FleetWarning,
  type LedgerOwner,
  type UsageLedger,
  type UsageObservation,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { journalUsage } from './usage-journal.ts';

/** A Claude Code account with a config folder to read transcripts from. */
type ScannedAccount = RuntimeAccount & { path: string };

/** How many days of transcripts `scan` reads by default: one weekly window plus a day. */
export const DEFAULT_SCAN_DAYS = 8;

/** The text a line must contain before it is parsed. */
const PREFILTER = '"rate_limit"';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `scan` found for one account. */
export interface AccountScan {
  /** The account id. */
  id: string;
  /** Transcript files read. */
  files: number;
  /** Limit hits recorded or recordable (a window was named). */
  hits: number;
  /** Limit hits that named no window (a model limit), never recorded. */
  unidentified: number;
  /** The latest observation per window key. */
  observations: UsageObservation[];
  /** The window keys whose stored reading this scan replaced (or would, with `--dry-run`). */
  changed: string[];
  /** True when the write was given up because the usage file stayed locked. */
  dropped: boolean;
}

/**
 * Parse `--days` and `--all` into a day count or `'all'`.
 *
 * @param ctx - The verb context.
 * @returns The number of days to read, or `'all'`.
 * @throws {UsageError} For a bad `--days`, or `--days` with `--all`.
 */
export function readDays(ctx: VerbContext): number | 'all' {
  const days = ctx.args.flags.days;
  const all = ctx.args.flags.all === true;
  if (all && days !== undefined) throw new UsageError('use --days or --all, not both');
  if (all) return 'all';
  if (days === undefined) return DEFAULT_SCAN_DAYS;
  if (typeof days !== 'string' || !/^[1-9]\d*$/.test(days)) {
    throw new UsageError(`--days needs a whole number of days, 1 or more (got "${String(days)}")`);
  }
  return Number(days);
}

/**
 * The accounts to scan: `--account` (`default` resolves to the row it aliases),
 * or every Claude Code account with a valid id, and the standalone `default`
 * when its folder exists on this machine.
 */
function targets(ctx: VerbContext, accounts: readonly RuntimeAccount[]): ScannedAccount[] {
  const scannable = accounts.flatMap((account): ScannedAccount[] =>
    account.runtime === 'claude-code' &&
    account.routable &&
    account.path !== null &&
    (!account.implicit || existsSync(account.path))
      ? [{ ...account, path: account.path }]
      : []
  );
  const flag = ctx.args.flags.account;
  if (typeof flag !== 'string') return scannable;
  const match = resolveAccountRef(scannable, 'claude-code', flag);
  if (match === null) {
    throw new PreconditionError(
      `no registered account "${flag}" with a valid id; "flow fleet" lists the accounts`
    );
  }
  return [match];
}

/**
 * Every file under `dir`, recursively, whose name `keep` accepts (default: any
 * `*.jsonl`) and that changed at or after `sinceMs`. Symlinks are never
 * followed. A folder that cannot be read is a warning; a missing one is empty.
 *
 * @param dir - The folder to walk.
 * @param sinceMs - The oldest mtime to keep (epoch ms), or `null` for every file.
 * @param warn - Receives a warning for each folder that could not be read.
 * @param keep - Which file names to keep.
 * @returns The files, in name order within each folder.
 */
export async function transcriptFiles(
  dir: string,
  sinceMs: number | null,
  warn: (warning: FleetWarning) => void,
  keep: (name: string) => boolean = (name) => name.endsWith('.jsonl')
): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warn({ code: 'dir-unreadable', message: `could not read ${dir} (${code}); skipped it.` });
    }
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await transcriptFiles(full, sinceMs, warn, keep)));
    } else if (entry.isFile() && keep(entry.name)) {
      if (sinceMs !== null) {
        try {
          if ((await fsp.lstat(full)).mtimeMs < sinceMs) continue;
        } catch {
          continue;
        }
      }
      files.push(full);
    }
  }
  return files;
}

/**
 * Stream one JSONL file and hand each parsed line that contains `prefilter` to
 * `onEntry`. A line that is not JSON is a warning, and reading goes on.
 *
 * @param file - The file to read.
 * @param onEntry - Receives each parsed candidate line.
 * @param warn - Receives a warning per unparsable line or unreadable file.
 * @param prefilter - The text a line must contain before it is parsed.
 * @returns False (with a warning) when the file could not be read.
 */
export async function scanFile(
  file: string,
  onEntry: (entry: unknown) => void,
  warn: (warning: FleetWarning) => void,
  prefilter: string = PREFILTER
): Promise<boolean> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo += 1;
      if (!line.includes(prefilter)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        warn({
          code: 'line-unparsable',
          message: `${file} line ${lineNo} is not JSON; skipped it.`,
        });
        continue;
      }
      onEntry(entry);
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    warn({ code: 'file-unreadable', message: `could not read ${file} (${code}); skipped it.` });
    return false;
  } finally {
    lines.close();
  }
}

/**
 * The name of what an observation updates: its window key, or its fact kind
 * (`plan`, `credits`, `spend`).
 *
 * @param observation - A window or fact observation.
 * @returns The key or kind.
 */
export function observationLabel(observation: UsageObservation | FactObservation): string {
  return 'key' in observation ? observation.key : observation.kind;
}

/**
 * The window keys (and fact kinds) a merge of `observations` into `before` would
 * replace. Each is checked on its own with the ledger's own merge rule, so the
 * answer matches what the writer does.
 *
 * @param before - The stored ledger, or `null`.
 * @param observations - The observations about to be written.
 * @param now - The merge time.
 * @param owner - The runtime and account the ledger belongs to.
 * @returns The labels ({@link observationLabel}) that would change.
 */
export function predictChanged(
  before: UsageLedger | null,
  observations: readonly (UsageObservation | FactObservation)[],
  now: Date,
  owner: LedgerOwner
): string[] {
  return observations
    .filter((observation) => {
      const merged = mergeLedger(before, [observation], now, owner);
      if (!merged.changed) return false;
      const after = merged.ledger as UsageLedger;
      if ('key' in observation) {
        return after.windows[observation.key] !== before?.windows[observation.key];
      }
      return after[observation.kind] !== before?.[observation.kind];
    })
    .map(observationLabel);
}

/** Scan one account's transcripts and, unless a dry run, save what they show. */
async function scanAccount(
  ctx: VerbContext,
  dorkHome: string,
  account: ScannedAccount,
  sinceMs: number | null,
  warn: (warning: FleetWarning) => void
): Promise<AccountScan> {
  const latest = new Map<string, UsageObservation>();
  let hits = 0;
  let unidentified = 0;
  let files = 0;
  const onEntry = (entry: unknown) => {
    const finding = fromTranscriptEntry(entry);
    if (finding === null) return;
    if (finding.kind === 'unidentified') {
      unidentified += 1;
      return;
    }
    hits += 1;
    const { observation } = finding;
    const kept = latest.get(observation.key);
    if (kept === undefined || Date.parse(observation.observedAt) > Date.parse(kept.observedAt)) {
      latest.set(observation.key, observation);
    }
  };
  for (const file of await transcriptFiles(path.join(account.path, 'projects'), sinceMs, warn)) {
    if (await scanFile(file, onEntry, warn)) files += 1;
  }

  const observations = [...latest.values()].sort((a, b) => a.key.localeCompare(b.key));
  const now = ctx.now();
  const before = readLedger(dorkHome, 'claude-code', account.id).ledger;
  let changed = predictChanged(before, observations, now, {
    runtime: 'claude-code',
    accountId: account.id,
  });
  let dropped = false;
  if (!ctx.dryRun && observations.length > 0) {
    const result = await recordUsage(dorkHome, 'claude-code', account.id, observations, now);
    for (const warning of result.warnings) warn(warning);
    dropped = result.status === 'dropped';
    if (result.status !== 'written') changed = [];
  }
  return { id: account.id, files, hits, unidentified, observations, changed, dropped };
}

/**
 * A reset time in the reader's local time, or a note that it is unknown.
 *
 * @param iso - A UTC ISO time, or `null`.
 * @returns Human text.
 */
export function localTime(iso: string | null): string {
  if (iso === null) return 'an unknown time';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** The human text for one account. */
function renderAccount(scan: AccountScan, dryRun: boolean): string {
  const lines = [
    `${scan.id}: ${scan.files} ${scan.files === 1 ? 'file' : 'files'} read, ${scan.hits} ${scan.hits === 1 ? 'hit' : 'hits'}, ${scan.unidentified} unidentified`,
  ];
  for (const observation of scan.observations) {
    const verb = dryRun ? 'would record' : 'recorded';
    const state = scan.dropped
      ? 'not saved (the usage file stayed locked; run scan again)'
      : scan.changed.includes(observation.key)
        ? `${verb} (limited until ${localTime(observation.resetsAt ?? null)})`
        : 'unchanged (a newer reading is stored)';
    lines.push(`  ${observation.key}  ${state}`);
  }
  return lines.join('\n');
}

/**
 * Run `flow usage scan`.
 *
 * @param ctx - The verb context.
 * @returns Per account: files read, hits, unidentified hits, the latest
 *   observation per window and which windows changed; plus every warning.
 * @throws {UsageError} For a bad `--days`, or `--days` with `--all`.
 * @throws {PreconditionError} When `--account` names no registered account.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const days = readDays(ctx);
  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  const identities = loadAccounts(dorkHome, { home: ctx.io.osHome });
  const accounts = targets(ctx, identities.accounts);
  const sinceMs = days === 'all' ? null : ctx.now().getTime() - days * DAY_MS;

  const warnings: FleetWarning[] = [];
  const warn = (warning: FleetWarning) => {
    warnings.push(warning);
    ctx.warn(warning.message);
  };
  for (const warning of identities.warnings) warn(warning);

  const scans: AccountScan[] = [];
  for (const account of accounts) {
    scans.push(await scanAccount(ctx, dorkHome, account, sinceMs, warn));
  }

  const text =
    scans.length === 0
      ? 'No registered accounts to scan.'
      : [
          ...(ctx.dryRun ? ['Dry run: nothing was saved.'] : []),
          ...scans.map((scan) => renderAccount(scan, ctx.dryRun)),
        ].join('\n');
  if (!ctx.dryRun) {
    journalUsage(
      ctx,
      dorkHome,
      scans.map((scan) => ({ runtime: 'claude-code', id: scan.id }))
    );
  }
  return { json: { runtime: 'claude-code', days, accounts: scans, warnings }, text };
}
