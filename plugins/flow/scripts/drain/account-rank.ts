/**
 * Account-aware dispatch (spec `flow-handoff-dispatch` §3): which registered
 * account an item's next session should bill, and how many sessions the machine
 * may start now.
 *
 * - {@link limitSignal} reads one account's windows into one verdict (ok,
 *   warning, exhausted, unknown). Eligibility here and the handoff state machine
 *   (§5) both use it.
 * - {@link rankAccounts} drops the accounts that may not take the item and
 *   orders the rest: the warm-cache affinity account first, then every other
 *   account by weekly headroom per hour left before its reset (spend what expires
 *   soonest), and a `main` account last unless it is inside its spend-down window.
 * - {@link chooseAccount} turns a rank into the account to launch on, and falls
 *   back to the ambient account only when no account is registered at all.
 * - {@link launchBudget} caps new launches by machine load.
 *
 * Every rule about reserves, room and scope comes from S1's fleet contract
 * (`../fleet/accounts.ts`, `../fleet/usage-ledger.ts`, pinned by
 * `plugins/flow/conformance/fleet/`); this module only orders. Pure: `now` is
 * always an input, and nothing here reads a file, the clock or the environment.
 *
 * Dependency-free (local zero-dependency modules only).
 *
 * @module @dorkos/flow/drain/account-rank
 */

import {
  effectiveReservePct,
  fiveHourRoom,
  mayServe,
  modelRoom,
  weeklyRoom,
  type ResolvedAccountPolicy,
} from '../fleet/accounts.ts';
import {
  isValidAccountId,
  readWindow,
  type Instant,
  type WindowReading,
} from '../fleet/usage-ledger.ts';

/** A ledger's `windows` object, or `null` when the account has no ledger. */
export type LedgerWindows = Record<string, unknown> | null;

/** How close one account is to a limit. */
export type LimitLevel = 'ok' | 'warning' | 'exhausted' | 'unknown';

/** One account's limit verdict (§3.1). */
export interface LimitSignal {
  /** `exhausted` beats `warning`; `unknown` means nothing trips but some window has no reading. */
  level: LimitLevel;
  /** The worst window's key, or `null` when nothing trips. */
  window: string | null;
  /** The worst window's reset time (ISO), or `null`. */
  resetsAt: string | null;
  /** For `exhausted`: `reserve` when only the operator's weekly reserve made it so, else `limit`. `null` otherwise. */
  cause: 'limit' | 'reserve' | null;
}

/** Input to {@link limitSignal}. */
export interface LimitSignalInput {
  /** The account's ledger windows, read with S1 `readWindow` (expired reads as allowed, stale as no reading). */
  windows: LedgerWindows;
  /** The account's resolved policy (for the weekly reserve). */
  policy: ResolvedAccountPolicy;
  /** The model the session will run, or `null` for none. */
  model: string | null;
  /** The moment to judge at. */
  now: Instant;
  /** How many points below a ceiling a window starts warning (`drain.warnMarginPct`). */
  warnMarginPct: number;
}

/** Why an account may not take an item (§3.2). */
export type IneligibleReason =
  'not-routable' | 'excluded' | 'out-of-scope' | 'limited' | 'near-limit' | 'at-capacity';

/** One account offered to {@link rankAccounts}. */
export interface RankableAccount {
  /** The registry id. */
  id: string;
  /** The account's `CLAUDE_CONFIG_DIR`. */
  path: string;
  /** False when S1 found the id unroutable. */
  routable: boolean;
  /** The account's resolved policy. */
  policy: ResolvedAccountPolicy;
  /** The account's ledger windows, or `null` with no ledger. */
  windows: LedgerWindows;
}

/** Input to {@link rankAccounts}. */
export interface RankAccountsInput {
  /** The moment to judge at. */
  now: Instant;
  /** The item's repo, `owner/name`, or `null` when the checkout has no parsable origin. */
  repo: string | null;
  /** Every registered account, with its policy and windows. */
  accounts: readonly RankableAccount[];
  /** The model the session will run, or `null`. */
  model: string | null;
  /** The account of the item's current or last session (warm prompt cache), or `null`. */
  affinity: string | null;
  /** Accounts that may not take it (the one a handoff is leaving). */
  exclude: readonly string[];
  /** Live (running or queued) sessions per account id. A missing id counts as 0. */
  liveByAccount: Readonly<Record<string, number>>;
  /** Drain settings. */
  opts: {
    /** Points below a ceiling that count as near a limit. */
    warnMarginPct: number;
    /** Live sessions one account may carry. */
    maxLivePerAccount: number;
  };
}

