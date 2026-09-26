/**
 * Turn what the official Claude Code binary hands us into usage-ledger
 * observations (spec `flow-usage` §2.1, §2.4, §2.5; contract `flow-cli-core`
 * §1.2 "Mapping each source").
 *
 * Three sources, one function each, all pure:
 *
 * - {@link fromStatusLine}: the status-line JSON (`rate_limits.<window>`).
 * - {@link fromTranscriptEntry}: a `"error":"rate_limit"` entry in a transcript.
 * - {@link fromRateLimitEvent}: a `rate_limit_event` from `claude -p --output-format stream-json`.
 *
 * {@link parseResetText} reads the reset time out of a limit message such as
 * "You've hit your session limit · resets 3:30pm (America/Chicago)", for older
 * transcript entries that carry no structured `quotaLimits`.
 *
 * Dependency-free (no npm package), so `flow usage record` runs before
 * `npm install` has.
 *
 * @module @dorkos/flow/fleet/observations
 */

import type { UsageObservation, WindowStatus } from './usage-ledger.ts';

/** The contract's generic window-key pattern. Sources here never produce `model:*` keys. */
const WINDOW_KEY = /^[a-z][a-z0-9_]*$/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How far after `observedAt` a parsed reset may be, per window (window length plus 1 h). */
const RESET_BOUND_MS: Readonly<Record<string, number>> = {
  five_hour: 6 * HOUR_MS,
  seven_day: 7 * DAY_MS + HOUR_MS,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RESET_TEXT =
  /resets (?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)/;

const STATUSES = new Set<string>(['allowed', 'allowed_warning', 'rejected']);

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Epoch seconds (a number) or an ISO string to UTC ISO; `null` for anything else. */
function toIso(value: unknown): string | null {
  let ms: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    ms = value * 1000;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Clamp a percentage to 0-100. */
function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Observations from one status-line payload. Each `rate_limits.<key>` whose key
 * matches the window-key pattern and whose value holds a finite number
 * `used_percentage` becomes one `statusline` observation; everything else is
 * skipped (the ledger needs a `usedPct` or a `status`, and the status line gives
 * no status).
 *
 * @param payload - The parsed status-line JSON.
 * @param now - When `record` runs; the payload carries no timestamp of its own.
 * @returns Zero or more observations.
 */
export function fromStatusLine(payload: unknown, now: Date): UsageObservation[] {
  if (!isObject(payload) || !isObject(payload.rate_limits)) return [];
  const observedAt = now.toISOString();
  const out: UsageObservation[] = [];
  for (const [key, window] of Object.entries(payload.rate_limits)) {
    if (!WINDOW_KEY.test(key) || !isObject(window)) continue;
    const used = window.used_percentage;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    out.push({
      key,
      usedPct: clampPct(used),
      resetsAt: toIso(window.resets_at),
      status: null,
      observedAt,
      source: 'statusline',
    });
  }
  return out;
}

/** What {@link fromTranscriptEntry} found in one transcript entry. */
export type TranscriptFinding =
  { kind: 'hit'; observation: UsageObservation } | { kind: 'unidentified' } | null;

/** The first text block of a transcript entry's message, if any. */
function firstText(entry: Record<string, unknown>): string | null {
  const message = entry.message;
  if (!isObject(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

/**
 * Read one transcript entry. Only an entry with `isApiErrorMessage: true`,
 * `error: "rate_limit"` and a parsable `timestamp` is a limit hit; anything else
 * returns `null` (a user message quoting the same text included).
 *
 * The window comes from the structured `quotaLimits.rateLimitType` when present,
 * else from the text ("session limit" is `five_hour`, "weekly limit" is
 * `seven_day`). A hit naming no window, such as a model limit ("You've reached
 * your Fable limit"), is `unidentified` and never recorded: with no reset it
 * would read as rejected for 7 days under the stale rule.
 *
 * @param entry - One parsed transcript line.
 * @returns A hit, an unidentified hit, or `null` when the entry is not a hit.
 */
export function fromTranscriptEntry(entry: unknown): TranscriptFinding {
  if (!isObject(entry)) return null;
  if (entry.isApiErrorMessage !== true || entry.error !== 'rate_limit') return null;
  if (typeof entry.timestamp !== 'string') return null;
  const observedMs = Date.parse(entry.timestamp);
  if (Number.isNaN(observedMs)) return null;
  const observedAt = new Date(observedMs).toISOString();

  const quota = isObject(entry.quotaLimits) ? entry.quotaLimits : null;
  const text = firstText(entry);
  let key: string | null = null;
  if (
    quota !== null &&
    typeof quota.rateLimitType === 'string' &&
    WINDOW_KEY.test(quota.rateLimitType)
  ) {
    key = quota.rateLimitType;
  } else if (text !== null && /\bsession limit\b/.test(text)) {
    key = 'five_hour';
  } else if (text !== null && /\bweekly limit\b/.test(text)) {
    key = 'seven_day';
  }
  if (key === null) return { kind: 'unidentified' };

  let resetsAt: string | null = null;
  if (quota !== null && typeof quota.resetsAt === 'number' && Number.isFinite(quota.resetsAt)) {
    resetsAt = toIso(quota.resetsAt);
  } else if (text !== null) {
    resetsAt = parseResetText(text, observedAt, key);
  }

  return {
    kind: 'hit',
    observation: {
      key,
      usedPct: null,
      resetsAt,
      status: 'rejected',
      observedAt,
      source: 'transcript',
    },
  };
}

/**
 * Map a `rate_limit_event`'s `rate_limit_info` by the contract's `sdk_event`
 * row: key = `rateLimitType`, `usedPct` = `utilization` × 100 (the event carries
 * a 0-1 fraction), `resetsAt` from epoch seconds, `status` as given.
 *
 * @param info - The event's `rate_limit_info`.
 * @param observedAt - When the line was read.
 * @returns The observation, or `null` with no usable window type, or neither a
 *   utilization nor a status.
 */
export function fromRateLimitEvent(info: unknown, observedAt: Date): UsageObservation | null {
  if (!isObject(info)) return null;
  const key = info.rateLimitType;
  if (typeof key !== 'string' || !WINDOW_KEY.test(key)) return null;
  const utilization = info.utilization;
  const usedPct =
    typeof utilization === 'number' && Number.isFinite(utilization)
      ? clampPct(utilization * 100)
      : null;
  const status =
    typeof info.status === 'string' && STATUSES.has(info.status)
      ? (info.status as WindowStatus)
      : null;
  if (usedPct === null && status === null) return null;
  return {
    key,
    usedPct,
    resetsAt: toIso(info.resetsAt),
    status,
    observedAt: observedAt.toISOString(),
    source: 'sdk_event',
  };
}

/** A wall-clock time in some zone. `month` is 0-based. */
interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** A formatter for `zone`, or `null` when the zone is unknown. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The wall time an instant shows in the formatter's zone. */
function wallAt(format: Intl.DateTimeFormat, ms: number): WallTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month - 1,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** The zone's offset from UTC at an instant, in ms (wall minus UTC). */
function offsetAt(format: Intl.DateTimeFormat, ms: number): number {
  const floored = Math.floor(ms / 1000) * 1000;
  const wall = wallAt(format, floored);
  const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - floored;
}

/**
 * Every instant whose wall time in the zone is `target`, earliest first: none
 * for a skipped time (spring forward), two for a repeated one (fall back).
 */
function instantsFor(format: Intl.DateTimeFormat, target: WallTime): number[] {
  const guess = Date.UTC(target.year, target.month, target.day, target.hour, target.minute);
  const candidates = new Set<number>([
    guess - offsetAt(format, guess - DAY_MS),
    guess - offsetAt(format, guess + DAY_MS),
    guess - offsetAt(format, guess),
  ]);
  const matches: number[] = [];
  for (const ms of candidates) {
    const wall = wallAt(format, ms);
    if (
      wall.year === target.year &&
      wall.month === target.month &&
      wall.day === target.day &&
      wall.hour === target.hour &&
      wall.minute === target.minute
    ) {
      matches.push(ms);
    }
  }
  return matches.sort((a, b) => a - b);
}

/**
 * Read the reset time out of a limit message: "resets 3:30pm (America/Chicago)"
 * or "resets Sep 18 at 3pm (America/Chicago)".
 *
 * - Hours are a 12-hour clock: `12am` is 0, `12pm` is 12.
 * - With a date: that wall time in the year `observedAt` shows in the zone; a
 *   result more than 1 day before `observedAt` moves to the next year.
 * - Without a date: the first instant strictly after `observedAt` with that wall time.
 * - A repeated wall time takes the earlier instant; a skipped one is `null`.
 * - The result must be after `observedAt` and at most the window length plus 1 h
 *   later (`five_hour` 6 h, other windows 7 d 1 h); otherwise `null`.
 *
 * @param text - The message text.
 * @param observedAt - When the transcript entry was written (ISO).
 * @param key - The window the message is about.
 * @returns The reset as UTC ISO, or `null` when it cannot be read.
 */
export function parseResetText(text: string, observedAt: string, key: string): string | null {
  const match = RESET_TEXT.exec(text);
  if (match === null) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
  const format = formatterFor(zone);
  if (format === null) return null;
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) return null;

  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem === 'pm' ? 12 : 0);

  const observedWall = wallAt(format, observedMs);
  let result: number | null = null;

  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName);
    const day = Number(dayText);
    const first = instantsFor(format, { year: observedWall.year, month, day, hour, minute })[0];
    if (first !== undefined && first < observedMs - DAY_MS) {
      result =
        instantsFor(format, { year: observedWall.year + 1, month, day, hour, minute })[0] ?? null;
    } else {
      result = first ?? null;
    }
  } else {
    for (let offset = 0; offset <= 8 && result === null; offset++) {
      const date = new Date(
        Date.UTC(observedWall.year, observedWall.month, observedWall.day + offset)
      );
      const instants = instantsFor(format, {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        hour,
        minute,
      });
      const later = instants.find((ms) => ms > observedMs);
      if (later !== undefined) {
        result = later;
      } else if (
        instants.length === 0 &&
        (offset > 0 || hour * 60 + minute > observedWall.hour * 60 + observedWall.minute)
      ) {
        // The next time the clock would show this is skipped by a DST change, so
        // the message cannot be read. Jumping a day ahead would be a day wrong.
        break;
      }
    }
  }

  if (result === null || result <= observedMs) return null;
  const bound = RESET_BOUND_MS[key] ?? RESET_BOUND_MS.seven_day;
  if (result - observedMs > bound) return null;
  return new Date(result).toISOString();
}
