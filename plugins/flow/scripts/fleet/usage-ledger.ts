/**
 * The usage ledger (spec `flow-cli-core` §1.2): one JSON file per account of one
 * runtime at `<dorkHome>/runtimes/<runtime>/usage/<account-id>.json`, holding the
 * latest reading of each rate-limit window that account has, plus its plan,
 * credits and spend when the runtime reports them.
 *
 * This is a shared contract. DorkOS writes the same files from its own
 * sessions, and both sides prove they agree with the case files in
 * `plugins/flow/conformance/fleet/` (`window-read`, `ledger-merge`). Change a rule
 * here only together with that folder's `CONTRACT_VERSION`.
 *
 * The pure core is {@link readWindow} (what one stored window means right now),
 * {@link mergeLedger} (fold new observations into a ledger) and
 * {@link codexObservations} (Codex's `rate_limits` payload as observations). The
 * file side, {@link readLedger}, {@link recordUsage} and {@link removeLedger},
 * wraps them with the shared lock-and-rename writer in `../atomic-json.ts`.
 *
 * Dependency-free (node builtins and local zero-dependency modules only), so a
 * status-line hook can record usage before `npm install` has run.
 *
 * @module @dorkos/flow/fleet/usage-ledger
 */

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, updateJsonFile, withHeldLock } from '../atomic-json.ts';
import { PreconditionError } from '../errors.ts';

/** The ledger format version this module reads and writes. */
export const LEDGER_VERSION = 1;

/**
 * The runtimes an account can belong to, in display order. The slug is a folder
 * name under `<dorkHome>/runtimes/` and the prefix of a `fleet.json` key.
 */
export const RUNTIMES = ['claude-code', 'codex', 'opencode'] as const;

/** The id of a runtime's implicit account: the ambient environment. */
export const IMPLICIT_ACCOUNT_ID = 'default';

/** One runtime slug. */
export type RuntimeSlug = (typeof RUNTIMES)[number];

/**
 * Whether `value` is a runtime slug. Anything else is refused before it gets near
 * a path.
 *
 * @param value - Anything.
 * @returns True for `claude-code`, `codex` or `opencode`.
 */
export function isRuntimeSlug(value: unknown): value is RuntimeSlug {
  return typeof value === 'string' && (RUNTIMES as readonly string[]).includes(value);
}

/**
 * The account id pattern (spec §1.1a). An id becomes a file name, so anything
 * else is refused before it gets near a path.
 */
export const ACCOUNT_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The window keys the contract names. Any other key matching the generic pattern is allowed too. */
export const KNOWN_WINDOW_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
] as const;

/** A window named only by its length: `window:<minutes>` (Codex, spec §1.2). */
const MINUTES_KEY_PATTERN = /^window:[1-9][0-9]*$/;

/**
 * An error-only signal from one provider: `credits:<slug>` (payment required, out
 * of credits) or `rate_limit:<slug>` (HTTP 429). Always window-less.
 */
const ERROR_KEY_PATTERN = /^(credits|rate_limit):[a-z0-9][a-z0-9._-]*$/;

/** ISO-8601 with an explicit zone (`Z` or `+hh:mm`). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An observation may be at most this far after `now`; later ones come from a bad clock. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** How long a `five_hour` reading with no `resetsAt` stays current. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** How long any other reading with no `resetsAt` stays current. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a `credits:*` or `rate_limit:*` reading with no `resetsAt` stays current. */
const ERROR_READING_MS = 60 * 60 * 1000;

const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);

/** Where a reading came from (spec §1.2 "Mapping each source"). */
export const USAGE_SOURCES = [
  'statusline',
  'sdk_event',
  'sdk_usage',
  'transcript',
  'rollout',
  'sidecar',
  'provider_api',
  'error',
] as const;

const SOURCES = new Set<string>(USAGE_SOURCES);

