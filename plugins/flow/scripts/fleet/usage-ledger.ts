/**
 * The usage ledger (spec `flow-cli-core` §1.2): one JSON file per account at
 * `<dorkHome>/usage/<account-id>.json`, holding the latest reading of each
 * rate-limit window that account has.
 *
 * This is a shared contract. DorkOS writes the same files from its own
 * sessions, and both sides prove they agree with the case files in
 * `plugins/flow/conformance/fleet/` (`window-read`, `ledger-merge`). Change a rule
 * here only together with that folder's `CONTRACT_VERSION`.
 *
 * The pure core is {@link readWindow} (what one stored window means right now)
 * and {@link mergeLedger} (fold new observations into a ledger). The file side,
 * {@link readLedger} and {@link recordUsage}, wraps them with the shared
 * lock-and-rename writer in `../atomic-json.ts`.
 *
 * Dependency-free (node builtins and local zero-dependency modules only), so a
 * status-line hook can record usage before `npm install` has run.
 *
 * @module @dorkos/flow/fleet/usage-ledger
 */

import path from 'node:path';
import { readJsonFile, updateJsonFile } from '../atomic-json.ts';
import { PreconditionError } from '../errors.ts';

/** The ledger format version this module reads and writes. */
export const LEDGER_VERSION = 1;

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

/** A per-model bucket key: `model:<slug>`. */
const MODEL_KEY_PATTERN = /^model:[a-z0-9][a-z0-9._-]*$/;

/** Any other window key, so a new SDK window needs no contract change. */
const GENERIC_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** ISO-8601 with an explicit zone (`Z` or `+hh:mm`). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An observation may be at most this far after `now`; later ones come from a bad clock. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** How long a `five_hour` reading with no `resetsAt` stays current. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** How long any other reading with no `resetsAt` stays current. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
const SOURCES = new Set(['statusline', 'sdk_event', 'sdk_usage', 'transcript']);

/** A rate-limit status as the SDK reports it. */
export type WindowStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** Where a reading came from (spec §1.2 "Mapping each source"). */
export type UsageSource = 'statusline' | 'sdk_event' | 'sdk_usage' | 'transcript';

