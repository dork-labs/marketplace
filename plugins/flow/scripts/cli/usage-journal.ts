/**
 * Sampled `usage.snapshot` journal lines (spec `flow-usage` Amendment 1 A7,
 * fleet decision R8): the ledger keeps only each account's latest reading, and
 * the flow journal keeps a sampled history of it for `flow retro`'s trends.
 *
 * `flow usage scan`, `flow usage probe` and `flow usage snapshot` call
 * {@link journalUsage}. `flow usage record` never does: the status-line path
 * stays free of project config and npm packages.
 *
 * A line is written only when the journal's own rule says so
 * ({@link shouldSampleUsage}: the account's first line, 30 minutes since its
 * last one, a window that moved 5 points, appeared, disappeared or reset).
 * Outside a flow project, or with the journal off, nothing is written and
 * nothing is said. Journaling never fails the verb that asked for it.
 *
 * @module @dorkos/flow/cli/usage-journal
 */

import { flowVersion } from '../_shared.ts';
import { findConfigRoots } from '../config-files.ts';
import {
  append,
  journalFor,
  read,
  runtimeOf,
  shouldSampleUsage,
  USAGE_WINDOWS_MAX,
  type JournalEvent,
  type UsageWindowReading,
} from '../journal.ts';
import {
  isErrorWindowKey,
  readLedger,
  readPlan,
  readSpend,
  readWindow,
  type RuntimeSlug,
  type UsageLedger,
} from '../fleet/usage-ledger.ts';
import type { VerbContext } from './context.ts';

/** How far back the last snapshot of an account is looked for (spans rotated files). */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Windows that go first when an account has more than the journal's cap. */
const FIRST_WINDOWS = ['five_hour', 'seven_day'];

/** One account to journal. */
export interface UsageTarget {
  /** The runtime the account belongs to. */
  runtime: RuntimeSlug;
  /** The account id: a ledger id, `default` for a standalone default account. */
  id: string;
}

/** What {@link journalUsage} did. */
export interface JournalUsageOutcome {
  /** The journal file, or `null` when there is no flow project or the journal is off. */
  journal: string | null;
  /** `<runtime>:<id>` of each account a line was written for. */
  written: string[];
  /** `<runtime>:<id>` of each account left out (no reading, or not due for a sample). */
  skipped: string[];
}

/**
 * The `usage.snapshot` event for one account's ledger: every window with a
 * current reading (five_hour and seven_day first, at most the journal's cap),
 * the plan, and the spend. `null` when the account has nothing to report.
 *
 * @param target - The account.
 * @param ledger - Its ledger, or `null`.
 * @param now - The moment readings are judged at.
 * @returns The event, or `null`.
 */
export function snapshotEvent(
  target: UsageTarget,
  ledger: UsageLedger | null,
  now: Date
): JournalEvent | null {
  if (ledger === null) return null;
  const keys = Object.keys(ledger.windows).sort((a, b) => {
    const rank = (key: string) =>
      FIRST_WINDOWS.includes(key) ? FIRST_WINDOWS.indexOf(key) : FIRST_WINDOWS.length;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const windows: Record<string, UsageWindowReading> = {};
  for (const key of keys) {
    if (Object.keys(windows).length >= USAGE_WINDOWS_MAX) break;
    // An error key has no percent and the journal line keeps no status, so it
    // would say nothing and take a slot under the window cap.
    if (isErrorWindowKey(key)) continue;
    const reading = readWindow(ledger.windows[key], now, key);
    if (reading === null) continue;
    windows[key] = { usedPct: reading.usedPct, resetsAt: reading.resetsAt };
  }
  const plan = readPlan(ledger.plan);
  const spend = readSpend(ledger.spend);
  if (Object.keys(windows).length === 0 && spend === null) return null;
  return {
    kind: 'usage.snapshot',
    accountRuntime: target.runtime,
    account: target.id,
    windows,
    ...(plan !== null ? { plan: plan.name } : {}),
    ...(spend !== null
      ? {
          spend: {
            costUsd: spend.costUsd,
            periodStart: spend.periodStart,
            ...(spend.limitUsd !== null ? { limitUsd: spend.limitUsd } : {}),
          },
        }
      : {}),
  } as JournalEvent;
}

/**
 * Write a sampled `usage.snapshot` line for each target whose ledger is due one.
 * Silent outside a flow project or with the journal off; a failure becomes one
 * warning, never an error.
 *
 * @param ctx - The verb context (project, flow root, env, clock, warnings).
 * @param dorkHome - The resolved DorkOS home.
 * @param targets - The accounts to consider.
 * @returns What was written.
 */
export function journalUsage(
  ctx: Pick<VerbContext, 'projectDir' | 'flowRoot' | 'env' | 'now' | 'sessionId' | 'warn'>,
  dorkHome: string,
  targets: readonly UsageTarget[]
): JournalUsageOutcome {
  const outcome: JournalUsageOutcome = { journal: null, written: [], skipped: [] };
  let found;
  try {
    // A folder outside git is no flow project: a usage verb run there must not
    // create .dork/flow in it.
    if (!findConfigRoots(ctx.projectDir, ctx.flowRoot).inGit) return outcome;
    found = journalFor(ctx.projectDir, ctx.flowRoot);
  } catch {
    return outcome;
  }
  if ('refusal' in found || !found.settings.enabled) return outcome;
  const settings = found.settings;
  outcome.journal = settings.path;
  const now = ctx.now();

  // The account's LAST snapshot in file order (the journal's own rule), keyed
  // `<runtime>:<id>`.
  const last = new Map<string, { ts: string; windows: Record<string, UsageWindowReading> }>();
  try {
    for (const line of read(settings, new Date(now.getTime() - LOOKBACK_MS)).lines) {
      if (line.kind !== 'usage.snapshot') continue;
      last.set(`${line.accountRuntime}:${line.account}`, {
        ts: line.ts,
        windows: line.windows as Record<string, UsageWindowReading>,
      });
    }
  } catch {
    // An unreadable journal means no earlier sample is known: sampling then writes.
  }

  for (const target of targets) {
    const key = `${target.runtime}:${target.id}`;
    const event = snapshotEvent(
      target,
      readLedger(dorkHome, target.runtime, target.id).ledger,
      now
    );
    if (
      event === null ||
      event.kind !== 'usage.snapshot' ||
      !shouldSampleUsage(last.get(key), event.windows as Record<string, UsageWindowReading>, now)
    ) {
      outcome.skipped.push(key);
      continue;
    }
    const written = append(settings, event, {
      now,
      flowVersion: flowVersion(ctx.flowRoot),
      session: ctx.sessionId,
      ...runtimeOf(ctx.env),
      warn: ctx.warn,
    });
    if (written === 'written') outcome.written.push(key);
    else outcome.skipped.push(key);
  }
  return outcome;
}