/** A rate-limit status as the SDK reports it. */
export type WindowStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** Where a reading came from (spec §1.2 "Mapping each source"). */
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** One stored window. */
export interface WindowEntry {
  /** Percent used, 0-100, or `null` when the source gave none. */
  usedPct: number | null;
  /** When the window resets (UTC ISO), or `null` when unknown. */
  resetsAt: string | null;
  /** The window's length in minutes, when the source names it (Codex does). */
  windowMinutes?: number;
  /** The source's status, or `null` when it gave none. */
  status: WindowStatus | null;
  /** When the SOURCE saw this reading (UTC ISO), not when it was written. */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/** A new reading for one window, as a writer hands it to {@link mergeLedger}. */
export interface UsageObservation extends Partial<
  Pick<WindowEntry, 'usedPct' | 'resetsAt' | 'status' | 'windowMinutes'>
> {
  /** The window key (`five_hour`, `seven_day`, `model:<slug>`, `window:<minutes>`, ...). */
  key: string;
  /** When the source saw it; ISO-8601 with an explicit zone. */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/** The account's plan as its runtime names it (`max`, `pro`, `plus`, ...). */
export interface PlanEntry {
  /** The plan name, lowercase as the runtime reports it. */
  name: string;
  /** When the source saw it (UTC ISO). */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/** Prepaid credits, as Codex reports them. */
export interface CreditsEntry {
  /** Whether the account has credits at all. */
  hasCredits: boolean;
  /** Whether the credits are unlimited. */
  unlimited: boolean;
  /** The balance exactly as the runtime reports it (a decimal string), or `null`. */
  balance: string | null;
  /** When the source saw it (UTC ISO). */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/** Money spent in the current period, for a metered account (API keys, OpenRouter). */
export interface SpendEntry {
  /** When the period being counted started (UTC ISO). */
  periodStart: string;
  /** Dollars spent since `periodStart`, 0 or more. */
  costUsd: number;
  /** The period's cap in dollars, or `null` with no cap. */
  limitUsd: number | null;
  /** When the source saw it (UTC ISO). */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/**
 * A new plan, credits or spend reading, as a writer hands it to
 * {@link mergeLedger}: the entry plus its `kind`. Like a window, each replaces
 * the stored one only when its `observedAt` is strictly later.
 */
export type FactObservation =
  | ({ kind: 'plan' } & PlanEntry)
  | ({ kind: 'credits' } & CreditsEntry)
  | ({ kind: 'spend' } & Omit<SpendEntry, 'limitUsd'> & { limitUsd?: number | null });

/** The v1 ledger file. Unknown fields are kept by writers. */
export interface UsageLedger {
  /** Always 1. */
  v: 1;
  /** The runtime the account belongs to; always the runtime in the file's path. */
  runtime: RuntimeSlug;
  /** The registry id this ledger belongs to. */
  accountId: string;
  /** The last write, any window (UTC ISO). */
  updatedAt: string;
  /** Window key to entry. May hold keys (and values) this reader does not use. */
  windows: Record<string, unknown>;
  /** The plan, when the runtime reports one (read it with {@link readPlan}). */
  plan?: unknown;
  /** Prepaid credits, when the runtime reports them (read with {@link readCredits}). */
  credits?: unknown;
  /** Spend this period, for a metered account (read with {@link readSpend}). */
  spend?: unknown;
  /** Fields a newer writer added. */
  [extra: string]: unknown;
}

/** What one window means at a given moment (see {@link readWindow}). */
export interface WindowReading extends WindowEntry {
  /** True when the window has reset since the reading; it then reads 0% and `allowed`. */
  expired: boolean;
}

/** A problem a fleet module worked around. Codes are the contract; messages are for people. */
export interface FleetWarning {
  /** A stable code the conformance cases compare. */
  code: string;
  /** A plain sentence. */
  message: string;
}

/** The result of {@link mergeLedger}. */
export interface MergeResult {
  /** The ledger after the merge (the input, untouched, when nothing changed). */
  ledger: unknown;
  /** Whether anything changed, so the file must be rewritten. */
  changed: boolean;
  /** Observations dropped and other problems. */
  warnings: FleetWarning[];
}

/**
 * Whether `id` is a valid account id.
 *
 * @param id - Anything.
 * @returns True for a string matching {@link ACCOUNT_ID_PATTERN}.
 */
export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id);
}

/**
 * The whole window-key grammar as one pattern (spec §1.2 "Window keys"), for
 * other readers of ledger windows (the journal's `usage.snapshot`) to share.
 */
export const WINDOW_KEY_PATTERN =
  /^(model:[a-z0-9][a-z0-9._-]*|(credits|rate_limit):[a-z0-9][a-z0-9._-]*|window:[1-9][0-9]*|[a-z][a-z0-9_]*)$/;

/**
 * Whether `key` is an allowed window key: a known key, `model:<slug>`,
 * `window:<minutes>`, `credits:<slug>`, `rate_limit:<slug>`, or any
 * `^[a-z][a-z0-9_]*$`.
 *
 * @param key - A window key.
 * @returns True when a writer may store it.
 */
export function isValidWindowKey(key: unknown): key is string {
  return typeof key === 'string' && WINDOW_KEY_PATTERN.test(key);
}

/**
 * Whether `key` is an error-only signal: `credits:<slug>` or `rate_limit:<slug>`.
 * A current `rejected` reading under such a key means no room, whatever the
 * other windows say (spec §1.1b).
 *
 * @param key - A window key.
 * @returns True for the two error families.
 */
export function isErrorWindowKey(key: string): boolean {
  return ERROR_KEY_PATTERN.test(key);
}

/**
 * Reduce a name to the bucket slug alphabet (spec §1.2, the `model:`, `credits:`
 * and `rate_limit:` keys): lowercase, every run of characters outside
 * `[a-z0-9._-]` becomes one `-`, and anything but a letter or digit is trimmed
 * from the start and `-` from the end. `GPT-5.3-Codex-Spark` becomes
 * `gpt-5.3-codex-spark`.
 *
 * @param name - A model, limit or provider name.
 * @returns The slug, or `null` when nothing usable is left.
 */
export function bucketSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return slug === '' ? null : slug;
}

/**
 * How long a reading with no `resetsAt` stays current (spec §1.2 "Reading a
 * window"): 1 hour for `credits:*` and `rate_limit:*`; else the window's own
 * length when the entry names it (`windowMinutes`, or the minutes in a
 * `window:<minutes>` key); else 5 h for `five_hour` and 7 days for every other key.
 *
 * @param key - A window key.
 * @param entry - The entry's `windowMinutes`, when known.
 * @returns The length in milliseconds.
 */
export function windowLengthMs(key: string, entry: { windowMinutes?: number } = {}): number {
  if (ERROR_KEY_PATTERN.test(key)) return ERROR_READING_MS;
  if (entry.windowMinutes !== undefined) return entry.windowMinutes * 60 * 1000;
  if (MINUTES_KEY_PATTERN.test(key)) return Number(key.slice('window:'.length)) * 60 * 1000;
  return key === 'five_hour' ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
}

/**
 * The window key for a window known only by its length (spec §1.2, Codex's
 * `primary` and `secondary`): 300 minutes is `five_hour`, 10080 is `seven_day`,
 * any other length is `window:<minutes>`.
 *
 * @param windowMinutes - The window's length in minutes, a positive integer.
 * @returns The key, or `null` when the length is not a positive integer.
 */
export function windowKeyForMinutes(windowMinutes: unknown): string | null {
  if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes < 1)
    return null;
  if (windowMinutes === 300) return 'five_hour';
  if (windowMinutes === 10080) return 'seven_day';
  return `window:${windowMinutes}`;
}

/** Parse an ISO-8601 time that carries an explicit zone; `null` for anything else. */
function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** A clock input: a `Date` or an ISO string. */
export type Instant = Date | string;

/** Milliseconds for a clock input. Throws on an unparsable string (a caller bug). */
function instantMs(now: Instant): number {
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(ms)) throw new RangeError(`not a valid time: ${String(now)}`);
  return ms;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize one window entry: timestamps to UTC ISO, `usedPct`
 * clamped to 0-100, omitted `usedPct`/`resetsAt`/`status` as `null`.
 *
 * @returns The normalized entry, or `null` when it is not a valid entry.
 */
function normalizeEntry(raw: unknown): WindowEntry | null {
  if (!isObject(raw)) return null;
  const observedMs = parseIsoMs(raw.observedAt);
  if (observedMs === null) return null;
  if (typeof raw.source !== 'string' || !SOURCES.has(raw.source)) return null;

  const usedRaw = raw.usedPct ?? null;
  if (usedRaw !== null && (typeof usedRaw !== 'number' || !Number.isFinite(usedRaw))) return null;
  const statusRaw = raw.status ?? null;
  if (statusRaw !== null && (typeof statusRaw !== 'string' || !STATUSES.has(statusRaw)))
    return null;
  const resetsRaw = raw.resetsAt ?? null;
  const resetsMs = resetsRaw === null ? null : parseIsoMs(resetsRaw);
  if (resetsRaw !== null && resetsMs === null) return null;
  if (usedRaw === null && statusRaw === null) return null;
  const minutes = raw.windowMinutes;
  if (minutes !== undefined && !isPositiveInteger(minutes)) return null;

  return {
    usedPct: usedRaw === null ? null : Math.min(100, Math.max(0, usedRaw)),
    resetsAt: resetsMs === null ? null : new Date(resetsMs).toISOString(),
    ...(minutes === undefined ? {} : { windowMinutes: minutes }),
    status: statusRaw as WindowStatus | null,
    observedAt: new Date(observedMs).toISOString(),
    source: raw.source as UsageSource,
  };
}

/** Whether `value` is an integer of 1 or more. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Whether `value` is a finite number of 0 or more. */
function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** `observedAt` and `source` of a fact, normalized; `null` when either is invalid. */
function factStamp(
  raw: Record<string, unknown>
): { observedAt: string; source: UsageSource } | null {
  const observedMs = parseIsoMs(raw.observedAt);
  if (observedMs === null) return null;
  if (typeof raw.source !== 'string' || !SOURCES.has(raw.source)) return null;
  return { observedAt: new Date(observedMs).toISOString(), source: raw.source as UsageSource };
}

/**
 * Validate and normalize a stored plan (spec §1.2 "plan").
 *
 * @param raw - The ledger's `plan`, or anything.
 * @returns The plan, or `null` when there is none or it is not valid.
 */
export function readPlan(raw: unknown): PlanEntry | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || raw.name === '') return null;
  const stamp = factStamp(raw);
  return stamp === null ? null : { name: raw.name, ...stamp };
}

