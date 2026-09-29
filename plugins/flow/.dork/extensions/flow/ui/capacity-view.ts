/**
 * Flow home's "Capacity this week" tab (spec `flow-multiproject` §4.4): each
 * account's weekly use, and each project's hours of agent work, items finished
 * and handoffs, since Monday 00:00 in the person's own time. Facts only,
 * never a forecast. Read when the tab opens, not pushed.
 *
 * @module @dorkos/flow/extension/ui/capacity-view
 */

import type { CapacityAccount, CapacityProject, CapacityView } from '../lib/capacity.ts';
import { UNREACHABLE_MESSAGE, getCapacity } from './api.ts';
import { formatWhen } from './panel-format.ts';
import { BAND, BAND_ROW } from './page-parts.ts';
import { Dot, MUTED } from './parts.ts';
import { isoWithOffset } from './pause-menu.ts';
import { h, useEffect, useState, type Node } from './react.ts';
import { ALERT } from './styles.ts';

/** How long a read of Capacity is reused, so opening the tab again doesn't read again, in ms. */
export const CAPACITY_REUSE_MS = 60_000;

/** The last read, for the week it was for. */
let lastRead: { since: string; at: number; view: CapacityView } | null = null;

/** Forget the last read (tests). */
export function forgetCapacity(): void {
  lastRead = null;
}

/** Said for a project whose journal is off. */
export const JOURNAL_OFF_TEXT = 'Not recorded: the journal is off in this project.';

/** Said for a project with nothing in its journal this week. */
export const NOTHING_RECORDED_TEXT = 'Nothing recorded this week.';

/**
 * Monday 00:00 in the browser's own time, for the week it shows.
 *
 * @param now - The clock.
 * @returns The start of the week, with its offset.
 */
export function browserWeekStart(now: Date): string {
  const back = (now.getDay() + 6) % 7;
  return isoWithOffset(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
}

/**
 * One account's week: "64% of this week · resets Thu 3:00 PM".
 *
 * @param account - The account.
 * @param now - The clock.
 * @param locale - The locale (default: the browser's).
 * @returns The words.
 */
export function accountWeekText(account: CapacityAccount, now: Date, locale?: string): string {
  if (account.usedPct === null) return "This week's use isn't known yet.";
  const used = `${Math.round(account.usedPct)}% of this week`;
  return account.resetsAt === null
    ? used
    : `${used} · resets ${formatWhen(account.resetsAt, now, locale)}`;
}

/**
 * One project's week: "3.5 hours of agent work · 2 finished · 1 handoff".
 *
 * @param project - The project.
 * @returns The words.
 */
export function projectWeekText(project: CapacityProject): string {
  if (project.journal === 'off') return JOURNAL_OFF_TEXT;
  if (project.hours === 0 && project.finished === 0 && project.handoffs === 0) {
    return NOTHING_RECORDED_TEXT;
  }
  const hours = Math.round(project.hours * 10) / 10;
  const parts = [`${hours} hour${hours === 1 ? '' : 's'} of agent work`];
  if (project.finished > 0) parts.push(`${project.finished} finished`);
  if (project.handoffs > 0) {
    parts.push(`${project.handoffs} handoff${project.handoffs === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/**
 * The tab.
 *
 * @param props - The project to narrow to (the page's filter), or `null` for all.
 * @returns The tab's content.
 */
export function CapacityTab(props: { project: string | null; now?: () => Date }): Node {
  const clock = props.now ?? (() => new Date());
  const reusable = (since: string) =>
    lastRead !== null &&
    lastRead.since === since &&
    clock().getTime() - lastRead.at < CAPACITY_REUSE_MS
      ? lastRead.view
      : null;
  const [view, setView] = useState<CapacityView | null>(() => reusable(browserWeekStart(clock())));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const since = browserWeekStart(clock());
    if (reusable(since) !== null) return;
    let live = true;
    getCapacity(since).then(
      (next) => {
        lastRead = { since, at: clock().getTime(), view: next };
        if (live) setView(next);
      },
      (failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : UNREACHABLE_MESSAGE);
      }
    );
    return () => {
      live = false;
    };
  }, []);
  if (error !== null) return h('p', { role: 'alert', style: ALERT }, error);
  if (view === null) return h('div', { 'aria-busy': true });
  const now = clock();
  const projects = view.projects.filter(
    (project) => props.project === null || project.name === props.project
  );
  return h(
    'div',
    null,
    h('p', { style: MUTED }, 'Since Monday. What flow recorded, never a forecast.'),
    h('h2', { style: BAND }, 'Accounts'),
    view.accounts.length === 0 ? h('p', { style: MUTED }, 'DorkOS has no accounts to show.') : null,
    ...view.accounts.map((account) =>
      h(
        'div',
        { key: account.key, className: 'flow-drow', style: { ...BAND_ROW, alignItems: 'center' } },
        h(
          'span',
          {
            className: 'flow-pcol',
            style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 },
          },
          h(Dot, { color: account.color }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, account.label)
        ),
        h('span', { style: { ...MUTED, fontSize: '12px', flex: 1 } }, accountWeekText(account, now))
      )
    ),
    h('h2', { style: BAND }, 'Projects'),
    ...projects.map((project) =>
      h(
        'div',
        { key: project.name, className: 'flow-drow', style: BAND_ROW },
        h('span', { className: 'flow-pcol', style: { fontWeight: 600 } }, project.name),
        h('span', { style: { ...MUTED, fontSize: '12px', flex: 1 } }, projectWeekText(project))
      )
    ),
    h(
      'p',
      { style: { ...MUTED, marginTop: '10px' } },
      "Flow doesn't record which account paid for which project's work, so the two lists stay apart."
    )
  );
}
