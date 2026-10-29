/**
 * The Health block of `flow status` (DOR-3260, F4): how fresh each of this
 * project's flow schedules is, and when each intake source was last read.
 * Pure: `cli/health-read.ts` gathers the facts.
 *
 * A schedule is one of:
 *
 * - `fresh` — its last successful run is within one cron interval;
 * - `stale` — its last successful run is older than one cron interval allows;
 * - `never-ran` — it is on, and DorkOS records no completed run for it (a
 *   run DorkOS left marked running is not counted, so this can undercount);
 * - `disabled` — switched off (`enabled: false`), or paused by DorkOS;
 * - `pending-approval` — it waits for the operator to approve it;
 * - `unknown` — something it needs could not be read, with why. Never healthy.
 *
 * "One cron interval" is the longest gap between two firings of the cron, over
 * the next 62 days, plus {@link STALE_GRACE_MS} for a run that started late.
 * The cron is read in UTC: a gap does not depend on the timezone, but for the
 * hour a daylight-saving change adds or removes.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/health
 */

/** Slack on top of one cron interval before a schedule counts as stale. */
export const STALE_GRACE_MS = 60 * 60 * 1000;

/** How far ahead the cron's gaps are measured: covers monthly crons. */
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

/** Whether `cron` fires at the UTC minute `at`. */
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
 * The longest gap between two firings of `cron`, measured over the 62 days
 * after `from`.
 *
 * @param cron - The parsed cron.
 * @param from - Where to start measuring.
 * @returns The gap in ms, or `null` when it fires fewer than twice in that window.
 */
export function longestGapMs(cron: Cron, from: Date): number | null {
  const start = Math.floor(from.getTime() / MINUTE) * MINUTE;
  let previous: number | null = null;
  let first: number | null = null;
  let longest = 0;
  for (let t = start; t < start + GAP_WINDOW_MS; t += MINUTE) {
    if (!fires(cron, new Date(t))) continue;
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
  if (hours === 24) return 'runs daily';
  if (hours === 168) return 'runs weekly';
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
  const gap = longestGapMs(cron, now);
  if (gap === null) {
    return row('unknown', `unknown (its cron "${facts.cron}" fires too rarely to judge)`, last);
  }
  const age = now.getTime() - lastMs;
  const when = `last successful run started ${agoWords(age)}, ${cadenceWords(gap)}`;
  return age > gap + STALE_GRACE_MS
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
 * The intake sources and when each was last read. Flow records no read of an
 * intake source yet (F2 and F3, DOR-3258 and DOR-3259, add a mark per source),
 * so every row is unknown with that reason; a source that carries a mark
 * shows it.
 *
 * @param sources - The configured sources (`connection.intake`), each with its
 *   mark when one is recorded.
 * @param tracker - The tracker the plain intake reads, used when no source is configured.
 * @param now - The moment to judge at.
 * @returns One row per source.
 */
export function intakeHealth(
  sources: readonly { id: string; name?: string; lastReadAt?: string | null }[],
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
        : 'unknown (flow records no read of this source yet)',
    };
  });
}