/**
 * Validate and normalize stored credits (spec §1.2 "credits").
 *
 * @param raw - The ledger's `credits`, or anything.
 * @returns The credits, or `null` when there are none or they are not valid.
 */
export function readCredits(raw: unknown): CreditsEntry | null {
  if (!isObject(raw)) return null;
  if (typeof raw.hasCredits !== 'boolean' || typeof raw.unlimited !== 'boolean') return null;
  const balance = raw.balance ?? null;
  if (balance !== null && typeof balance !== 'string') return null;
  const stamp = factStamp(raw);
  return stamp === null
    ? null
    : { hasCredits: raw.hasCredits, unlimited: raw.unlimited, balance, ...stamp };
}

/**
 * Validate and normalize a stored spend reading (spec §1.2 "spend"). A spend
 * reading never goes stale: it holds until a newer one replaces it.
 *
 * @param raw - The ledger's `spend`, or anything.
 * @returns The spend, or `null` when there is none or it is not valid.
 */
export function readSpend(raw: unknown): SpendEntry | null {
  if (!isObject(raw)) return null;
  const periodMs = parseIsoMs(raw.periodStart);
  if (periodMs === null || !isNonNegative(raw.costUsd)) return null;
  const limit = raw.limitUsd ?? null;
  if (limit !== null && !isNonNegative(limit)) return null;
  const stamp = factStamp(raw);
  return stamp === null
    ? null
    : {
        periodStart: new Date(periodMs).toISOString(),
        costUsd: raw.costUsd,
        limitUsd: limit,
        ...stamp,
      };
}