/** One eligible account, in rank order. */
export interface RankedAccount {
  /** The registry id. */
  id: string;
  /** 0: warm-cache affinity. 1: by headroom per hour. 2: a main outside its spend-down window. */
  tier: 0 | 1 | 2;
  /** Weekly headroom (points) per hour until the weekly reset. Higher goes first within a tier. */
  score: number;
  /** The account's limit signal (`ok` or `unknown` here). */
  signal: LimitSignal;
}

/** One account left out, with every reason that applies. */
export interface IneligibleAccount {
  /** The registry id. */
  id: string;
  /** Every reason, in the §3.2 table's order. */
  reasons: IneligibleReason[];
}

/** The result of {@link rankAccounts}. */
export interface AccountRank {
  /** The first ranked id, or `null` when nothing is eligible. */
  pick: string | null;
  /** Eligible accounts, best first. */
  ranked: RankedAccount[];
  /** Accounts left out, in input order. */
  ineligible: IneligibleAccount[];
}

/** Input to {@link chooseAccount}. */
export interface ChooseAccountInput {
  /** Every registered identity (S1 `readIdentities`). Empty means no registry. */
  identities: readonly { id: string; path: string }[];
  /** The rank for the item. */
  rank: AccountRank;
}

/** The account a session launches on (§3.4). */
export type AccountChoice =
  | { account: { id: string; path: string } }
  | { account: null; reason: 'no-registry' }
  | { account: 'none'; reasons: IneligibleAccount[] };

/** Input to {@link launchBudget}. */
export interface LaunchBudgetInput {
  /** The 1-minute load average. */
  load1: number;
  /** Logical CPUs. */
  cpus: number;
  /** This drain's sessions (workers and reviewers) that have not exited. */
  live: number;
  /** The drain's parallelism. */
  parallel: number;
  /** Load per CPU at or above which no new session starts. */
  maxLoadPerCpu: number;
}

/** How many sessions may start now (§3.6). */
export interface LaunchBudget {
  /** New sessions that may start. */
  slots: number;
  /** `machine-busy` when load held every launch back, else `null`. */
  reason: 'machine-busy' | null;
}

/** One hour in milliseconds. */
const HOUR_MS = 60 * 60 * 1000;

/** The weekly horizon, in hours, when the reset time is unknown. */
const WEEK_HOURS = 168;

/** Milliseconds for a clock input. */
function instantMs(now: Instant): number {
  return now instanceof Date ? now.getTime() : Date.parse(now);
}

/** A window's stored entry, when `windows` has it. */
function entryOf(windows: LedgerWindows, key: string): unknown {
  return windows !== null && Object.hasOwn(windows, key) ? windows[key] : undefined;
}

/**
 * The window keys that bound a model (§3.1): `model:<slug>`, where the slug is
 * the model lowercased with every run of characters outside `[a-z0-9._-]`
 * replaced by `-`, plus `seven_day_opus` for an Opus model and
 * `seven_day_sonnet` for a Sonnet one (matched case-insensitively).
 *
 * @param model - The model id or alias, or `null`.
 * @returns The bucket keys; empty for no model.
 */
export function modelBucketsFor(model: string | null): string[] {
  if (model === null) return [];
  const lower = model.toLowerCase();
  const buckets = [`model:${lower.replace(/[^a-z0-9._-]+/g, '-')}`];
  if (lower.includes('opus')) buckets.push('seven_day_opus');
  if (lower.includes('sonnet')) buckets.push('seven_day_sonnet');
  return buckets;
}

/** One checked window, judged. */
interface Judged {
  key: string;
  reading: WindowReading | null;
  exhausted: boolean;
  warning: boolean;
}

/** The earlier of two windows by `resetsAt`; an unknown reset sorts last, a tie keeps `a`. */
function sooner(a: Judged, b: Judged): Judged {
  const aMs = a.reading?.resetsAt ? Date.parse(a.reading.resetsAt) : Infinity;
  const bMs = b.reading?.resetsAt ? Date.parse(b.reading.resetsAt) : Infinity;
  return bMs < aMs ? b : a;
}

/**
 * One account's limit signal (§3.1). Checks `five_hour` against 100, `seven_day`
 * against `100 - effectiveReservePct`, and each of {@link modelBucketsFor}'s
 * buckets against 100. Exhausted uses S1's room rules exactly (`fiveHourRoom`,
 * `weeklyRoom`, `modelRoom`); a missing window is no reading, which never blocks.
 *
 * @param input - The windows, policy, model, clock and warning margin.
 * @returns The level, the worst window and its reset, and the cause.
 */
