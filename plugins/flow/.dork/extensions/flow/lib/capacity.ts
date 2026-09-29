/**
 * "Capacity this week" on Flow home (spec `flow-multiproject` §4.4): a minimal
 * first version, built only from data flow already has, and never a forecast.
 *
 * - **Per account:** each account's weekly window as DorkOS last read it
 *   ("64% of this week · resets Thu 3pm").
 * - **Per project:** from the project's journal (`<main checkout>/.dork/flow/journal.jsonl`
 *   and its rotated `journal.1.jsonl`), read leniently line by line here:
 *   flow's own reader cannot be bundled, and cached per file by size and
 *   time. Hours of agent work (each stage from its start to the item's next
 *   stage, see {@link sumMarks}), items finished (the `done` stage's ends),
 *   and handoffs between accounts.
 *
 * There is no project × account split: nothing flow records says which
 * account paid for which project's work.
 *
 * @module @dorkos/flow/extension/capacity
 */

import { readFile, stat } from 'node:fs/promises';
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

/** One journal line that matters here: a stage's start or end, or a handoff. */
export interface JournalMark {
  /** When, in ms. */
  at: number;
  /** A stage's start or end, or a handoff. */
  kind: 'start' | 'end' | 'handoff';
  /** The stage, for a start or end. */
  stage: string | null;
  /** The tracker item, or `null`. */
  item: string | null;
}

/**
 * Lines that can be a stage or a handoff. Checked before `JSON.parse`, so the
 * many other lines a journal holds (every verb, every usage reading) cost a
 * string search, not a parse.
 */
const WANTED_LINE = /"kind":\s*"(?:stage|handoff)"/;

/**
 * Pick the stage and handoff lines out of journal text. Lines that are not
 * JSON, or lack a readable time, are skipped.
 *
 * @param lines - Journal lines.
 * @returns The marks, in the order read.
 */
export function journalMarks(lines: readonly string[]): JournalMark[] {
  const marks: JournalMark[] = [];
  for (const text of lines) {
    if (!WANTED_LINE.test(text)) continue;
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObject(line) || typeof line.ts !== 'string') continue;
    const at = Date.parse(line.ts);
    if (!Number.isFinite(at)) continue;
    const item = typeof line.item === 'string' && line.item !== '' ? line.item : null;
    if (line.kind === 'handoff') {
      marks.push({ at, kind: 'handoff', stage: null, item });
    } else if (
      line.kind === 'stage' &&
      typeof line.stage === 'string' &&
      (line.phase === 'start' || line.phase === 'end')
    ) {
      marks.push({ at, kind: line.phase, stage: line.stage, item });
    }
  }
  return marks;
}

/**
 * Add up a week of journal marks.
 *
 * The engine writes a stage's start (`flow stage`) but no end except `done`'s
 * (`flow done`), so a stage runs from its start until the item's next stage
 * starts, an end line for it (only `done` has one today), or, for the stage an
 * item is in now, until now. Only the part inside the week counts. Items
 * finished are the `done` ends inside the week; handoffs are counted likewise.
 *
 * @param marks - The marks, in any order.
 * @param since - The start of the week.
 * @param now - The end of it.
 * @returns The totals.
 */
export function sumMarks(marks: readonly JournalMark[], since: Date, now: Date): JournalWeek {
  const from = since.getTime();
  const to = now.getTime();
  const inWeek = (at: number) => at >= from && at <= to;
  const span = (begin: number, end: number) =>
    Math.max(0, Math.min(end, to) - Math.max(begin, from));
  const byItem = new Map<string, JournalMark[]>();
  let handoffs = 0;
  for (const mark of marks) {
    if (mark.kind === 'handoff') {
      if (inWeek(mark.at)) handoffs += 1;
    } else if (mark.item !== null) {
      byItem.set(mark.item, [...(byItem.get(mark.item) ?? []), mark]);
    }
  }
  let workMs = 0;
  let finished = 0;
  for (const itemMarks of byItem.values()) {
    const sorted = [...itemMarks].sort((a, b) => a.at - b.at);
    let open: number | null = null;
    let done = false;
    for (const mark of sorted) {
      if (open !== null) workMs += span(open, mark.at);
      if (mark.kind === 'start') {
        open = mark.at;
      } else {
        open = null;
        if (mark.stage === 'done' && inWeek(mark.at)) done = true;
      }
    }
    if (open !== null) workMs += span(open, to);
    if (done) finished += 1;
  }
  return { hours: workMs / 3_600_000, finished, handoffs };
}

/**
 * Add up a week of journal lines ({@link journalMarks}, then {@link sumMarks}).
 *
 * @param lines - Journal lines.
 * @param since - The start of the week.
 * @param now - The end of it.
 * @returns The totals.
 */
export function sumJournal(lines: readonly string[], since: Date, now: Date): JournalWeek {
  return sumMarks(journalMarks(lines), since, now);
}

/** A file's marks as last read, and the size and time that read saw. */
interface CachedMarks {
  size: number;
  mtimeMs: number;
  marks: JournalMark[];
}

/** Each journal file's marks, read again only when its size or time changes. */
const MARKS_CACHE = new Map<string, CachedMarks>();

/** The most journal files the cache keeps. */
const MARKS_CACHE_SIZE = 200;

/**
 * A journal file's marks, from the cache while the file's size and
 * modification time are unchanged, else read again (asynchronously).
 *
 * @param file - The file.
 * @returns Its marks; none for a missing file.
 */
export async function fileMarks(file: string): Promise<JournalMark[]> {
  let info: { size: number; mtimeMs: number };
  try {
    info = await stat(file);
  } catch {
    MARKS_CACHE.delete(file);
    return [];
  }
  const cached = MARKS_CACHE.get(file);
  if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
    return cached.marks;
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const marks = journalMarks(text.split('\n'));
  MARKS_CACHE.delete(file);
  MARKS_CACHE.set(file, { size: info.size, mtimeMs: info.mtimeMs, marks });
  if (MARKS_CACHE.size > MARKS_CACHE_SIZE) {
    MARKS_CACHE.delete(MARKS_CACHE.keys().next().value as string);
  }
  return marks;
}

/**
 * Read a project's journal for the week: the rotated file and the current
 * one. Missing files read as empty.
 *
 * @param root - The project's main checkout.
 * @param since - The start of the week.
 * @param now - The clock.
 * @returns The totals.
 */
export async function readJournalWeek(root: string, since: Date, now: Date): Promise<JournalWeek> {
  const dir = path.join(root, RUN_FILES_DIR);
  const rotated = JOURNAL_FILE.replace(/\.jsonl$/, '.1.jsonl');
  const marks = (
    await Promise.all([rotated, JOURNAL_FILE].map((file) => fileMarks(path.join(dir, file))))
  ).flat();
  return sumMarks(marks, since, now);
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