/** The reader for each fact kind, which is also its ledger field. */
const FACT_READERS = {
  plan: readPlan,
  credits: readCredits,
  spend: readSpend,
} as const;

/**
 * What one stored window means at `now` (spec §1.2 "Reading a window").
 *
 * - Expired (`resetsAt` set and `now >= resetsAt`): reads `usedPct 0`, `status
 *   "allowed"`, `expired: true`.
 * - Stale (`resetsAt` null and older than {@link windowLengthMs}): no reading.
 * - Otherwise: as stored. An entry that is not valid is no reading.
 *
 * @param entry - The stored entry, or `undefined`/`null` when there is none.
 * @param now - The moment to read at.
 * @param key - The window key (decides the stale age).
 * @returns The reading, or `null` for "no reading".
 */
export function readWindow(entry: unknown, now: Instant, key: string): WindowReading | null {
  const normalized = normalizeEntry(entry);
  if (normalized === null) return null;
  const nowMs = instantMs(now);
  if (normalized.resetsAt !== null) {
    if (nowMs >= Date.parse(normalized.resetsAt)) {
      return { ...normalized, usedPct: 0, status: 'allowed', expired: true };
    }
    return { ...normalized, expired: false };
  }
  if (nowMs - Date.parse(normalized.observedAt) > windowLengthMs(key, normalized)) return null;
  return { ...normalized, expired: false };
}

