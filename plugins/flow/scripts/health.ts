/**
 * The Health block of `flow status` (DOR-3260, F4): how fresh each of this
 * project's flow schedules is, and when each intake source was last read.
 * Pure: `cli/health-read.ts` gathers the facts.
 *
 * A schedule is one of:
 *
 * - `fresh` — its last successful run started at or after the last firing it
 *   was due for;
 * - `stale` — a firing came and went with no successful run after it;
 * - `never-ran` — it is on, and DorkOS records no completed run for it (a
 *   run DorkOS left marked running is not counted, so this can undercount);
 * - `disabled` — switched off (`enabled: false`), or paused by DorkOS;
 * - `pending-approval` — it waits for the operator to approve it;
 * - `unknown` — something it needs could not be read, with why. Never healthy.
 *
 * Stale means a firing was missed: the cron's most recent firing at or before
 * now minus the grace (the schedule's max runtime, at least
 * {@link STALE_GRACE_MS}) is later than the start of its last successful run.
 * So a run still going, or a firing DorkOS skipped because the previous run
 * was still going, is not stale; and an uneven cron (weekdays 9 to 5) is
 * judged by the firing it missed, not by its longest quiet stretch. The cron
 * is read in the schedule's own timezone (UTC when it has none), so a 08:00
 * America/Los_Angeles schedule fires at 15:00 or 16:00 UTC; a timezone flow
 * cannot read is unknown.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/health
 */

/** The least grace a firing gets before it counts as missed. */
export const STALE_GRACE_MS = 60 * 60 * 1000;

/** How far the cron is scanned, back for its last firing and ahead for its gaps: covers monthly crons. */
const GAP_WINDOW_MS = 62 * 24 * 60 * 60 * 1000;

const MINUTE = 60_000;

/** One cron field, as the set of values it allows. */
type Field = Set<number>;

/**
 * Parse one field of a five-field cron: `*`, numbers, `a-b` ranges, `/n` steps
 * and comma lists.
 *
 * @param text - The field.
 * @param min - Its smallest value.
 * @param max - Its largest value.
 * @returns The allowed values, or `null` when the field cannot be read.
 */
function parseField(text: string, min: number, max: number): Field | null {
  const values: Field = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (match === null) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    let lo = min;
    let hi = max;
    if (match[1] !== '*') {
      const [a, b] = match[1].split('-').map(Number);
      lo = a;
      hi = b ?? (match[2] === undefined ? a : max);
    }
    if (step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** A parsed five-field cron. */
export interface Cron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
  /** Whether the day-of-month field was `*` (cron's day rule: either day field may match). */
  anyDayOfMonth: boolean;
  /** Whether the day-of-week field was `*`. */
  anyDayOfWeek: boolean;
}

/**
 * Parse a five-field cron (minute hour day-of-month month day-of-week). Names
 * (`MON`, `JAN`) and `@daily`-style shortcuts are not read.
 *
 * @param cron - The cron.
 * @returns The cron, or `null` when it cannot be read.
 */
export function parseCron(cron: string): Cron | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dayOfWeek = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  if (dayOfWeek.has(7)) dayOfWeek.add(0);
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    anyDayOfMonth: fields[2] === '*',
    anyDayOfWeek: fields[4] === '*',
  };
}

/** Turns a moment (ms) into the same wall-clock time written as UTC, in one timezone. */
export type ToLocal = (t: number) => number;

/**
 * A {@link ToLocal} for a timezone: the zone's offset is read once per UTC
 * half hour (offsets change only on an hour or half-hour boundary) and reused
 * for that half hour's minutes, so a 62-day scan stays cheap. A cron minute in
 * a daylight-saving fall-back's repeated hour matches its second occurrence,
 * and one in a spring-forward's skipped hour never fires; no shipped flow cron
 * runs in those hours.
 *
 * @param timeZone - An IANA zone (`America/Los_Angeles`), or `null` for UTC.
 * @returns The converter, or `null` when the zone is not one this runtime knows.
 */
export function zoneClock(timeZone: string | null): ToLocal | null {
  if (timeZone === null || timeZone === '' || timeZone === 'UTC') return (t) => t;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return null;
  }
  const offsets = new Map<number, number>();
  const HALF_HOUR = 30 * MINUTE;
  return (t) => {
    const slot = Math.floor(t / HALF_HOUR) * HALF_HOUR;
    let offset = offsets.get(slot);
    if (offset === undefined) {
      const parts = Object.fromEntries(
        format.formatToParts(new Date(slot)).map((part) => [part.type, part.value])
      );
      const wall = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute)
      );
      offset = wall - slot;
      offsets.set(slot, offset);
    }
    return t + offset;
  };
}

