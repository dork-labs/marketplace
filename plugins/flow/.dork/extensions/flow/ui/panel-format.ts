/**
 * The Flow tab's words: the state pills and the times it names
 * ("Paused until 9:00", "since 09:14").
 *
 * @module @dorkos/flow/extension/ui/panel-format
 */

import type { FlowProject, RunPill } from '../lib/model.ts';

/** Each state pill's words (spec `flow-multiproject` §3.2, §6.2). */
export const PILL_TEXT: Readonly<Record<RunPill, string>> = {
  building: 'Building',
  'needs-you': 'Needs you',
  'in-review': 'In review',
  'handing-off': 'Handing off',
  parked: 'Parked',
  done: 'Done',
};

/** Whole calendar days from `now`'s local date to `date`'s. */
function calendarDaysBetween(now: Date, date: Date): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(date) - day(now)) / 86_400_000);
}

/**
 * A local time of day in the person's own clock format, such as `9:00`.
 *
 * @param date - The moment.
 * @param locale - The locale (default: the browser's).
 * @returns The text.
 */
export function clockTime(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * When something happens, as briefly as is still clear: `9:00` today,
 * `tomorrow 9:00`, `Tue 9:00` within a week, else `Oct 3`.
 *
 * @param iso - The moment.
 * @param now - The moment to read from.
 * @param locale - The locale (default: the browser's).
 * @returns The text.
 */
export function formatWhen(iso: string, now: Date, locale?: string): string {
  const date = new Date(iso);
  const days = calendarDaysBetween(now, date);
  if (days === 0) return clockTime(date, locale);
  if (days === 1) return `tomorrow ${clockTime(date, locale)}`;
  if (days > 1 && days <= 6) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
    return `${weekday} ${clockTime(date, locale)}`;
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/**
 * What a paused project's header says: "Paused until 9:00", or "Paused" for a
 * pause with no end.
 *
 * @param pause - The project's pause.
 * @param now - The moment to read from.
 * @param locale - The locale (default: the browser's).
 * @returns The text.
 */
export function pausedText(
  pause: NonNullable<FlowProject['pause']>,
  now: Date,
  locale?: string
): string {
  return pause.until === null ? 'Paused' : `Paused until ${formatWhen(pause.until, now, locale)}`;
}

/**
 * The "Running" caption: "Running · 2 of 3".
 *
 * @param capacity - Busy slots of all slots.
 * @returns The text.
 */
export function runningCaption(capacity: FlowProject['capacity']): string {
  return `Running · ${capacity.busy} of ${capacity.slots}`;
}