/** An empty v1 ledger for one account. */
function emptyLedger(owner: LedgerOwner, nowIso: string): UsageLedger {
  return {
    v: LEDGER_VERSION,
    runtime: owner.runtime,
    accountId: owner.accountId,
    updatedAt: nowIso,
    windows: {},
  };
}

/** The account a ledger belongs to. */
export interface LedgerOwner {
  /** The runtime slug. */
  runtime: RuntimeSlug;
  /** The registry id (`default` for a runtime's implicit account). */
  accountId: string;
}

/**
 * Fold observations into a ledger (spec §1.2 "Merging"). Pure: no I/O, no clock.
 *
 * - An observation is a window reading (it has a `key`) or a fact (it has a
 *   `kind`: `plan`, `credits` or `spend`).
 * - Per window key, and per fact, an observation replaces the stored entry only
 *   when its `observedAt` is strictly later; equal keeps the stored one (a replay
 *   is a no-op). A stored entry that is not valid is replaced by any valid
 *   observation.
 * - An observation more than 5 minutes after `now` is dropped
 *   (`observation-future`); an invalid one is dropped (`observation-invalid`).
 * - `runtime` and `accountId` are set to the owner's; `updatedAt` becomes `now`
 *   only when something changed. With no valid observation to store, a missing
 *   or unusable ledger stays as it is (nothing is written).
 * - Unknown ledger fields and window keys are kept. A ledger of another version
 *   is left alone (`ledger-version-unknown`); a value that is not a ledger starts
 *   over (`ledger-invalid`).
 *
 * @param existing - The parsed ledger file, or `undefined`/`null` when there is none.
 * @param observations - New readings: windows with their `key`, facts with their `kind`.
 * @param now - The merge time.
 * @param owner - The runtime and account the ledger belongs to.
 * @returns The merged ledger, whether it changed, and warnings.
 */
export function mergeLedger(
  existing: unknown,
  observations: readonly unknown[],
  now: Instant,
  owner: LedgerOwner
): MergeResult {
  const warnings: FleetWarning[] = [];
  const nowMs = instantMs(now);
  const nowIso = new Date(nowMs).toISOString();
  const { accountId } = owner;

  let base: UsageLedger;
  let changed = false;
  if (existing === undefined || existing === null) {
    base = emptyLedger(owner, nowIso);
  } else if (
    isObject(existing) &&
    typeof existing.v === 'number' &&
    existing.v !== LEDGER_VERSION
  ) {
    warnings.push({
      code: 'ledger-version-unknown',
      message: `The ledger for ${accountId} is version ${existing.v}; this reader knows ${LEDGER_VERSION} and left it alone.`,
    });
    return { ledger: existing, changed: false, warnings };
  } else if (isObject(existing) && existing.v === LEDGER_VERSION && isObject(existing.windows)) {
    base = { ...(existing as UsageLedger), windows: { ...existing.windows } };
  } else {
    warnings.push({
      code: 'ledger-invalid',
      message: `The ledger for ${accountId} is not a v1 ledger; started a new one.`,
    });
    base = emptyLedger(owner, nowIso);
  }
  if (base.runtime !== owner.runtime) {
    base.runtime = owner.runtime;
    changed = true;
  }
  if (base.accountId !== accountId) {
    base.accountId = accountId;
    changed = true;
  }

  let contentChanged = false;
  observations.forEach((raw, index) => {
    const invalid = (): void => {
      warnings.push({
        code: 'observation-invalid',
        message: `Observation ${index} is not a valid usage reading; dropped it.`,
      });
    };
    const future = (label: string, observedAt: string): boolean => {
      if (Date.parse(observedAt) - nowMs <= FUTURE_TOLERANCE_MS) return false;
      warnings.push({
        code: 'observation-future',
        message: `Observation ${index} (${label}) is dated ${observedAt}, more than 5 minutes after ${nowIso}; dropped it.`,
      });
      return true;
    };
    if (!isObject(raw)) return invalid();

    if (raw.kind !== undefined) {
      const kind = raw.kind;
      if (kind !== 'plan' && kind !== 'credits' && kind !== 'spend') return invalid();
      const fact = FACT_READERS[kind](raw);
      if (fact === null) return invalid();
      if (future(kind, fact.observedAt)) return;
      const stored = FACT_READERS[kind](base[kind]);
      if (stored !== null && Date.parse(fact.observedAt) <= Date.parse(stored.observedAt)) return;
      base[kind] = fact;
      contentChanged = true;
      return;
    }

    const key = raw.key;
    const entry = normalizeEntry(raw);
    if (entry === null || !isValidWindowKey(key)) return invalid();
    if (future(key, entry.observedAt)) return;
    const stored = normalizeEntry(base.windows[key]);
    if (stored !== null && Date.parse(entry.observedAt) <= Date.parse(stored.observedAt)) return;
    base.windows[key] = entry;
    contentChanged = true;
  });

  if (!changed && !contentChanged) return { ledger: existing, changed: false, warnings };
  base.updatedAt = nowIso;
  return { ledger: base, changed: true, warnings };
}

