/**
 * Account-aware dispatch (spec `flow-handoff-dispatch` §3): which (runtime,
 * account) pair an item's next session should bill, and how many sessions the
 * machine may start now.
 *
 * - {@link limitSignal} reads one account's windows and spend into one verdict
 *   (ok, warning, exhausted, unknown). Eligibility here and the handoff state
 *   machine (§5) both use it.
 * - {@link rankAccounts} drops the accounts that may not take the item and
 *   orders the rest: accounts of the item's runtime first ({@link itemRuntime}),
 *   and within one runtime the warm-cache affinity account, then every other
 *   account by weekly headroom per hour left before its reset (spend what expires
 *   soonest), and a `main` account last unless it is inside its spend-down
 *   window. Another runtime's accounts are candidates only with
 *   `crossRuntimeFallback: on`, after every account of the item's runtime, in
 *   `fleet.runtimes` order.
 * - {@link chooseAccount} turns a rank into the account to launch on. A runtime
 *   with no registered account has one implicit `default` account (S1 §1.1a):
 *   the ambient environment, ranked like any other. There is no other fallback,
 *   so a registered kept-out account is never spent by accident.
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
  accountKey,
  accountRoom,
  effectiveReservePct,
  fiveHourRoom,
  mayServe,
  modelRoom,
  spendRoom,
  weeklyRoom,
  type CrossRuntimeFallback,
  type ResolvedAccountPolicy,
} from '../fleet/accounts.ts';
import {
  RUNTIMES,
  bucketSlug,
  isRuntimeSlug,
  isValidAccountId,
  readSpend,
  readWindow,
  type Instant,
  type RuntimeSlug,
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
  /** The account's runtime: whether a missing `five_hour`/`seven_day` reading is unknown or expected. */
  runtime: RuntimeSlug;
  /** The account's ledger windows, read with S1 `readWindow` (expired reads as allowed, stale as no reading). */
  windows: LedgerWindows;
  /** The ledger's raw `spend` (a metered account), read with S1 `readSpend`. Absent: none. */
  spend?: unknown;
  /** The account's resolved policy (for the weekly reserve). */
  policy: ResolvedAccountPolicy;
  /** The model the session will run, or `null` for none. Its buckets bind only this account's runtime. */
  model: string | null;
  /** The moment to judge at. */
  now: Instant;
  /** How many points below a ceiling a window (or a spend cap, in percent) starts warning (`drain.warnMarginPct`). */
  warnMarginPct: number;
}

/** Why an account may not take an item (§3.2). */
export type IneligibleReason =
  'not-routable' | 'excluded' | 'out-of-scope' | 'limited' | 'near-limit' | 'at-capacity';

/** One (runtime, account) pair offered to {@link rankAccounts}. */
export interface RankableAccount {
  /** The runtime the account belongs to. */
  runtime: RuntimeSlug;
  /** The registry id (`default` for a runtime's implicit account). */
  id: string;
  /** The account's folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, provider profile); `null` for the implicit account. */
  path: string | null;
  /** True for a runtime's implicit `default` account: the ambient environment. */
  implicit: boolean;
  /** False when S1 found the id unroutable. */
  routable: boolean;
  /** The account's resolved policy. */
  policy: ResolvedAccountPolicy;
  /** The account's ledger windows, or `null` with no ledger. */
  windows: LedgerWindows;
  /** The ledger's raw `spend`, when it has one (a metered account). */
  spend?: unknown;
}

/** A (runtime, account) pair. */
export interface AccountRef {
  /** The runtime. */
  runtime: RuntimeSlug;
  /** The account id within it. */
  id: string;
}

/** Input to {@link rankAccounts}. */
export interface RankAccountsInput {
  /** The moment to judge at. */
  now: Instant;
  /** The item's repo, `owner/name`, or `null` when the checkout has no parsable origin. */
  repo: string | null;
  /** Every account of every runtime (implicit `default`s included), with its policy, windows and spend. */
  accounts: readonly RankableAccount[];
  /** The item's runtime ({@link itemRuntime}). */
  runtime: RuntimeSlug;
  /** `fleet.runtimes`: runtimes in order of preference, for cross-runtime candidates. */
  runtimes: readonly RuntimeSlug[];
  /** `fleet.crossRuntimeFallback`: `off` keeps every other runtime's accounts out of the rank. */
  crossRuntimeFallback: CrossRuntimeFallback;
  /** The model the session will run, or `null`. A model of the item's runtime: other runtimes check no model bucket. */
  model: string | null;
  /** The `<runtime>:<id>` of the item's current or last session's account (warm prompt cache), or `null`. */
  affinity: string | null;
  /** `<runtime>:<id>` keys that may not take it (the one a handoff is leaving). */
  exclude: readonly string[];
  /** Live (running or queued) sessions per `<runtime>:<id>`. A missing key counts as 0. */
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
  /** The runtime. */
  runtime: RuntimeSlug;
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
  /** The runtime. */
  runtime: RuntimeSlug;
  /** The registry id. */
  id: string;
  /** Every reason, in the §3.2 table's order. */
  reasons: IneligibleReason[];
}