export function limitSignal(input: LimitSignalInput): LimitSignal {
  const { windows, policy, model, now, warnMarginPct } = input;
  const weeklyCeiling = 100 - effectiveReservePct(policy, windows, now);
  const checks: { key: string; ceiling: number; room: boolean | null }[] = [
    { key: 'five_hour', ceiling: 100, room: fiveHourRoom(windows, now) },
    { key: 'seven_day', ceiling: weeklyCeiling, room: weeklyRoom(policy, windows, now) },
  ];
  for (const key of modelBucketsFor(model)) {
    const room = key.startsWith('model:')
      ? modelRoom(windows, key.slice('model:'.length), now)
      : bucketRoom(windows, key, now);
    checks.push({ key, ceiling: 100, room });
  }

  const judged: Judged[] = checks.map(({ key, ceiling, room }) => {
    const reading = readWindow(entryOf(windows, key), now, key);
    const exhausted = room === false;
    const warning =
      !exhausted &&
      reading !== null &&
      (reading.status === 'allowed_warning' ||
        (reading.usedPct !== null && reading.usedPct >= ceiling - warnMarginPct));
    return { key, reading, exhausted, warning };
  });

  const exhausted = judged.filter((j) => j.exhausted);
  if (exhausted.length > 0) {
    const worst = exhausted.reduce(sooner);
    const onlyReserve =
      exhausted.length === 1 &&
      exhausted[0].key === 'seven_day' &&
      exhausted[0].reading !== null &&
      exhausted[0].reading.status !== 'rejected' &&
      exhausted[0].reading.usedPct !== null &&
      exhausted[0].reading.usedPct < 100;
    return {
      level: 'exhausted',
      window: worst.key,
      resetsAt: worst.reading?.resetsAt ?? null,
      cause: onlyReserve ? 'reserve' : 'limit',
    };
  }
  const warning = judged.filter((j) => j.warning);
  if (warning.length > 0) {
    const worst = warning.reduce(sooner);
    return {
      level: 'warning',
      window: worst.key,
      resetsAt: worst.reading?.resetsAt ?? null,
      cause: null,
    };
  }
  const level = judged.every((j) => j.reading !== null) ? 'ok' : 'unknown';
  return { level, window: null, resetsAt: null, cause: null };
}

/**
 * Room in a model family's weekly bucket (`seven_day_opus`, `seven_day_sonnet`),
 * against 100 with no reserve. S1 exposes no helper for these keys; the rule is
 * the one its `modelRoom` applies to `model:<slug>`.
 */
function bucketRoom(windows: LedgerWindows, key: string, now: Instant): boolean | null {
  const reading = readWindow(entryOf(windows, key), now, key);
  if (reading === null) return null;
  if (reading.status === 'rejected') return false;
  return !(reading.usedPct !== null && reading.usedPct >= 100);
}

/**
 * Whether a `main` account is outside its spend-down window: its `seven_day`
 * reset time is unknown (including an expired reading, whose reset has passed),
 * or `now` is earlier than `resetsAt - spendDownWindowHours`. Only then does dispatch hold it back (S1 §1.1b).
 */
function mainHeldBack(account: RankableAccount, now: Instant): boolean {
  if (account.policy.role !== 'main') return false;
  const reading = readWindow(entryOf(account.windows, 'seven_day'), now, 'seven_day');
  // An expired reading's resetsAt is the week that already ended; the next reset
  // is unknown, so the main is held back (a rarely used main is usually expired).
  if (reading === null || reading.resetsAt === null || reading.expired) return true;
  const startsMs = Date.parse(reading.resetsAt) - account.policy.spendDownWindowHours * HOUR_MS;
  return instantMs(now) < startsMs;
}

/**
 * Weekly headroom per hour left (§3.3 tier 1): `remaining / hours`, where
 * `remaining = (100 - effectiveReservePct) - seven_day.usedPct` (no reading:
 * `100 - effectiveReservePct`) and `hours = max(1, hours until the weekly
 * reset)` (unknown reset: 168). Headroom that expires soonest scores highest.
 */
