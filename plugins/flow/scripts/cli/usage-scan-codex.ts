/**
 * `flow usage scan --runtime codex` (spec `flow-usage` Amendment 1, A2):
 * recover the latest Codex usage from the session logs under each Codex
 * account's `sessions/` and `archived_sessions/`, and save it to the account's
 * usage ledger.
 *
 * Only `rollout-*.jsonl` files changed in the last `--days` (default 8) are
 * read, unless `--all`; symlinks are never followed. A line is parsed only when
 * it contains the text `"rate_limits"`. The contract's `codexObservations` maps
 * each reading; the newest per window (and per plan and credits) wins, and each
 * account gets one ledger write. Running it twice changes nothing.
 *
 * Dependency-free: node builtins and other zero-dependency local modules only.
 *
 * @module @dorkos/flow/cli/usage-scan-codex
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { PreconditionError } from '../errors.ts';
import { resolveAccountRef, resolveDorkHome } from '../fleet/accounts.ts';
import {
  codexAccounts,
  isRolloutFile,
  rolloutReading,
  type CodexAccount,
} from '../fleet/codex-accounts.ts';
import {
  codexObservations,
  readLedger,
  recordUsage,
  type FactObservation,
  type FleetWarning,
  type UsageObservation,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { journalUsage } from './usage-journal.ts';
import {
  localTime,
  observationLabel,
  predictChanged,
  readDays,
  scanFile,
  transcriptFiles,
} from './usage-scan.ts';

/** The text a line must contain before it is parsed. */
const PREFILTER = '"rate_limits"';