/** Codex's id for an account's main limit (spec §1.2, Codex). */
const CODEX_MAIN_LIMIT = 'codex';

/**
 * Codex's `rate_limits` payload (one `RateLimitSnapshot`) as observations (spec
 * §1.2 "Mapping each source", the `rollout` row; DorkOS reads the same shape from
 * the Codex SDK). Pure.
 *
 * - One account has several limits, told apart by `limit_id`, and their events
 *   alternate. Only the main limit (`limit_id` `codex`, or none) maps to plain
 *   windows: `primary` and `secondary` are keyed by their length, not their slot,
 *   with {@link windowKeyForMinutes} (300 is `five_hour`, 10080 is `seven_day`,
 *   else `window:<minutes>`).
 * - Any other limit becomes ONE `model:<slug>` bucket, the slug from
 *   `limit_name` (else `limit_id`) by {@link bucketSlug}. It holds the limit's
 *   tightest window: the highest `used_percent`, a tie going to the longer window.
 * - `used_percent` (0-100) is `usedPct`, `resets_at` (epoch seconds) is
 *   `resetsAt`, and the window's length is kept as `windowMinutes`. A window with
 *   no usable length or percentage is skipped.
 * - `status` is `null`, except when `rate_limit_reached_type` is not null: then
 *   only the window(s) that hit the limit are `rejected` (every one at 100%, else
 *   the tightest, a tie going to the shorter window), and a model bucket's one
 *   window is. The type has no other meaning here.
 * - `plan_type` becomes a `plan` fact, and `credits` a `credits` fact.
 *
 * @param rateLimits - The event's `rate_limits` object (anything; bad parts are skipped).
 * @param observedAt - When the source saw it (ISO-8601 with a zone).
 * @param source - Which source produced it. Default `rollout`.
 * @returns The observations to hand to {@link mergeLedger}.
 */
export function codexObservations(
  rateLimits: unknown,
  observedAt: string,
  source: UsageSource = 'rollout'
): (UsageObservation | FactObservation)[] {
  if (!isObject(rateLimits)) return [];
  const reached =
    rateLimits.rate_limit_reached_type !== undefined && rateLimits.rate_limit_reached_type !== null;
  const windows: { minutes: number; usedPct: number; resetsAt: string | null }[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = rateLimits[slot];
    if (!isObject(window)) continue;
    const minutes = window.window_minutes;
    const used = window.used_percent;
    if (!isPositiveInteger(minutes) || typeof used !== 'number' || !Number.isFinite(used)) continue;
    const resets = window.resets_at;
    windows.push({
      minutes,
      usedPct: used,
      resetsAt:
        typeof resets === 'number' && Number.isFinite(resets)
          ? new Date(resets * 1000).toISOString()
          : null,
    });
  }

  const out: (UsageObservation | FactObservation)[] = [];
  const limitId = rateLimits.limit_id;
  const isMain = limitId === undefined || limitId === null || limitId === CODEX_MAIN_LIMIT;
  if (isMain) {
    // A hit limit is one window's doing. Marking every window rejected would
    // lock the account out until the WEEK resets (dispatch then avoids it, so
    // no newer reading ever clears it): mark only the windows at 100%, else the
    // tightest one, a tie going to the shorter window, which resets first.
    const full = windows.filter((window) => window.usedPct >= 100);
    const hit = !reached
      ? []
      : full.length > 0
        ? full
        : [...windows].sort((a, b) => b.usedPct - a.usedPct || a.minutes - b.minutes).slice(0, 1);
    for (const window of windows) {
      out.push({
        key: windowKeyForMinutes(window.minutes) as string,
        usedPct: window.usedPct,
        resetsAt: window.resetsAt,
        windowMinutes: window.minutes,
        status: hit.includes(window) ? 'rejected' : null,
        observedAt,
        source,
      });
    }
  } else {
    const name =
      typeof rateLimits.limit_name === 'string' && rateLimits.limit_name !== ''
        ? rateLimits.limit_name
        : typeof limitId === 'string'
          ? limitId
          : '';
    const slug = bucketSlug(name);
    const tightest = [...windows].sort((a, b) => b.usedPct - a.usedPct || b.minutes - a.minutes)[0];
    if (slug !== null && tightest !== undefined) {
      out.push({
        key: `model:${slug}`,
        usedPct: tightest.usedPct,
        resetsAt: tightest.resetsAt,
        windowMinutes: tightest.minutes,
        status: reached ? 'rejected' : null,
        observedAt,
        source,
      });
    }
  }
  if (typeof rateLimits.plan_type === 'string' && rateLimits.plan_type !== '') {
    out.push({ kind: 'plan', name: rateLimits.plan_type, observedAt, source });
  }
  const credits = rateLimits.credits;
  if (
    isObject(credits) &&
    typeof credits.has_credits === 'boolean' &&
    typeof credits.unlimited === 'boolean'
  ) {
    out.push({
      kind: 'credits',
      hasCredits: credits.has_credits,
      unlimited: credits.unlimited,
      balance: typeof credits.balance === 'string' ? credits.balance : null,
      observedAt,
      source,
    });
  }
  return out;
}