/** The result of {@link rankAccounts}. */
export interface AccountRank {
  /** The first ranked pair, or `null` when nothing is eligible. */
  pick: AccountRef | null;
  /** Eligible accounts, best first. */
  ranked: RankedAccount[];
  /**
   * Accounts left out, in input order. Another runtime's accounts are not
   * candidates at all while `crossRuntimeFallback` is off, so they are not listed.
   */
  ineligible: IneligibleAccount[];
}

/** Input to {@link chooseAccount}. */
export interface ChooseAccountInput {
  /** The accounts the rank was built from ({@link RankAccountsInput.accounts}). */
  accounts: readonly Pick<RankableAccount, 'runtime' | 'id' | 'path' | 'implicit'>[];
  /** The rank for the item. */
  rank: AccountRank;
}

/**
 * The account a session launches on (§3.4). An `implicit` pick has no path: the
 * session runs in the ambient environment of its runtime.
 */
export type AccountChoice =
  | { account: { runtime: RuntimeSlug; id: string; path: string | null; implicit: boolean } }
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
 * The item's runtime (§3, R4): the one its run records, else the first of
 * `fleet.runtimes`, else `claude-code`. A recorded runtime flow does not know
 * falls through to the next rule.
 *
 * @param recorded - `FlowRun.runtime`, when the item has a run.
 * @param runtimes - `fleet.runtimes`, in order of preference.
 * @returns The runtime to rank the item's accounts for.
 */
export function itemRuntime(
  recorded: string | null | undefined,
  runtimes: readonly RuntimeSlug[]
): RuntimeSlug {
  if (isRuntimeSlug(recorded)) return recorded;
  return runtimes[0] ?? 'claude-code';
}

/**
 * The window keys that bound a model (§3.1): `model:<slug>` with S1's
 * `bucketSlug` (the key a ledger writer stores), plus `seven_day_opus` for an
 * Opus model and `seven_day_sonnet` for a Sonnet one (matched case-insensitively).
 *
 * @param model - The model id or alias, or `null`.
 * @returns The bucket keys; empty for no model.
 */
export function modelBucketsFor(model: string | null): string[] {
  if (model === null) return [];
  const lower = model.toLowerCase();
  const slug = bucketSlug(model);
  const buckets = slug === null ? [] : [`model:${slug}`];
  if (lower.includes('opus')) buckets.push('seven_day_opus');
  if (lower.includes('sonnet')) buckets.push('seven_day_sonnet');
  return buckets;
}

/**
 * Whether a window key is a model's bucket, which bounds only sessions on that
 * model: the split S1's `accountRoom` makes, so the windows judged here are the
 * ones it judges.
 */
function isModelBucketKey(key: string): boolean {
  return key.startsWith('model:') || key.startsWith('seven_day_');
}

/** One checked limit (a window, or the spend cap), judged. */
interface Judged {
  key: string;
  resetsAt: string | null;
  /** False only when the check has no reading. */
  read: boolean;
  exhausted: boolean;
  warning: boolean;
  /** The used share, for the reserve cause. */
  usedPct: number | null;
  rejected: boolean;
}

/** The earlier of two limits by `resetsAt`; an unknown reset sorts last, a tie keeps `a`. */
function sooner(a: Judged, b: Judged): Judged {
  const aMs = a.resetsAt ? Date.parse(a.resetsAt) : Infinity;
  const bMs = b.resetsAt ? Date.parse(b.resetsAt) : Infinity;
  return bMs < aMs ? b : a;
}

/**
 * One account's limit signal (§3.1). Checks `five_hour` against 100, `seven_day`
 * against `100 - effectiveReservePct`, every other account-wide window the ledger
 * holds (`window:<minutes>`, `credits:*`, `rate_limit:*`, ...) against 100, each
 * of {@link modelBucketsFor}'s buckets against 100, and a metered account's spend
 * against its `limitUsd`. Exhausted uses S1's room rules exactly (`fiveHourRoom`,
 * `weeklyRoom`, `modelRoom`, `accountRoom`); a missing window is no reading,
 * which never blocks.
 *
 * `five_hour` and `seven_day` are expected only on a runtime whose accounts
 * always have them (S1's `accountRoom` answers "unknown" for such a runtime with
 * nothing read). An OpenCode account with no window and no spend cap (a local
 * model) is `ok`.
 *
 * @param input - The runtime, windows, spend, policy, model, clock and warning margin.
 * @returns The level, the worst limit and its reset, and the cause.
 */
