/**
 * The `flow fleet` screen (spec `flow-usage` §2.6 "Human output"): every account
 * with its 5-hour and weekly bars, and every session with its account, item,
 * state and host. Plain, aligned and uncolored.
 *
 * Pure: the model and the clock come in, text goes out. No I/O. The module
 * imports no npm package (type-only imports from local modules are erased).
 *
 * @module @dorkos/flow/fleet/render
 */

import { formatColumns } from '../cli/output.ts';
import type { AccountRole, HandoffMode } from './accounts.ts';
import type { FleetSession } from './sessions.ts';
import type { Instant, WindowReading } from './usage-ledger.ts';

/** One account as `flow fleet` reports it (the `--json` `accounts[]` entry). */
export interface FleetAccount {
  /** The registry id. */
  id: string;
  /** The display label, or `null`. */
  label: string | null;
  /** The display color (`#rrggbb`), or `null`. */
  color: string | null;
  /** The Claude Code config dir. */
  path: string;
  /** Whether the id passes the account id pattern (only then is it tracked). */
  validId: boolean;
  /** The resolved routing role. */
  role: AccountRole;
  /** The configured weekly reserve. */
  reservePct: number;
  /** The reserve in force now (0 inside the spend-down window). */
  effectiveReservePct: number;
  /** The repos a kept-out account may still serve. */
  scopeRepos: string[];
  /** Room in the 5-hour window, or `null` with no reading. */
  fiveHourRoom: boolean | null;
  /** Room in the weekly window, or `null` with no reading. */
  weeklyRoom: boolean | null;
  /** The newest `observedAt` across its windows, or `null`. */
  lastSeen: string | null;
  /** Every window with a reading now, by key. Stale windows are absent. */
  windows: Record<string, WindowReading>;
}

/** What `flow fleet` learned about DorkOS, or `null` under `--no-dorkos`. */
export interface FleetDorkos {
  /** The URL asked. */
  url: string;
  /** Whether anything answered. */
  reachable: boolean;
  /** How many rows came from DorkOS. */
  sessionsShown: number;
}

/** Everything the screen shows. */
export interface FleetModel {
  /** The OS home folder, shown as `~` in session places. */
  home: string;
  /** The fleet handoff mode. */
  handoff: HandoffMode;
  /** The accounts in registry order. */
  accounts: FleetAccount[];
  /** The session rows, already sorted. */
  sessions: FleetSession[];
  /** DorkOS, or `null` when it was not asked. */
  dorkos: FleetDorkos | null;
  /** Whether DorkOS answered with a session list flow could read (not a 401, say). */
  dorkosListed: boolean;
}

/** The widest line the screen aims for. */
export const MAX_COLUMNS = 100;

/** The widest session place, in characters. */
const PLACE_WIDTH = 34;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Milliseconds for a clock input. */
function toMs(value: Instant): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * A 10-cell bar: `#` for each tenth used (rounded), `.` for the rest.
 *
 * @param usedPct - Percent used, 0-100.
 * @returns `[####......]`.
 */
export function bar(usedPct: number): string {
  const filled = Math.min(10, Math.max(0, Math.round(usedPct / 10)));
  return `[${'#'.repeat(filled)}${'.'.repeat(10 - filled)}]`;
}

/**
 * Time left until a reset: `<1m`, `42m`, `2h 14m`, `3d 04h`; `reset` once it has
 * passed; `-` when the reset time is unknown.
 *
 * @param resetsAt - The reset time (ISO), or `null`.
 * @param now - The moment to count from.
 * @returns The countdown text.
 */
export function countdown(resetsAt: string | null, now: Instant): string {
  if (resetsAt === null) return '-';
  const left = Date.parse(resetsAt) - toMs(now);
  if (left <= 0) return 'reset';
  if (left < MINUTE) return '<1m';
  if (left < HOUR) return `${Math.floor(left / MINUTE)}m`;
  if (left < DAY) {
    const minutes = Math.floor((left % HOUR) / MINUTE);
    return `${Math.floor(left / HOUR)}h ${String(minutes).padStart(2, '0')}m`;
  }
  const hours = Math.floor((left % DAY) / HOUR);
  return `${Math.floor(left / DAY)}d ${String(hours).padStart(2, '0')}h`;
}

/**
 * How long ago something was, in one coarse unit: `<1m`, `12m`, `3h`, `6d`.
 *
 * @param since - The earlier moment (ISO), or `null`.
 * @param now - The moment to count to.
 * @returns The age, or `-` when unknown.
 */
export function age(since: string | null, now: Instant): string {
  if (since === null) return '-';
  const elapsed = Math.max(0, toMs(now) - Date.parse(since));
  if (!Number.isFinite(elapsed)) return '-';
  if (elapsed < MINUTE) return '<1m';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  return `${Math.floor(elapsed / DAY)}d`;
}

/**
 * A session's place: the folder with the home folder as `~`, cut from the left
 * to 34 characters. Whole leading folders go first (`~/…/repo/worktree`); a last
 * folder too long on its own keeps its end.
 *
 * @param cwd - The working folder, or `null`.
 * @param home - The OS home folder.
 * @returns The place, or `-` when unknown.
 */
export function place(cwd: string | null, home: string): string {
  if (cwd === null || cwd === '') return '-';
  let shown = cwd;
  const trimmedHome = home.replace(/\/+$/, '');
  if (trimmedHome !== '' && (cwd === trimmedHome || cwd.startsWith(`${trimmedHome}/`))) {
    shown = `~${cwd.slice(trimmedHome.length)}`;
  }
  if (shown.length <= PLACE_WIDTH) return shown;
  const prefix = shown.startsWith('~/') ? '~/' : shown.startsWith('/') ? '/' : '';
  const segments = shown.slice(prefix.length).split('/');
  for (let drop = 1; drop < segments.length; drop++) {
    const candidate = `${prefix}…/${segments.slice(drop).join('/')}`;
    if (candidate.length <= PLACE_WIDTH) return candidate;
  }
  return `…${shown.slice(shown.length - (PLACE_WIDTH - 1))}`;
}