/** Refuse a runtime or id that must not become part of a path. */
function checkOwner(runtime: unknown, accountId: unknown): void {
  if (!isRuntimeSlug(runtime)) {
    throw new PreconditionError(
      `"${String(runtime)}" is not a runtime flow knows (${RUNTIMES.join(', ')}), so it has no usage folder.`
    );
  }
  if (!isValidAccountId(accountId)) {
    throw new PreconditionError(
      `"${String(accountId)}" is not a valid account id (lowercase letters, digits and single hyphens), so it has no usage file.`
    );
  }
}

/** The warning for a runtime or id that has no file, or `null` when both are valid. */
function ownerWarning(runtime: unknown, accountId: unknown, what: string): FleetWarning | null {
  if (!isRuntimeSlug(runtime)) {
    return {
      code: 'runtime-invalid',
      message: `"${String(runtime)}" is not a runtime flow knows; ${what}.`,
    };
  }
  if (!isValidAccountId(accountId)) {
    return {
      code: 'account-id-invalid',
      message: `"${String(accountId)}" is not a valid account id; ${what}.`,
    };
  }
  return null;
}

/**
 * The usage folder of one runtime: `<dorkHome>/runtimes/<runtime>/usage`.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - A runtime slug.
 * @returns The absolute folder path.
 * @throws {PreconditionError} When `runtime` is not a runtime slug.
 */
export function ledgerDir(dorkHome: string, runtime: RuntimeSlug): string {
  checkOwner(runtime, 'default');
  return path.join(dorkHome, 'runtimes', runtime, 'usage');
}

/**
 * The ledger file for an account: `<dorkHome>/runtimes/<runtime>/usage/<id>.json`.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - The account's runtime slug.
 * @param accountId - A registry id, or `default` for the runtime's implicit account.
 * @returns The absolute file path.
 * @throws {PreconditionError} When the runtime or id fails its pattern (no path traversal).
 */
export function ledgerPath(dorkHome: string, runtime: RuntimeSlug, accountId: string): string {
  checkOwner(runtime, accountId);
  return path.join(ledgerDir(dorkHome, runtime), `${accountId}.json`);
}

/**
 * Read an account's ledger without a lock. Missing reads as `null`; a file that
 * is not a v1 ledger reads as `null` with a warning. An invalid runtime or id
 * reads as `null` with a `runtime-invalid` or `account-id-invalid` warning.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - The account's runtime slug.
 * @param accountId - A registry id.
 * @returns The ledger (entries unvalidated; read them with {@link readWindow},
 *   {@link readPlan}, {@link readCredits}, {@link readSpend}) and warnings.
 */
