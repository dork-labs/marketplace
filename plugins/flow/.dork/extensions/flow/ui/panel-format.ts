/**
 * The Flow panel's words and tones, mirroring the DorkOS client's own usage
 * helpers (`apps/client/src/layers/shared/lib/claude-accounts.ts`: `barTone`,
 * `formatResetDay`, `formatResetTime`, `planName`) and `UsageMiniBars`'s
 * accessible sentence, which an extension cannot import. Keep them in step.
 *
 * @module @dorkos/flow/extension/ui/panel-format
 */

import type { PanelAccount, PanelWindow, RunPill } from '../lib/panel.ts';

/** The tone a usage bar is drawn in. */
export type BarTone = 'unknown' | 'error' | 'warning' | 'success';

/** The share of a window at which a bar turns amber. */
const BAR_WARNING_PCT = 70;

/**
 * The host's `barTone`: `error` when the window rejected work or is full,
 * `warning` from 70%, `success` below, and `unknown` with no reading.
 *
 * @param entry - The window, or `null` with no reading.
 * @returns The tone.
 */
export function barTone(entry: PanelWindow | null): BarTone {
  if (!entry) return 'unknown';
  if (entry.status === 'rejected') return 'error';
  if (entry.usedPct === null) return 'unknown';
  if (entry.usedPct >= 100) return 'error';
  if (entry.usedPct >= BAR_WARNING_PCT) return 'warning';
  return 'success';
}

/** Each tone's host color variable (`bg-status-*`, as `UsageMiniBars` fills). */
export const TONE_VARIABLE: Readonly<Record<Exclude<BarTone, 'unknown'>, string>> = {
  success: 'status-success',
  warning: 'status-warning-dot',
  error: 'status-error',
};

/** How much of a bar is filled, 0-100; an unknown window is an empty track. */
export function barFill(entry: PanelWindow | null): number {
  if (entry === null || entry.usedPct === null) return 0;
  return Math.max(0, Math.min(100, entry.usedPct));
}

/** One window's part of the bars' sentence. */
function windowSentence(name: string, entry: PanelWindow | null): string {
  return entry === null || entry.usedPct === null
    ? `${name} usage unknown`
    : `${name} ${Math.round(entry.usedPct)}% used`;
}

/**
 * The mini bars' accessible sentence, as the host's `UsageMiniBars` says it:
 * "5-hour window 40% used, weekly 72% used".
 *
 * @param windows - The account's windows.
 * @returns The sentence.
 */
export function barsSentence(windows: PanelAccount['windows']): string {
  return `${windowSentence('5-hour window', windows.five_hour)}, ${windowSentence('weekly', windows.seven_day)}`;
}

/** Whole calendar days from `now`'s local date to `date`'s. */
function calendarDaysBetween(now: Date, date: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(date) - day(now)) / 86_400_000);
}

/** Local time as `2:10pm` or `3pm`. */
function timeOfDay(date: Date, locale?: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const minute = part('minute');
  const period = part('dayPeriod').toLowerCase().replace(/[.\s]/g, '');
  return `${part('hour')}${minute && minute !== '00' ? `:${minute}` : ''}${period}`;
}

/** The short weekday name, such as `Tue`. */
function weekday(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
}

/**
 * The host's `formatResetDay`: the weekday a window resets, or the time when
 * it resets today.
 *
 * @param iso - The reset time.
 * @param now - The moment to read from.
 * @param locale - The locale for day names.
 * @returns The text.
 */
export function formatResetDay(iso: string, now: Date, locale?: string): string {
  const date = new Date(iso);
  return calendarDaysBetween(now, date) === 0 ? timeOfDay(date, locale) : weekday(date, locale);
}

/**
 * The host's `formatResetTime`: `2:10pm` today, `Tue 3pm` within six days,
 * else `Oct 3`.
 *
 * @param iso - The reset time.
 * @param now - The moment to read from.
 * @param locale - The locale for day and month names.
 * @returns The text.
 */
export function formatResetTime(iso: string, now: Date, locale?: string): string {
  const date = new Date(iso);
  const days = calendarDaysBetween(now, date);
  if (days === 0) return timeOfDay(date, locale);
  if (Math.abs(days) <= 6) return `${weekday(date, locale)} ${timeOfDay(date, locale)}`;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/**
 * The muted words after an account's name: "out · resets Tue" when it is out
 * ("out" when the reset is unknown), "reserved" when flow is keeping Main's
 * reserve, "unknown" when neither window has a reading (the host's unknown
 * state, as a Codex or OpenCode sign-in with no usage read yet), else nothing.
 *
 * @param account - The account.
 * @param now - The moment to read from.
 * @returns The words, or `null`.
 */
export function accountStateText(account: PanelAccount, now: Date): string | null {
  if (account.out !== null) {
    return account.out.resetsAt === null
      ? 'out'
      : `out · resets ${formatResetDay(account.out.resetsAt, now)}`;
  }
  if (account.reserved) return 'reserved';
  const { five_hour: five, seven_day: week } = account.windows;
  const unread = (entry: PanelWindow | null) => entry === null || entry.usedPct === null;
  return unread(five) && unread(week) ? 'unknown' : null;
}

/**
 * The host's `planName`: `Max plan`, or `null` to leave it out.
 *
 * @param plan - The plan's name as its source reports it.
 * @returns The text, or `null`.
 */
export function planName(plan: string | null): string | null {
  if (!plan) return null;
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`;
}

/**
 * A window's line in the account popover: "40% · resets 2:10pm".
 *
 * @param entry - The window.
 * @param now - The moment to read from.
 * @returns The text.
 */
export function windowDetail(entry: PanelWindow, now: Date): string {
  const pct = entry.usedPct === null ? 'usage unknown' : `${Math.round(entry.usedPct)}%`;
  return entry.resetsAt === null ? pct : `${pct} · resets ${formatResetTime(entry.resetsAt, now)}`;
}

/** Each state pill's words. */
export const PILL_TEXT: Readonly<Record<RunPill, string>> = {
  building: 'building',
  'in-review': 'in review',
  'waiting-on-you': 'waiting on you',
  'handing-off': 'handing off',
  parked: 'parked',
};