export function limitSignal(input: LimitSignalInput): LimitSignal {
  const { runtime, windows, spend, policy, model, now, warnMarginPct } = input;
  const windowed = accountRoom(runtime, policy, null, now) === null;
  const weeklyCeiling = 100 - effectiveReservePct(policy, windows, now);
  const present = Object.keys(windows ?? {});
  const checks: { key: string; ceiling: number; room: boolean | null; required: boolean }[] = [];
  if (windowed || present.includes('five_hour')) {
    checks.push({
      key: 'five_hour',
      ceiling: 100,
      room: fiveHourRoom(windows, now),
      required: windowed,
    });
  }
  if (windowed || present.includes('seven_day')) {
    checks.push({
      key: 'seven_day',
      ceiling: weeklyCeiling,
      room: weeklyRoom(policy, windows, now),
      required: windowed,
    });
  }
  for (const key of present) {
    if (key === 'five_hour' || key === 'seven_day' || isModelBucketKey(key)) continue;
    // S1's accountRoom over this one window is its rule for any account-wide window.
    const room = accountRoom(runtime, policy, { windows: { [key]: entryOf(windows, key) } }, now);
    checks.push({ key, ceiling: 100, room, required: false });
  }
  for (const key of modelBucketsFor(model)) {
    const room = key.startsWith('model:')
      ? modelRoom(windows, key.slice('model:'.length), now)
      : bucketRoom(windows, key, now);
    checks.push({ key, ceiling: 100, room, required: true });
  }

  const judged: Judged[] = [];
  for (const { key, ceiling, room, required } of checks) {
    const reading: WindowReading | null = readWindow(entryOf(windows, key), now, key);
    if (reading === null && !required) continue;
    const exhausted = room === false;
    judged.push({
      key,
      resetsAt: reading?.resetsAt ?? null,
      read: reading !== null,
      exhausted,
      warning:
        !exhausted &&
        reading !== null &&
        (reading.status === 'allowed_warning' ||
          (reading.usedPct !== null && reading.usedPct >= ceiling - warnMarginPct)),
      usedPct: reading?.usedPct ?? null,
      rejected: reading?.status === 'rejected',
    });
  }
  const cap = readSpend(spend);
  if (cap !== null && cap.limitUsd !== null) {
    const usedPct = cap.limitUsd === 0 ? 100 : (cap.costUsd / cap.limitUsd) * 100;
    const exhausted = spendRoom(spend) === false;
    judged.push({
      key: 'spend',
      resetsAt: null,
      read: true,
      exhausted,
      warning: !exhausted && usedPct >= 100 - warnMarginPct,
      usedPct,
      rejected: false,
    });
  }

  const exhausted = judged.filter((j) => j.exhausted);
  if (exhausted.length > 0 || accountRoom(runtime, policy, { windows, spend }, now) === false) {
    const worst = exhausted.length > 0 ? exhausted.reduce(sooner) : null;
    const onlyReserve =
      exhausted.length === 1 &&
      exhausted[0].key === 'seven_day' &&
      exhausted[0].read &&
      !exhausted[0].rejected &&
      exhausted[0].usedPct !== null &&
      exhausted[0].usedPct < 100;
    return {
      level: 'exhausted',
      window: worst?.key ?? null,
      resetsAt: worst?.resetsAt ?? null,
      cause: onlyReserve ? 'reserve' : 'limit',
    };
  }
  const warning = judged.filter((j) => j.warning);
  if (warning.length > 0) {
    const worst = warning.reduce(sooner);
    return { level: 'warning', window: worst.key, resetsAt: worst.resetsAt, cause: null };
  }
  const level = judged.every((j) => j.read) ? 'ok' : 'unknown';
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
  const ceiling = 100 - effectiveReservePct(account.policy, account.windows, now);
  const remaining = ceiling - (reading?.usedPct ?? 0);
  // An expired reading's resetsAt is the week that already ended (it reads as 0
  // used, and S1 applies the reserve again after the reset); the next reset is
  // unknown, so its horizon is a full week.
  const hours =
    reading !== null && reading.resetsAt !== null && !reading.expired
      ? Math.max(1, (Date.parse(reading.resetsAt) - instantMs(now)) / HOUR_MS)
      : WEEK_HOURS;
  return remaining / hours;
}

/** The 5-hour window's used share for tie-breaks; no reading counts as 0. */
function fiveHourUsed(account: RankableAccount, now: Instant): number {
  return readWindow(entryOf(account.windows, 'five_hour'), now, 'five_hour')?.usedPct ?? 0;
}