/** The folders under a Codex home that hold session logs. */
const SESSION_DIRS = ['sessions', 'archived_sessions'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One observation of a Codex scan: a window reading or a plan or credits fact. */
type CodexObservation = UsageObservation | FactObservation;

/** What `scan --runtime codex` found for one account. */
export interface CodexAccountScan {
  /** The account id. */
  id: string;
  /** The Codex home read. */
  home: string;
  /** Rollout files read. */
  files: number;
  /** Usage readings found (one per `token_count` event with `rate_limits`). */
  readings: number;
  /** The newest observation per window key and fact kind. */
  observations: CodexObservation[];
  /** The keys (and kinds) whose stored entry this scan replaced (or would, with `--dry-run`). */
  changed: string[];
  /** True when the write was given up because the usage file stayed locked. */
  dropped: boolean;
}

/**
 * The accounts to scan: `--account` (`default` resolves to the row it aliases),
 * or every Codex account, the standalone `default` only when its folder exists.
 */
function targets(ctx: VerbContext, accounts: readonly CodexAccount[]): CodexAccount[] {
  const flag = ctx.args.flags.account;
  if (typeof flag !== 'string') {
    return accounts.filter((account) => !account.implicit || existsSync(account.home));
  }
  const match = resolveAccountRef(accounts, 'codex', flag);
  if (match === null) {
    throw new PreconditionError(`no Codex account "${flag}"; "flow fleet" lists the accounts`);
  }
  return [match];
}

/** Scan one account's session logs and, unless a dry run, save what they show. */
async function scanAccount(
  ctx: VerbContext,
  dorkHome: string,
  account: CodexAccount,
  sinceMs: number | null,
  warn: (warning: FleetWarning) => void
): Promise<CodexAccountScan> {
  const latest = new Map<string, CodexObservation>();
  let readings = 0;
  let files = 0;
  const onEntry = (entry: unknown) => {
    const reading = rolloutReading(entry);
    if (reading === null) return;
    readings += 1;
    for (const observation of codexObservations(reading.rateLimits, reading.observedAt)) {
      const label = observationLabel(observation);
      const kept = latest.get(label);
      if (kept === undefined || Date.parse(observation.observedAt) > Date.parse(kept.observedAt)) {
        latest.set(label, observation);
      }
    }
  };
  for (const dir of SESSION_DIRS) {
    const found = await transcriptFiles(path.join(account.home, dir), sinceMs, warn, isRolloutFile);
    for (const file of found) {
      if (await scanFile(file, onEntry, warn, PREFILTER)) files += 1;
    }
  }

  const observations = [...latest.values()].sort((a, b) =>
    observationLabel(a).localeCompare(observationLabel(b))
  );
  const now = ctx.now();
  const owner = { runtime: 'codex' as const, accountId: account.id };
  const before = readLedger(dorkHome, 'codex', account.id).ledger;
  let changed = predictChanged(before, observations, now, owner);
  let dropped = false;
  if (!ctx.dryRun && observations.length > 0) {
    const result = await recordUsage(dorkHome, 'codex', account.id, observations, now);
    for (const warning of result.warnings) warn(warning);
    dropped = result.status === 'dropped';
    if (result.status !== 'written') changed = [];
  }
  return {
    id: account.id,
    home: account.home,
    files,
    readings,
    observations,
    changed,
    dropped,
  };
}

/** What one observation says, for people. */
function describe(observation: CodexObservation): string {
  if ('key' in observation) {
    const used =
      observation.usedPct === null || observation.usedPct === undefined ? '?' : observation.usedPct;
    return `${used}% used, resets ${localTime(observation.resetsAt ?? null)}`;
  }
  if (observation.kind === 'plan') return observation.name;
  if (observation.kind === 'credits') {
    if (observation.unlimited) return 'unlimited';
    return observation.hasCredits ? `balance ${observation.balance ?? 'unknown'}` : 'none';
  }
  return `$${observation.costUsd.toFixed(2)}`;
}

/** The human text for one account. */
function renderAccount(scan: CodexAccountScan, dryRun: boolean): string {
  const lines = [
    `${scan.id}: ${scan.files} ${scan.files === 1 ? 'file' : 'files'} read, ${scan.readings} ${scan.readings === 1 ? 'reading' : 'readings'}`,
  ];
  for (const observation of scan.observations) {
    const label = observationLabel(observation);
    const verb = dryRun ? 'would record' : 'recorded';
    const state = scan.dropped
      ? 'not saved (the usage file stayed locked; run scan again)'
      : scan.changed.includes(label)
        ? `${verb} (${describe(observation)})`
        : 'unchanged (a newer reading is stored)';
    lines.push(`  ${label}  ${state}`);
  }
  return lines.join('\n');
}

/**
 * Run `flow usage scan --runtime codex`.
 *
 * @param ctx - The verb context.
 * @returns Per account: files read, readings found, the newest observation per
 *   key and which keys changed; plus every warning.
 * @throws {UsageError} For a bad `--days`, or `--days` with `--all`.
 * @throws {PreconditionError} When `--account` names no Codex account.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const days = readDays(ctx);
  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  const registry = codexAccounts(dorkHome, { env: ctx.env, home: ctx.io.osHome });
  const accounts = targets(ctx, registry.accounts);
  const sinceMs = days === 'all' ? null : ctx.now().getTime() - days * DAY_MS;

  const warnings: FleetWarning[] = [];
  const warn = (warning: FleetWarning) => {
    warnings.push(warning);
    ctx.warn(warning.message);
  };
  for (const warning of registry.warnings) warn(warning);

  const scans: CodexAccountScan[] = [];
  for (const account of accounts) {
    scans.push(await scanAccount(ctx, dorkHome, account, sinceMs, warn));
  }
  const text = [
    ...(ctx.dryRun ? ['Dry run: nothing was saved.'] : []),
    ...scans.map((scan) => renderAccount(scan, ctx.dryRun)),
  ].join('\n');
  if (!ctx.dryRun) {
    journalUsage(
      ctx,
      dorkHome,
      scans.map((scan) => ({ runtime: 'codex', id: scan.id }))
    );
  }
  return { json: { runtime: 'codex', days, accounts: scans, warnings }, text };
}
