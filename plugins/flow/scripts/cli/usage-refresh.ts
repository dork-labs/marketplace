/**
 * The drain's stale-reading refresh (DOR-3704). An account whose weekly reading
 * is over a day old is kept out of ranking (`stale-usage`, DOR-3263). Before
 * ranking, `flow drain` gives each Claude Code account kept out for that reason
 * alone, other than the owner's main sign-in, one probe turn, the same turn `flow usage probe` runs, and ranks it on
 * what the probe saved.
 *
 * - At most one try per account per {@link REFRESH_INTERVAL_MS}, recorded in
 *   {@link USAGE_REFRESH_FILE} before the probe runs, so a failing probe costs
 *   at most one turn an hour.
 * - Fail closed: a probe that fails, or a reading still stale after it, leaves
 *   the account's windows as they were, so it stays out.
 * - Off with `drain.refreshStaleUsage: false`. `flow next` and `flow accounts
 *   pick` never refresh: only the drain spends usage on its own.
 *
 * Usage comes only from the official binary (the compliance guard holds this
 * file too): no stored sign-in, no new network target.
 *
 * @module @dorkos/flow/cli/usage-refresh
 */

import path from 'node:path';

import { isStaleUsage, rankAccounts } from '../drain/account-rank.ts';
import {
  dueForSnapshot,
  readUsageSampleState,
  writeUsageSampleState,
  type UsageSampleState,
} from '../drain/usage-sample.ts';
import { IMPLICIT_ACCOUNT_ID, loadAccounts, resolveDorkHome } from '../fleet/accounts.ts';
import { readLedger } from '../fleet/usage-ledger.ts';
import type { VerbContext } from './context.ts';
import { liveCounts, type AssignmentInput, type NextConfig } from './next.ts';
import {
  DEFAULT_PROBE_MODEL,
  DEFAULT_PROBE_TIMEOUT_S,
  probeAccount,
  resolveClaude,
} from './usage-probe.ts';
import { journalUsage } from './usage-journal.ts';

/** The shortest gap between two refresh tries of one account. */
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/** When each account was last tried, relative to the main checkout. */
export const USAGE_REFRESH_FILE = path.join('.dork', 'flow', 'drain-usage-refresh.json');

type Account = AssignmentInput['accounts'][number];

/** What {@link refreshStaleUsage} reads and does. */
export interface RefreshDeps {
  /** The model the rank judges buckets for (the implementation model), or `null`. */
  model: string | null;
  /** When each `<runtime>:<id>` was last tried (ISO). */
  tried: Readonly<UsageSampleState>;
  /** Save the tries, before any probe runs. */
  saveTried(state: UsageSampleState): void;
  /** Run one probe on the account and save its readings. Throws when it fails. */
  probe(account: { id: string; path: string }): Promise<void>;
  /** The account's windows as its ledger reads now. */
  reread(account: { runtime: string; id: string }): Account['windows'];
  /** One line for the pass's output. */
  report(line: string): void;
}

/**
 * Whether the account is the owner's own sign-in, which flow never probes
 * unasked: role `main`, the account `default` names, the `default` id, or this
 * computer's implicit sign-in. A stale one stays out until it is used or
 * probed by hand.
 */
function isMainAccount(account: Account): boolean {
  return (
    account.policy.role === 'main' ||
    account.isDefault === true ||
    account.id === IMPLICIT_ACCOUNT_ID ||
    account.implicit
  );
}

/**
 * Refresh the accounts kept out only by a stale reading, and return the input
 * with their windows as the ledger reads after the probe. Never throws.
 *
 * @param input - The assignment input, as gathered.
 * @param deps - The tries, the probe, the ledger reader and the report.
 * @returns The input to rank from.
 */