export function readLedger(
  dorkHome: string,
  runtime: RuntimeSlug,
  accountId: string
): { ledger: UsageLedger | null; warnings: FleetWarning[] } {
  const refused = ownerWarning(runtime, accountId, 'it has no usage file');
  if (refused !== null) return { ledger: null, warnings: [refused] };
  const file = ledgerPath(dorkHome, runtime, accountId);
  const read = readJsonFile(file);
  const warnings: FleetWarning[] = [...read.warnings];
  if (read.value === undefined) return { ledger: null, warnings };
  const value = read.value;
  if (!isObject(value) || value.v !== LEDGER_VERSION || !isObject(value.windows)) {
    warnings.push({
      code: 'ledger-invalid',
      message: `${file} is not a v1 usage ledger; read it as empty.`,
    });
    return { ledger: null, warnings };
  }
  return { ledger: value as UsageLedger, warnings };
}

/**
 * Merge observations into an account's ledger file under its lock (§1.2
 * "Writing"). Never throws for a lock it could not take or an invalid runtime or
 * id: both come back as `status: 'dropped'` with a warning, so a status-line hook
 * never fails a turn.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - The account's runtime slug.
 * @param accountId - A registry id.
 * @param observations - New readings.
 * @param now - The merge time. Default: the current time.
 * @returns What happened to the file, and every warning.
 */
export async function recordUsage(
  dorkHome: string,
  runtime: RuntimeSlug,
  accountId: string,
  observations: readonly unknown[],
  now: Instant = new Date()
): Promise<{ status: 'written' | 'unchanged' | 'dropped'; warnings: FleetWarning[] }> {
  const refused = ownerWarning(runtime, accountId, 'usage not recorded');
  if (refused !== null) return { status: 'dropped', warnings: [refused] };
  const mergeWarnings: FleetWarning[] = [];
  const result = await updateJsonFile(ledgerPath(dorkHome, runtime, accountId), (current) => {
    const merged = mergeLedger(current, observations, now, { runtime, accountId });
    mergeWarnings.push(...merged.warnings);
    return merged.changed ? merged.ledger : current;
  });
  return { status: result.status, warnings: [...result.warnings, ...mergeWarnings] };
}

/**
 * The account ids that have a ledger file in one runtime's usage folder: every
 * `<id>.json` whose name is a valid id. Lock, temp, corrupt-backup and stamp
 * files are not ledgers and are never listed.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - A runtime slug.
 * @returns The ids, sorted. Empty when the folder does not exist.
 */
export function listLedgerIds(dorkHome: string, runtime: RuntimeSlug): string[] {
  let names: string[];
  try {
    names = readdirSync(ledgerDir(dorkHome, runtime));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => isValidAccountId(id))
    .sort();
}

/**
 * Delete an account's ledger file under its lock (spec §1.2 "Removing an
 * account"), so a writer merging at that moment either finishes first or starts
 * after. A missing file is not an error.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param runtime - The account's runtime slug.
 * @param accountId - A registry id.
 * @returns `removed`, `missing`, or `dropped` when the lock never freed (with a warning).
 * @throws {PreconditionError} When the runtime or id fails its pattern.
 */
export async function removeLedger(
  dorkHome: string,
  runtime: RuntimeSlug,
  accountId: string
): Promise<{ status: 'removed' | 'missing' | 'dropped'; warnings: FleetWarning[] }> {
  const file = ledgerPath(dorkHome, runtime, accountId);
  const result = await withHeldLock(`${file}.lock`, async () => {
    try {
      rmSync(file);
      return 'removed' as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing' as const;
      throw error;
    }
  });
  if (!result.held) return { status: 'dropped', warnings: [result.warning] };
  return { status: result.value, warnings: [] };
}

/**
 * The ledger files to delete because their account is no longer registered
 * (spec §1.2 "Removing an account"; `flow usage prune`). Pure. `default.json`
 * is kept only while its runtime runs on the implicit account (so `registered`
 * holds `default`); once the runtime has registered accounts its readings
 * describe no account, and it goes like any other.
 *
 * @param registered - Each runtime's routable account ids (`default` only while it is implicit).
 * @param onDisk - Each runtime's ledger ids on disk ({@link listLedgerIds}).
 * @returns The ids to delete per runtime, in the order of `onDisk`.
 */
export function pruneTargets(
  registered: Readonly<Partial<Record<RuntimeSlug, readonly string[]>>>,
  onDisk: Readonly<Partial<Record<RuntimeSlug, readonly string[]>>>
): Record<RuntimeSlug, string[]> {
  const out = {} as Record<RuntimeSlug, string[]>;
  for (const runtime of RUNTIMES) {
    const known = new Set(registered[runtime] ?? []);
    out[runtime] = (onDisk[runtime] ?? []).filter((id) => !known.has(id));
  }
  return out;
}