/** The width of one window cell: bar, percent and countdown. */
const CELL_WIDTH = '[..........]  100%  6d 23h'.length;

/** One window's cell: `[####......]  41%  2h 14m`, or `no reading`. */
function windowCell(reading: WindowReading | undefined, now: Instant): string {
  if (reading === undefined) return 'no reading'.padEnd(CELL_WIDTH);
  const rejected = reading.status === 'rejected';
  const used = reading.usedPct ?? (rejected ? 100 : 0);
  const pct = rejected ? 'out' : reading.usedPct === null ? '?' : `${Math.round(used)}%`;
  const time = reading.expired ? 'reset' : countdown(reading.resetsAt, now);
  return `${bar(used)}  ${pct.padStart(4)}  ${time}`.padEnd(CELL_WIDTH);
}

/** The notes after an account's bars, in the spec's order. */
function accountNotes(account: FleetAccount, now: Instant): string[] {
  const notes: string[] = [];
  if (account.reservePct > 0) {
    notes.push(
      account.effectiveReservePct === 0
        ? `reserve ${account.reservePct}% (0% now: spend-down)`
        : `reserve ${account.reservePct}%`
    );
  }
  const limited = [
    ['five_hour', '5-hour'],
    ['seven_day', 'week'],
  ]
    .filter(([key]) => account.windows[key]?.status === 'rejected')
    .map(([, name]) => name);
  if (limited.length > 0) notes.push(`limited (${limited.join(', ')})`);
  if (account.role === 'kept-out' && account.scopeRepos.length === 0) {
    notes.push('kept out of all repos');
  }
  if (account.lastSeen !== null) notes.push(`seen ${age(account.lastSeen, now)} ago`);
  return notes;
}

/** The accounts block. */
function renderAccounts(accounts: readonly FleetAccount[], now: Instant): string[] {
  if (accounts.length === 0) {
    return ['No accounts registered. Add one: flow accounts add --path ~/.claude'];
  }
  const idWidth = Math.max(...accounts.map((a) => a.id.length));
  const roleWidth = 'rotation'.length;
  const lead = 2 + idWidth + 2 + roleWidth + 2;
  const gap = '   ';
  const lines = [`${'Accounts'.padEnd(lead)}${'5-hour'.padEnd(CELL_WIDTH + gap.length)}week`];
  const rows = accounts.map((account) => {
    const id = `  ${account.id.padEnd(idWidth)}  `;
    if (!account.validId) return { cells: `${id}invalid id, not tracked`, notes: '' };
    const cells =
      `${id}${account.role.padEnd(roleWidth)}  ` +
      windowCell(account.windows.five_hour, now) +
      gap +
      windowCell(account.windows.seven_day, now);
    return { cells, notes: accountNotes(account, now).join(', ') };
  });
  // Notes sit after the bars when every row's fit in 100 columns; otherwise every
  // row's go on their own line under it, so the table keeps one shape.
  const inline = rows.every(
    ({ cells, notes }) => notes === '' || cells.length + gap.length + notes.length <= MAX_COLUMNS
  );
  for (const { cells, notes } of rows) {
    if (notes === '') lines.push(cells.trimEnd());
    else if (inline) lines.push(`${cells}${gap}${notes}`);
    else lines.push(cells.trimEnd(), `${' '.repeat(lead)}${notes}`);
  }
  return lines;
}

/** The sessions block. */
function renderSessions(sessions: readonly FleetSession[], home: string, now: Instant): string[] {
  if (sessions.length === 0) return ['Sessions: none running'];
  const rows = sessions.map((s) => [
    `  ${s.account ?? '?'}`,
    s.item ?? '-',
    s.state,
    s.host ?? '?',
    s.sessionId.slice(0, 8),
    place(s.cwd, home),
    age(s.startedAt, now),
  ]);
  return ['Sessions', ...formatColumns(rows).split('\n')];
}

/**
 * The DorkOS line under the footer: `not running` when nothing answered;
 * `running, no live sessions` when it answered with a list and no row came from
 * it (a release that reports no live sessions and one with nothing live read the
 * same, so the line claims nothing more); nothing when it contributed rows, when
 * its answer was an error (a warning says so), or when it was not asked.
 *
 * @param dorkos - What was learned about DorkOS, or `null`.
 * @param listed - Whether it answered with a readable session list.
 * @returns The line, or `null` for none.
 */
export function dorkosNote(dorkos: FleetDorkos | null, listed: boolean): string | null {
  if (dorkos === null) return null;
  if (!dorkos.reachable) return `DorkOS: not running at ${dorkos.url}`;
  if (listed && dorkos.sessionsShown === 0) {
    return `DorkOS: running at ${dorkos.url}, no live sessions`;
  }
  return null;
}

/**
 * Render the whole `flow fleet` screen.
 *
 * @param model - The accounts, sessions and DorkOS status.
 * @param now - The moment countdowns and ages are measured from.
 * @returns The text, with no trailing newline.
 */
export function renderFleet(model: FleetModel, now: Instant): string {
  const lines = [
    ...renderAccounts(model.accounts, now),
    '',
    ...renderSessions(model.sessions, model.home, now),
    '',
    'Sessions on accounts flow does not know are not shown.',
  ];
  const note = dorkosNote(model.dorkos, model.dorkosListed);
  if (note !== null) lines.push(note);
  return lines.join('\n');
}