function headroomScore(account: RankableAccount, now: Instant): number {
  const reading = readWindow(entryOf(account.windows, 'seven_day'), now, 'seven_day');
  if (reading?.expired) {
    // A new week has begun since this reading: its whole allowance is left, the
    // reserve applies again, and the next reset is unknown. S1's
    // effectiveReservePct keeps reading the ended week's resetsAt as "inside the
    // spend-down window", so it is not used here.
    return (100 - account.policy.reservePct) / WEEK_HOURS;
  }
  const ceiling = 100 - effectiveReservePct(account.policy, account.windows, now);
  const remaining = ceiling - (reading?.usedPct ?? 0);
  const hours =
    reading !== null && reading.resetsAt !== null
      ? Math.max(1, (Date.parse(reading.resetsAt) - instantMs(now)) / HOUR_MS)
      : WEEK_HOURS;
  return remaining / hours;
}

/** The 5-hour window's used share for tie-breaks; no reading counts as 0. */
function fiveHourUsed(account: RankableAccount, now: Instant): number {
  return readWindow(entryOf(account.windows, 'five_hour'), now, 'five_hour')?.usedPct ?? 0;
}

/**
 * Rank the registered accounts for one item (§3.2, §3.3). Ineligible accounts
 * are listed with every reason that applies; an `unknown` signal is eligible.
 * Eligible ones are ordered by tier (affinity, then rotation-and-spending-down
 * accounts, then a held-back `main`), then score descending, then the lower
 * 5-hour usage, then id ascending.
 *
 * @param input - The clock, repo, accounts, model, affinity, exclusions, live counts and settings.
 * @returns The pick, the ranked eligible accounts and the ineligible ones.
 */
export function rankAccounts(input: RankAccountsInput): AccountRank {
  const { now, repo, model, affinity, opts } = input;
  const excluded = new Set(input.exclude);
  const ranked: (RankedAccount & { fiveHour: number })[] = [];
  const ineligible: IneligibleAccount[] = [];

  for (const account of input.accounts) {
    const signal = limitSignal({
      windows: account.windows,
      policy: account.policy,
      model,
      now,
      warnMarginPct: opts.warnMarginPct,
    });
    const reasons: IneligibleReason[] = [];
    if (!account.routable || !isValidAccountId(account.id)) reasons.push('not-routable');
    if (excluded.has(account.id)) reasons.push('excluded');
    if (!mayServe(account.policy, repo)) reasons.push('out-of-scope');
    if (signal.level === 'exhausted') reasons.push('limited');
    if (signal.level === 'warning') reasons.push('near-limit');
    if ((input.liveByAccount[account.id] ?? 0) >= opts.maxLivePerAccount) {
      reasons.push('at-capacity');
    }
    if (reasons.length > 0) {
      ineligible.push({ id: account.id, reasons });
      continue;
    }
    const heldBack = mainHeldBack(account, now);
    const tier = heldBack ? 2 : account.id === affinity ? 0 : 1;
    ranked.push({
      id: account.id,
      tier,
      score: headroomScore(account, now),
      signal,
      fiveHour: fiveHourUsed(account, now),
    });
  }

  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.score - a.score ||
      a.fiveHour - b.fiveHour ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return {
    pick: ranked[0]?.id ?? null,
    ranked: ranked.map(({ id, tier, score, signal }) => ({ id, tier, score, signal })),
    ineligible,
  };
}

/**
 * The account a session launches on (§3.4). With no identity registered it is
 * the ambient account (`account: null`), as flow ran before fleets. With any
 * identity registered it is the rank's pick, or `'none'` with the reasons: it
 * never falls back to the ambient account, which may itself be a kept-out one.
 *
 * @param input - The registered identities and the item's rank.
 * @returns The chosen identity, the ambient marker, or `'none'` with every account's reasons.
 */
export function chooseAccount(input: ChooseAccountInput): AccountChoice {
  const { identities, rank } = input;
  if (identities.length === 0) return { account: null, reason: 'no-registry' };
  const picked = rank.pick === null ? undefined : identities.find((i) => i.id === rank.pick);
  if (picked !== undefined) return { account: { id: picked.id, path: picked.path } };
  return { account: 'none', reasons: rank.ineligible };
}

/**
 * How many new sessions may start now (§3.6): none while `load1 / cpus` is at or
 * above `maxLoadPerCpu`, else the drain's free parallel slots. Running sessions
 * are never stopped for load; only new launches wait.
 *
 * @param input - The load average, CPU count, live sessions, parallelism and load cap.
 * @returns The free slots and, when load held them back, `machine-busy`.
 */
export function launchBudget(input: LaunchBudgetInput): LaunchBudget {
  const { load1, cpus, live, parallel, maxLoadPerCpu } = input;
  if (load1 / Math.max(1, cpus) >= maxLoadPerCpu) return { slots: 0, reason: 'machine-busy' };
  return { slots: Math.max(0, parallel - live), reason: null };
}