/** Whether `cron` fires at the wall-clock minute `at` (its UTC fields are the local time). */
function fires(cron: Cron, at: Date): boolean {
  if (!cron.minute.has(at.getUTCMinutes()) || !cron.hour.has(at.getUTCHours())) return false;
  if (!cron.month.has(at.getUTCMonth() + 1)) return false;
  const dom = cron.dayOfMonth.has(at.getUTCDate());
  const dow = cron.dayOfWeek.has(at.getUTCDay());
  // Cron's rule: with both day fields restricted, either one matching is enough.
  if (!cron.anyDayOfMonth && !cron.anyDayOfWeek) return dom || dow;
  return dom && dow;
}

/**
 * The cron's most recent firing at or before `at`, looking back 62 days.
 *
 * @param cron - The parsed cron.
 * @param at - The moment to look back from.
 * @param toLocal - The schedule's timezone (default UTC).
 * @returns The firing, in ms, or `null` when there is none in that window.
 */
export function latestFiringAtOrBefore(
  cron: Cron,
  at: Date,
  toLocal: ToLocal = (t) => t
): number | null {
  const end = Math.floor(at.getTime() / MINUTE) * MINUTE;
  for (let t = end; t > end - GAP_WINDOW_MS; t -= MINUTE) {
    if (fires(cron, new Date(toLocal(t)))) return t;
  }
  return null;
}

/**
 * The longest gap between two firings of `cron`, measured over the 62 days
 * after `from`.
 *
 * @param cron - The parsed cron.
 * @param from - Where to start measuring.
 * @param toLocal - The schedule's timezone (default UTC).
 * @returns The gap in ms, or `null` when it fires fewer than twice in that window.
 */
export function longestGapMs(cron: Cron, from: Date, toLocal: ToLocal = (t) => t): number | null {
  const start = Math.floor(from.getTime() / MINUTE) * MINUTE;
  let previous: number | null = null;
  let first: number | null = null;
  let longest = 0;
  for (let t = start; t < start + GAP_WINDOW_MS; t += MINUTE) {
    if (!fires(cron, new Date(toLocal(t)))) continue;
    if (first === null) first = t;
    if (previous !== null) longest = Math.max(longest, t - previous);
    previous = t;
  }
  return first === null || previous === null || first === previous ? null : longest;
}

/** What `cli/health-read.ts` found out about one schedule. */
export interface ScheduleFacts {
  /** The schedule's name (`flow-drain`, …). */
  name: string;
  /** Its cron, or `null`. */
  cron: string | null;
  /** Its timezone, or `null`. */
  timezone: string | null;
  /** Whether it is switched on. */
  enabled: boolean;
  /** DorkOS's status: `active`, `paused` or `pending_approval` (anything else is unknown). */
  status: string;
  /** How long one run may take, in ms, or `null` when it has no limit. */
  maxRuntimeMs?: number | null;
  /**
   * When its last successful run started (else finished), `null` when it has
   * none, or an error message when the run history could not be read.
   */
  lastSuccess: string | null | { error: string };
}

/** The state of one schedule. */
export type ScheduleState =
  'fresh' | 'stale' | 'never-ran' | 'disabled' | 'pending-approval' | 'unknown';

/** One schedule's row in the Health block. */
export interface ScheduleHealth {
  name: string;
  cron: string | null;
  timezone: string | null;
  state: ScheduleState;
  /** When its last successful run started, when known. */
  lastSuccess: string | null;
  /** One sentence for a person. */
  detail: string;
}

/** How long ago, in plain words. */
export function agoWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A gap in plain words: "every hour", "daily", "weekly", else "every N h". */
export function cadenceWords(ms: number): string {
  const hours = ms / (60 * MINUTE);
  if (hours <= 1)
    return ms === 60 * MINUTE ? 'runs hourly' : `runs every ${Math.round(ms / MINUTE)} min`;
  // A daylight-saving change makes one gap an hour longer or shorter.
  if (Math.abs(hours - 24) <= 1) return 'runs daily';
  if (Math.abs(hours - 168) <= 1) return 'runs weekly';
  return hours < 48
    ? `runs at least every ${Math.round(hours)} h`
    : `runs at least every ${Math.round(hours / 24)} days`;
}

