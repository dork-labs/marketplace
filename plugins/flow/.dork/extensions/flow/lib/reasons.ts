/**
 * Plain-word reasons for the account picker (spec `claude-account-ui` §8.4):
 * "58% of the week left", "Out until Tue 3pm", "kept in reserve (50%)".
 *
 * @module @dorkos/flow/extension/reasons
 */

import type { IneligibleReason, LimitSignal } from '../../../../scripts/drain/account-rank.ts';
import { readWindow } from '../../../../scripts/fleet/usage-ledger.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * A moment as a short local day and time: `Tue 3pm`, `Tue 3:30pm`.
 *
 * @param iso - An ISO time.
 * @returns The short form, or `null` when `iso` is not a time.
 */
export function shortTime(iso: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const hours = at.getHours();
  const minutes = at.getMinutes();
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}${
    minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`
  }${hours < 12 ? 'am' : 'pm'}`;
  return `${WEEKDAYS[at.getDay()]} ${clock}`;
}

/**
 * The reason an eligible account shows: its weekly room, else its 5-hour room,
 * else that its usage is unknown.
 *
 * @param windows - The account's raw ledger windows, or `null`.
 * @param now - The clock.
 * @returns The reason.
 */
export function roomReason(windows: Record<string, unknown> | null, now: Date): string {
  const read = (key: string) =>
    windows !== null && Object.hasOwn(windows, key) ? readWindow(windows[key], now, key) : null;
  const week = read('seven_day');
  if (week?.usedPct != null)
    return `${Math.max(0, Math.round(100 - week.usedPct))}% of the week left`;
  const five = read('five_hour');
  if (five?.usedPct != null) {
    return `${Math.max(0, Math.round(100 - five.usedPct))}% of the 5-hour window left`;
  }
  return 'Usage unknown';
}

/**
 * The reason a main account is held back: `kept in reserve (<pct>%)`.
 *
 * @param effectivePct - The reserve in force now.
 * @returns The reason.
 */
export function reserveReason(effectivePct: number): string {
  return `kept in reserve (${effectivePct}%)`;
}

/**
 * The reason an account flow calls ineligible shows.
 *
 * @param reasons - Flow's reasons for it.
 * @param signal - Its limit signal.
 * @param effectivePct - Its reserve in force now.
 * @returns The reason.
 */
export function ineligibleReason(
  reasons: readonly IneligibleReason[],
  signal: LimitSignal,
  effectivePct: number
): string {
  if (reasons.includes('limited')) {
    if (signal.cause === 'reserve') return reserveReason(effectivePct);
    const until = signal.resetsAt === null ? null : shortTime(signal.resetsAt);
    return until === null ? 'Out of usage' : `Out until ${until}`;
  }
  if (reasons.includes('near-limit')) {
    const until = signal.resetsAt === null ? null : shortTime(signal.resetsAt);
    return until === null ? 'Close to its limit' : `Close to its limit until ${until}`;
  }
  if (reasons.includes('not-routable')) return "Flow can't use this account's id";
  if (reasons.includes('out-of-scope')) return 'Kept out of this repo';
  if (reasons.includes('excluded')) return 'The account that ran out';
  return 'Busy with other work';
}
