/**
 * "Capacity this week" on Flow home (spec `flow-multiproject` §4.4): a minimal
 * first version, built only from data flow already has, and never a forecast.
 *
 * - **Per account:** each account's weekly window as DorkOS last read it
 *   ("64% of this week · resets Thu 3pm").
 * - **Per project:** from the project's journal (`<main checkout>/.dork/flow/journal.jsonl`
 *   and its rotated `journal.1.jsonl`), read leniently line by line here:
 *   flow's own reader cannot be bundled. Hours of agent work (the sum of each
 *   stage's start/end pairs), items finished (the `done` stage's ends), and
 *   handoffs between accounts.
 *
 * There is no project × account split: nothing flow records says which
 * account paid for which project's work.
 *
 * @module @dorkos/flow/extension/capacity
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile } from '../../../../scripts/atomic-json.ts';
import {
  CONFIG_FILE,
  JOURNAL_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
  RUN_FILES_DIR,
} from '../../../../scripts/config-names.ts';
import { buildFleetView } from './fleet.ts';
import type { AccountSummary, AccountUsage } from './host-types.ts';

/** The usage window that is "this week". */
export const WEEK_WINDOW = 'seven_day';

/** The oldest start of a week the route accepts, in ms before now (a week and a day). */
const LONGEST_WEEK_MS = 8 * 24 * 60 * 60_000;

/** One account's week. */
export interface CapacityAccount {
  /** The policy key, `<runtime>:<id>`. */
  key: string;
  /** What to call it. */
  label: string;
  /** Its dot's color. */
  color: string;
  /** Share of this week's limit used, 0-100, or `null` when unknown. */
  usedPct: number | null;
  /** When the week resets, or `null`. */
  resetsAt: string | null;
}

/** One project's week, from its journal. */
export interface CapacityProject {
  /** Core's project name. */
  name: string;
  /** `off` when the project turned its journal off, so nothing is recorded. */
  journal: 'on' | 'off';
  /** Hours of agent work this week. */
  hours: number;
  /** Items finished this week. */
  finished: number;
  /** Handoffs between accounts this week. */
  handoffs: number;
}

/** The `GET /capacity` body. */
export interface CapacityView {
  /** The start of the week read. */
  since: string;
  /** Every account DorkOS knows. */
  accounts: CapacityAccount[];
  /** Every flow project, by name. */
  projects: CapacityProject[];
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Monday 00:00 local time of the week `now` is in.
 *
 * @param now - The moment.
 * @returns The start of its week.
 */
export function weekStart(now: Date): Date {
  const daysSinceMonday = (now.getDay() + 6) % 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
}

/**
 * The week the browser asked for: its own Monday 00:00, which the server's
 * clock cannot know. Anything unreadable, in the future, or more than a week
 * and a day old reads as the server's own week.
 *
 * @param raw - The `since` query value.
 * @param now - The clock.
 * @returns The start of the week.
 */
export function parseSince(raw: unknown, now: Date): Date {
  const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(at) || at > now.getTime() || now.getTime() - at > LONGEST_WEEK_MS) {
    return weekStart(now);
  }
  return new Date(at);
}

/**
 * Whether a project writes its journal: `selfImprovement.journal.enabled` in
 * its committed settings, with its own machine's file over them; on when
 * neither says.
 *
 * @param root - The project's main checkout.
 * @returns False only when turned off.
 */
export function journalEnabled(root: string): boolean {
  const dir = path.join(root, PROJECT_CONFIG_DIR);
  let enabled = true;
  for (const file of [CONFIG_FILE, LOCAL_CONFIG_FILE]) {
    const { value } = readJsonFile(path.join(dir, file));
    const self = isObject(value) ? value.selfImprovement : undefined;
    const journal = isObject(self) ? self.journal : undefined;
    if (isObject(journal) && typeof journal.enabled === 'boolean') enabled = journal.enabled;
  }
  return enabled;
}

/** What a week of journal lines adds up to. */
export interface JournalWeek {
  /** Hours of agent work. */
  hours: number;
  /** Items finished. */
  finished: number;
  /** Handoffs between accounts. */
  handoffs: number;
}