/** One stored window. */
export interface WindowEntry {
  /** Percent used, 0-100, or `null` when the source gave none. */
  usedPct: number | null;
  /** When the window resets (UTC ISO), or `null` when unknown. */
  resetsAt: string | null;
  /** The source's status, or `null` when it gave none. */
  status: WindowStatus | null;
  /** When the SOURCE saw this reading (UTC ISO), not when it was written. */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/** A new reading for one window, as a writer hands it to {@link mergeLedger}. */
export interface UsageObservation extends Partial<
  Pick<WindowEntry, 'usedPct' | 'resetsAt' | 'status'>
> {
  /** The window key (`five_hour`, `seven_day`, `model:<slug>`, ...). */
  key: string;
  /** When the source saw it; ISO-8601 with an explicit zone. */
  observedAt: string;
  /** Which source produced it. */
  source: UsageSource;
}

/** The v1 ledger file. Unknown fields are kept by writers. */
export interface UsageLedger {
  /** Always 1. */
  v: 1;
  /** The registry id this ledger belongs to. */
  accountId: string;
  /** The last write, any window (UTC ISO). */
  updatedAt: string;
  /** Window key to entry. May hold keys (and values) this reader does not use. */
  windows: Record<string, unknown>;
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
 * Whether `key` is an allowed window key: a known key, `model:<slug>`, or any
 * `^[a-z][a-z0-9_]*$`.
 *
 * @param key - A window key.
 * @returns True when a writer may store it.
 */
export function isValidWindowKey(key: unknown): key is string {
  return typeof key === 'string' && (MODEL_KEY_PATTERN.test(key) || GENERIC_KEY_PATTERN.test(key));
}

/**
 * How long a reading with no `resetsAt` stays current: 5 h for `five_hour`, 7 days
 * for every other key.
 *
 * @param key - A window key.
 * @returns The length in milliseconds.
 */
export function windowLengthMs(key: string): number {
  return key === 'five_hour' ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
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

  return {
    usedPct: usedRaw === null ? null : Math.min(100, Math.max(0, usedRaw)),
    resetsAt: resetsMs === null ? null : new Date(resetsMs).toISOString(),
    status: statusRaw as WindowStatus | null,
    observedAt: new Date(observedMs).toISOString(),
    source: raw.source as UsageSource,
  };
}

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
  if (nowMs - Date.parse(normalized.observedAt) > windowLengthMs(key)) return null;
  return { ...normalized, expired: false };
}

/** An empty v1 ledger for `accountId`. */
function emptyLedger(accountId: string, nowIso: string): UsageLedger {
  return { v: LEDGER_VERSION, accountId, updatedAt: nowIso, windows: {} };
}

/**
 * Fold observations into a ledger (spec §1.2 "Merging"). Pure: no I/O, no clock.
 *
 * - Per window key, an observation replaces the stored entry only when its
 *   `observedAt` is strictly later; equal keeps the stored one (a replay is a
 *   no-op). A stored entry that is not valid is replaced by any valid observation.
 * - An observation more than 5 minutes after `now` is dropped
 *   (`observation-future`); an invalid one is dropped (`observation-invalid`).
 * - `updatedAt` becomes `now` only when something changed. With no valid
 *   observation to store, a missing or unusable ledger stays as it is (nothing
 *   is written).
 * - Unknown ledger fields and window keys are kept. A ledger of another version
 *   is left alone (`ledger-version-unknown`); a value that is not a ledger starts
 *   over (`ledger-invalid`).
 *
 * @param existing - The parsed ledger file, or `undefined`/`null` when there is none.
 * @param observations - New readings, each with its window `key`.
 * @param now - The merge time.
 * @param accountId - The account the ledger belongs to.
 * @returns The merged ledger, whether it changed, and warnings.
 */
export function mergeLedger(
  existing: unknown,
  observations: readonly unknown[],
  now: Instant,
  accountId: string
): MergeResult {
  const warnings: FleetWarning[] = [];
  const nowMs = instantMs(now);
  const nowIso = new Date(nowMs).toISOString();

  let base: UsageLedger;
  let changed = false;
  if (existing === undefined || existing === null) {
    base = emptyLedger(accountId, nowIso);
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
    base = emptyLedger(accountId, nowIso);
  }
  if (base.accountId !== accountId) {
    base.accountId = accountId;
    changed = true;
  }

  let windowsChanged = false;
  observations.forEach((raw, index) => {
    const key = isObject(raw) ? raw.key : undefined;
    const entry = normalizeEntry(raw);
    if (entry === null || !isValidWindowKey(key)) {
      warnings.push({
        code: 'observation-invalid',
        message: `Observation ${index} is not a valid window reading; dropped it.`,
      });
      return;
    }
    if (Date.parse(entry.observedAt) - nowMs > FUTURE_TOLERANCE_MS) {
      warnings.push({
        code: 'observation-future',
        message: `Observation ${index} (${key}) is dated ${entry.observedAt}, more than 5 minutes after ${nowIso}; dropped it.`,
      });
      return;
    }
    const stored = normalizeEntry(base.windows[key]);
    if (stored !== null && Date.parse(entry.observedAt) <= Date.parse(stored.observedAt)) return;
    base.windows[key] = entry;
    windowsChanged = true;
  });

  if (!changed && !windowsChanged) return { ledger: existing, changed: false, warnings };
  base.updatedAt = nowIso;
  return { ledger: base, changed: true, warnings };
}

/**
 * The ledger file for an account: `<dorkHome>/usage/<id>.json`.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param accountId - A registry id.
 * @returns The absolute file path.
 * @throws {PreconditionError} When the id fails the account id pattern (no path traversal).
 */
export function ledgerPath(dorkHome: string, accountId: string): string {
  if (!isValidAccountId(accountId)) {
    throw new PreconditionError(
      `"${accountId}" is not a valid account id (lowercase letters, digits and single hyphens), so it has no usage file.`
    );
  }
  return path.join(dorkHome, 'usage', `${accountId}.json`);
}

/**
 * Read an account's ledger without a lock. Missing reads as `null`; a file that
 * is not a v1 ledger reads as `null` with a warning. An invalid id reads as
 * `null` with an `account-id-invalid` warning.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param accountId - A registry id.
 * @returns The ledger (windows unvalidated; read them with {@link readWindow}) and warnings.
 */
export function readLedger(
  dorkHome: string,
  accountId: string
): { ledger: UsageLedger | null; warnings: FleetWarning[] } {
  if (!isValidAccountId(accountId)) {
    return {
      ledger: null,
      warnings: [
        {
          code: 'account-id-invalid',
          message: `"${accountId}" is not a valid account id; it has no usage file.`,
        },
      ],
    };
  }
  const file = ledgerPath(dorkHome, accountId);
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
 * "Writing"). Never throws for a lock it could not take or an invalid id: both
 * come back as `status: 'dropped'` with a warning, so a status-line hook never
 * fails a turn.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param accountId - A registry id.
 * @param observations - New readings.
 * @param now - The merge time. Default: the current time.
 * @returns What happened to the file, and every warning.
 */
export async function recordUsage(
  dorkHome: string,
  accountId: string,
  observations: readonly unknown[],
  now: Instant = new Date()
): Promise<{ status: 'written' | 'unchanged' | 'dropped'; warnings: FleetWarning[] }> {
  if (!isValidAccountId(accountId)) {
    return {
      status: 'dropped',
      warnings: [
        {
          code: 'account-id-invalid',
          message: `"${accountId}" is not a valid account id; usage not recorded.`,
        },
      ],
    };
  }
  const mergeWarnings: FleetWarning[] = [];
  const result = await updateJsonFile(ledgerPath(dorkHome, accountId), (current) => {
    const merged = mergeLedger(current, observations, now, accountId);
    mergeWarnings.push(...merged.warnings);
    return merged.changed ? merged.ledger : current;
  });
  return { status: result.status, warnings: [...result.warnings, ...mergeWarnings] };
}