export async function refreshStaleUsage(
  input: AssignmentInput,
  deps: RefreshDeps
): Promise<AssignmentInput> {
  const { live } = liveCounts(input);
  const rank = rankAccounts({
    now: input.now,
    repo: input.repo,
    ...(input.project === undefined ? {} : { project: input.project }),
    accounts: input.accounts,
    runtime: 'claude-code',
    runtimes: input.runtimes,
    crossRuntimeFallback: 'off',
    model: deps.model,
    affinity: null,
    exclude: [],
    liveByAccount: live,
    opts: input.opts,
  });
  const staleOnly = new Set(
    rank.ineligible
      .filter((entry) => entry.reasons.length === 1 && entry.reasons[0] === 'stale-usage')
      .map((entry) => `${entry.runtime}:${entry.id}`)
  );
  const candidates = input.accounts.filter(
    (a) =>
      a.runtime === 'claude-code' &&
      a.path !== null &&
      !isMainAccount(a) &&
      staleOnly.has(`${a.runtime}:${a.id}`)
  );
  if (candidates.length === 0) return input;

  const { due, next } = dueForSnapshot(
    deps.tried,
    candidates.map((a) => `${a.runtime}:${a.id}`),
    input.now,
    REFRESH_INTERVAL_MS
  );
  if (due.length === 0) return input;
  try {
    deps.saveTried(next);
  } catch (error) {
    // Without a record of the try, the hourly limit cannot hold: probe nothing.
    deps.report(
      `could not record the usage refresh, so nothing was probed: ${(error as Error).message}`
    );
    return input;
  }

  const refreshed = new Map<string, Account['windows']>();
  for (const account of candidates) {
    const key = `${account.runtime}:${account.id}`;
    if (!due.includes(key)) continue;
    const name = account.label ?? account.id;
    try {
      await deps.probe({ id: account.id, path: account.path as string });
    } catch (error) {
      deps.report(
        `could not refresh the stale usage reading of ${name}, so it stays out: ${(error as Error).message}`
      );
      continue;
    }
    let windows: Account['windows'];
    try {
      windows = deps.reread(account);
    } catch (error) {
      deps.report(
        `could not read ${name}'s usage after the probe, so it stays out: ${(error as Error).message}`
      );
      continue;
    }
    if (isStaleUsage({ ...account, windows }, input.now)) {
      deps.report(`probed ${name}, but its usage reading is still out of date, so it stays out`);
      continue;
    }
    refreshed.set(key, windows);
    deps.report(`refreshed the stale usage reading of ${name}`);
  }
  if (refreshed.size === 0) return input;
  return {
    ...input,
    accounts: input.accounts.map((a) => {
      const key = `${a.runtime}:${a.id}`;
      return refreshed.has(key) ? { ...a, windows: refreshed.get(key) ?? null } : a;
    }),
  };
}

/**
 * The drain's refresh, wired to the real probe, ledger and tries file; `null`
 * when `drain.refreshStaleUsage` is off.
 *
 * @param ctx - The verb context.
 * @param config - The project config.
 * @param mainCheckout - The main checkout, which holds the tries file.
 * @returns A function from gathered input to the input to rank from, or `null`.
 */
export function staleUsageRefresher(
  ctx: VerbContext,
  config: NextConfig,
  mainCheckout: string
): ((input: AssignmentInput) => Promise<AssignmentInput>) | null {
  if (!config.drain.refreshStaleUsage) return null;
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const ledgerIdOf = (runtime: string, id: string): string | null =>
    loadAccounts(dorkHome, { home: ctx.io.osHome }).accounts.find(
      (a) => a.runtime === runtime && a.id === id
    )?.ledgerId ?? null;
  return (input) =>
    refreshStaleUsage(input, {
      model: config.models.bindings[config.models.tiers.implementation] ?? null,
      tried: readUsageSampleState(mainCheckout, USAGE_REFRESH_FILE),
      saveTried: (state) => writeUsageSampleState(mainCheckout, state, USAGE_REFRESH_FILE),
      async probe(account) {
        const ledgerId = ledgerIdOf('claude-code', account.id);
        if (ledgerId === null) throw new Error('it has no usage file to save to');
        await probeAccount(ctx, {
          claude: resolveClaude(undefined, ctx.env),
          dorkHome,
          account: { id: ledgerId, path: account.path },
          model: DEFAULT_PROBE_MODEL,
          timeoutMs: DEFAULT_PROBE_TIMEOUT_S * 1000,
        });
        journalUsage(ctx, dorkHome, [{ runtime: 'claude-code', id: ledgerId }]);
      },
      reread(account) {
        const ledgerId = ledgerIdOf(account.runtime, account.id);
        if (ledgerId === null) return null;
        const read = readLedger(dorkHome, account.runtime as 'claude-code', ledgerId);
        return read.ledger?.windows ?? null;
      },
      report: (line) => ctx.warn(`flow drain: ${line}.`),
    });
}