/**
 * Add up a week of journal lines. A stage's work is the time between its
 * start and its end, counted only inside the week; a start with no end yet
 * counts nothing, so an estimate never creeps in. Lines that are not JSON, or
 * lack a readable time, are skipped.
 *
 * @param lines - Journal lines, oldest first.
 * @param since - The start of the week.
 * @param now - The end of it.
 * @returns The totals.
 */
export function sumJournal(lines: readonly string[], since: Date, now: Date): JournalWeek {
  const from = since.getTime();
  const to = now.getTime();
  const started = new Map<string, number>();
  const finished = new Set<string>();
  let workMs = 0;
  let handoffs = 0;
  let unnamed = 0;
  for (const text of lines) {
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(line) || typeof line.ts !== 'string') continue;
    const at = Date.parse(line.ts);
    if (!Number.isFinite(at)) continue;
    if (line.kind === 'handoff') {
      if (at >= from && at <= to) handoffs += 1;
      continue;
    }
    if (line.kind !== 'stage' || typeof line.stage !== 'string') continue;
    const item = typeof line.item === 'string' ? line.item : '';
    const key = `${item}\0${line.stage}\0${typeof line.session === 'string' ? line.session : ''}`;
    if (line.phase === 'start') {
      started.set(key, at);
    } else if (line.phase === 'end') {
      const begin = started.get(key);
      started.delete(key);
      if (begin !== undefined) workMs += Math.max(0, Math.min(at, to) - Math.max(begin, from));
      if (line.stage === 'done' && at >= from && at <= to) {
        finished.add(item === '' ? `\0${(unnamed += 1)}` : item);
      }
    }
  }
  return { hours: workMs / 3_600_000, finished: finished.size, handoffs };
}

/**
 * Read a project's journal for the week: the rotated file first, then the
 * current one. Missing files read as empty.
 *
 * @param root - The project's main checkout.
 * @param since - The start of the week.
 * @param now - The clock.
 * @returns The totals.
 */
export async function readJournalWeek(root: string, since: Date, now: Date): Promise<JournalWeek> {
  const dir = path.join(root, RUN_FILES_DIR);
  const rotated = JOURNAL_FILE.replace(/\.jsonl$/, '.1.jsonl');
  const lines: string[] = [];
  for (const file of [rotated, JOURNAL_FILE]) {
    try {
      lines.push(...(await readFile(path.join(dir, file), 'utf8')).split('\n'));
    } catch {
      // No such file yet: nothing recorded there.
    }
  }
  return sumJournal(lines, since, now);
}

/** What {@link buildCapacity} reads. */
export interface CapacityInput {
  /** DorkOS's data folder, for flow's account names. */
  dorkHome: string;
  /** Every account DorkOS knows. */
  summaries: readonly AccountSummary[];
  /** Every account's usage, as DorkOS last read it. */
  usage: readonly AccountUsage[];
  /** The flow projects. */
  projects: readonly { name: string; root: string }[];
  /** The start of the week. */
  since: Date;
  /** The clock. */
  now: Date;
}

/**
 * Build the `GET /capacity` body.
 *
 * @param input - What to read.
 * @returns The week.
 */
export async function buildCapacity(input: CapacityInput): Promise<CapacityView> {
  const view = buildFleetView(input.dorkHome, input.summaries, input.now);
  const accounts: CapacityAccount[] = [];
  for (const group of view.groups) {
    for (const account of group.accounts) {
      const usage = input.usage.find(
        (row) => row.runtime === group.runtime && (row.accountId ?? 'default') === account.id
      );
      const week = usage?.windows.find((window) => window.key === WEEK_WINDOW && !window.expired);
      accounts.push({
        key: account.key,
        label: account.label,
        color: account.color,
        usedPct: week?.usedPct ?? null,
        resetsAt: week?.resetsAt ?? null,
      });
    }
  }
  const projects = await Promise.all(
    [...input.projects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async ({ name, root }): Promise<CapacityProject> => {
        if (!journalEnabled(root))
          return { name, journal: 'off', hours: 0, finished: 0, handoffs: 0 };
        return { name, journal: 'on', ...(await readJournalWeek(root, input.since, input.now)) };
      })
  );
  return { since: input.since.toISOString(), accounts, projects };
}