/**
 * Where a runtime's accounts rank (§3.3, R4): 0 for the item's runtime; another
 * runtime ranks after it, by its place in `fleet.runtimes`, and a runtime the
 * list leaves out after every listed one, in S1's runtime order.
 */
function runtimeGroup(
  runtime: RuntimeSlug,
  own: RuntimeSlug,
  preference: readonly RuntimeSlug[]
): number {
  if (runtime === own) return 0;
  const listed = preference.indexOf(runtime);
  return 1 + (listed !== -1 ? listed : preference.length + RUNTIMES.indexOf(runtime));
}

/**
 * Rank the (runtime, account) pairs for one item (§3.2, §3.3, R4).
 *
 * - Candidates: every account of the item's runtime; another runtime's accounts
 *   only with `crossRuntimeFallback: on` (while it is off they are left out
 *   entirely, not listed as ineligible).
 * - Ineligible accounts are listed with every reason that applies; an `unknown`
 *   signal is eligible. A model's buckets are checked only on the item's own
 *   runtime (model fallback stays within a runtime).
 * - Order: the item's runtime first, then other runtimes by
 *   {@link runtimeGroup}; within one runtime by tier (affinity, then
 *   rotation-and-spending-down accounts, then a held-back `main`), then score
 *   descending, then the lower 5-hour usage, then id ascending.
 *
 * @param input - The clock, repo, accounts, runtimes, model, affinity, exclusions, live counts and settings.
 * @returns The pick, the ranked eligible accounts and the ineligible ones.
 */
export function rankAccounts(input: RankAccountsInput): AccountRank {
  const { now, repo, model, affinity, opts, runtime: own } = input;
  const excluded = new Set(input.exclude);
  const ranked: (RankedAccount & { group: number; fiveHour: number })[] = [];
  const ineligible: IneligibleAccount[] = [];

  for (const account of input.accounts) {
    if (account.runtime !== own && input.crossRuntimeFallback !== 'on') continue;
    const key = accountKey(account.runtime, account.id);
    const signal = limitSignal({
      runtime: account.runtime,
      windows: account.windows,
      spend: account.spend,
      policy: account.policy,
      model: account.runtime === own ? model : null,
      now,
      warnMarginPct: opts.warnMarginPct,
    });
    const reasons: IneligibleReason[] = [];
    if (!account.routable || !isValidAccountId(account.id)) reasons.push('not-routable');
    if (excluded.has(key)) reasons.push('excluded');
    if (!mayServe(account.policy, repo)) reasons.push('out-of-scope');
    if (signal.level === 'exhausted') reasons.push('limited');
    if (signal.level === 'warning') reasons.push('near-limit');
    if ((input.liveByAccount[key] ?? 0) >= opts.maxLivePerAccount) reasons.push('at-capacity');
    if (reasons.length > 0) {
      ineligible.push({ runtime: account.runtime, id: account.id, reasons });
      continue;
    }
    const heldBack = mainHeldBack(account, now);
    ranked.push({
      runtime: account.runtime,
      id: account.id,
      tier: heldBack ? 2 : key === affinity ? 0 : 1,
      score: headroomScore(account, now),
      signal,
      group: runtimeGroup(account.runtime, own, input.runtimes),
      fiveHour: fiveHourUsed(account, now),
    });
  }

  ranked.sort(
    (a, b) =>
      a.group - b.group ||
      a.tier - b.tier ||
      b.score - a.score ||
      a.fiveHour - b.fiveHour ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const first = ranked[0];
  return {
    pick: first === undefined ? null : { runtime: first.runtime, id: first.id },
    ranked: ranked.map(({ runtime, id, tier, score, signal }) => ({
      runtime,
      id,
      tier,
      score,
      signal,
    })),
    ineligible,
  };
}

/**
 * The account a session launches on (§3.4): the rank's pick, or `'none'` with
 * the reasons. A runtime with no registered account ranks its implicit
 * `default` account, the ambient environment (`implicit: true`, no path), so a
 * one-account user needs no fleet setup. There is no other fallback: a runtime
 * with registered accounts has no implicit one, and the ambient folder may be a
 * kept-out account (the client's org account), which nothing spends until the
 * operator says so.
 *
 * @param input - The accounts the rank was built from, and the item's rank.
 * @returns The chosen account, or `'none'` with every account's reasons.
 */
export function chooseAccount(input: ChooseAccountInput): AccountChoice {
  const { accounts, rank } = input;
  const pick = rank.pick;
  const picked =
    pick === null
      ? undefined
      : accounts.find((a) => a.runtime === pick.runtime && a.id === pick.id);
  if (picked === undefined) return { account: 'none', reasons: rank.ineligible };
  return {
    account: {
      runtime: picked.runtime,
      id: picked.id,
      path: picked.path,
      implicit: picked.implicit,
    },
  };
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