/**
 * Judge one schedule.
 *
 * @param facts - What was read about it.
 * @param now - The moment to judge at.
 * @returns Its row.
 */
export function scheduleHealth(facts: ScheduleFacts, now: Date): ScheduleHealth {
  const base = { name: facts.name, cron: facts.cron, timezone: facts.timezone };
  const row = (state: ScheduleState, detail: string, lastSuccess: string | null = null) => ({
    ...base,
    state,
    lastSuccess,
    detail,
  });
  if (facts.status === 'pending_approval') {
    return row('pending-approval', 'pending approval: it waits for the operator to approve it');
  }
  if (!facts.enabled) return row('disabled', 'disabled: it is switched off, so it never runs');
  if (facts.status === 'paused') {
    return row(
      'disabled',
      'disabled: DorkOS paused it (its file is missing, or its agent is gone)'
    );
  }
  if (facts.status !== 'active') {
    return row(
      'unknown',
      `unknown (DorkOS reports a status flow does not know: "${facts.status}")`
    );
  }
  if (typeof facts.lastSuccess === 'object' && facts.lastSuccess !== null) {
    return row(
      'unknown',
      `unknown (its run history could not be read: ${facts.lastSuccess.error})`
    );
  }
  if (facts.lastSuccess === null)
    return row('never-ran', 'never ran: DorkOS records no completed run for it');
  const last = facts.lastSuccess;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) {
    return row('unknown', `unknown (its last run time "${last}" is not a time)`);
  }
  const cron = facts.cron === null ? null : parseCron(facts.cron);
  if (cron === null) {
    return row('unknown', `unknown (flow cannot read its cron "${facts.cron ?? ''}")`, last);
  }
  const toLocal = zoneClock(facts.timezone);
  if (toLocal === null) {
    return row('unknown', `unknown (flow cannot read its timezone "${facts.timezone}")`, last);
  }
  const grace = Math.max(facts.maxRuntimeMs ?? 0, STALE_GRACE_MS);
  const due = latestFiringAtOrBefore(cron, new Date(now.getTime() - grace), toLocal);
  if (due === null) {
    return row('unknown', `unknown (its cron "${facts.cron}" fires too rarely to judge)`, last);
  }
  const gap = longestGapMs(cron, now, toLocal);
  const cadence = gap === null ? 'runs rarely' : cadenceWords(gap);
  const when = `last successful run started ${agoWords(now.getTime() - lastMs)}, ${cadence}`;
  // A minute of slack: a run starts a moment after its firing, never before.
  return lastMs + MINUTE < due
    ? row('stale', `stale: ${when}`, last)
    : row('fresh', `fresh: ${when}`, last);
}

/** One intake source's row in the Health block. */
export interface IntakeHealth {
  /** The source's id (the tracker's, for the tracker intake). */
  id: string;
  /** Its name, when known. */
  name: string | null;
  /** When it was last read, or `null` when that is unknown. */
  lastReadAt: string | null;
  /** One sentence for a person. */
  detail: string;
}

/**
 * The intake sources and when each was last read. `flow snapshot` marks the
 * configured team and `flow intake` each GitHub source (DOR-3258, DOR-3259); a
 * source with no mark is unknown, with that reason, never healthy.
 *
 * @param sources - The sources in force (`intake.sources`), each with its mark
 *   when one is recorded.
 * @param tracker - The tracker the plain intake reads, used when no source is given.
 * @param now - The moment to judge at.
 * @returns One row per source.
 */
export function intakeHealth(
  sources: readonly {
    id: string;
    name?: string;
    lastReadAt?: string | null;
    untracked?: boolean;
  }[],
  tracker: string,
  now: Date
): IntakeHealth[] {
  const list = sources.length > 0 ? sources : [{ id: tracker }];
  return list.map((source) => {
    const mark = source.lastReadAt ?? null;
    const markMs = mark === null ? NaN : Date.parse(mark);
    return {
      id: source.id,
      name: source.name ?? null,
      lastReadAt: Number.isFinite(markMs) ? mark : null,
      detail: Number.isFinite(markMs)
        ? `last read ${agoWords(now.getTime() - markMs)}`
        : source.untracked === true
          ? 'not tracked (triage reads this queue through the adapter; flow keeps no mark for it)'
          : 'unknown (flow records no read of this source yet)',
    };
  });
}
