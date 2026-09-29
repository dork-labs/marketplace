/**
 * Sorting new ideas every morning on its own (spec `flow-multiproject` §7.7,
 * §7.9), where a project's "Sort new ideas" is at Tell me after or Just do it.
 *
 * At 09:00 local time, every project that is due (ideas waiting, not paused,
 * no sorting in the last 20 hours) is queued, most ideas first, and one is
 * started every 15 minutes in a new chat through `ctx.sessions.start`. flow
 * keeps its own starts well inside DorkOS's limits (10 an hour, 3 running), so
 * a person's click is never the one refused: at most 4 automatic starts an
 * hour, and none while 2 chats flow started are still running. A project not
 * reached by 13:00 waits for tomorrow and says so on its page.
 *
 * Each start leaves a "While you were away" row: unread at Tell me after,
 * quiet at Just do it.
 *
 * On a DorkOS that cannot start a chat nothing sorts on its own.
 *
 * @module @dorkos/flow/extension/daily-sort
 */

import type { AutonomyStop } from '../../../../scripts/autonomy.ts';
import { readJournalSince } from './decisions.ts';
import type { SessionsApi } from './host-types.ts';
import type { SharedStorage } from './shared-storage.ts';
import { isStartRefusal, startWords } from './start-words.ts';

/** The hour sorting starts, local time. */
export const SORT_HOUR = 9;

/** The hour sorting gives up for the day, local time. */
export const GIVE_UP_HOUR = 13;

/** The gap between two automatic starts, in ms. */
export const SORT_GAP_MS = 15 * 60_000;

/** The most automatic starts in a rolling hour. */
export const MAX_AUTO_STARTS_PER_HOUR = 4;

/** No automatic start while this many chats flow started are running. */
export const MAX_RUNNING = 2;

/**
 * How long a chat flow started counts as running. DorkOS does not tell an
 * extension when a started chat's turn ends, so a start counts for this long
 * (a sorting turn is usually shorter), which errs on the side of starting less.
 */
export const RUNNING_FOR_MS = 30 * 60_000;

/** No sorting when some ran within this long, in ms. */
export const RECENT_SORT_MS = 20 * 60 * 60_000;

/** The storage key. */
export const DAILY_SORT_KEY = 'dailySort';

/** One project the daily sort looks at. */
export interface SortCandidate {
  /** Its main checkout. */
  root: string;
  /** Its name. */
  name: string;
  /** Ideas waiting to be sorted. */
  waiting: number;
  /** Whether it is paused. */
  paused: boolean;
  /** The "Sort new ideas" stop. */
  stop: AutonomyStop;
}

/** What the sort keeps between passes. */
interface SortState {
  /** Every start flow made from the server, newest last. */
  starts: string[];
  /** When each project was last sorted by flow. */
  sorted: Record<string, string>;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the stored state leniently. */
function stateOf(value: unknown): SortState {
  const record = isObject(value) ? value : {};
  const starts = Array.isArray(record.starts)
    ? record.starts.filter((at): at is string => typeof at === 'string')
    : [];
  const sorted: Record<string, string> = {};
  if (isObject(record.sorted)) {
    for (const [root, at] of Object.entries(record.sorted)) {
      if (typeof at === 'string') sorted[root] = at;
    }
  }
  return { starts, sorted };
}

/**
 * Today's 09:00, local time.
 *
 * @param now - The clock.
 * @returns The time.
 */
export function sortStartOf(now: Date): Date {
  const at = new Date(now);
  at.setHours(SORT_HOUR, 0, 0, 0);
  return at;
}

/**
 * When sorting last ran in a project: flow's own start, or the journal's
 * newest `item.readied` line from `flow triage`.
 *
 * @param root - The project's main checkout.
 * @param ownStart - When flow last started sorting there, or `undefined`.
 * @returns The newest time, or `null`.
 */
export function lastSortOf(root: string, ownStart: string | undefined): string | null {
  const { lines } = readJournalSince(root, '');
  let last: string | null = ownStart ?? null;
  for (const line of lines) {
    if (line.kind !== 'item.readied' || line.by !== 'triage' || typeof line.ts !== 'string')
      continue;
    if (last === null || line.ts > last) last = line.ts;
  }
  return last;
}

/** What the daily sort needs. */
export interface DailySortDeps {
  /** The extension's storage. */
  storage: SharedStorage;
  /** Starting work in a new chat, when the host has it. */
  sessions?: SessionsApi;
  /** The clock. */
  now: () => Date;
  /** Where to log. */
  log: (message: string) => void;
  /** Leave the "While you were away" row for a start. */
  record: (candidate: SortCandidate, sessionId: string) => Promise<void>;
  /** When sorting last ran in a project (default: {@link lastSortOf}). */
  lastSort?: (root: string, ownStart: string | undefined) => string | null;
}

/** Starts the morning's sorting, one project at a time. */
export class DailySort {
  /**
   * @param deps - Storage, the start seam, the clock and a logger.
   */
  constructor(private readonly deps: DailySortDeps) {}

  /**
   * Note a start flow made from the server (a button in the inbox), so the
   * morning's sorting counts it against its limits.
   */
  async noteStart(): Promise<void> {
    const at = this.deps.now().toISOString();
    await this.deps.storage.update(DAILY_SORT_KEY, (current) => {
      const state = stateOf(current);
      return { ...state, starts: [...state.starts, at].slice(-50) };
    });
  }

  /**
   * One pass: start the next due project when a slot is free.
   *
   * @param candidates - Every set-up project, with its ideas and stop.
   * @returns The roots whose sorting waits until tomorrow.
   */
  async tick(candidates: readonly SortCandidate[]): Promise<Set<string>> {
    const waits = new Set<string>();
    const sessions = this.deps.sessions;
    if (sessions === undefined || typeof sessions.start !== 'function') return waits;
    const now = this.deps.now();
    const start = sortStartOf(now);
    if (now.getTime() < start.getTime()) return waits;
    const state = stateOf(await this.deps.storage.get(DAILY_SORT_KEY));
    const lastSort = this.deps.lastSort ?? lastSortOf;
    const due = candidates
      .filter((candidate) => {
        if (candidate.stop === 'ask' || candidate.paused || candidate.waiting <= 0) return false;
        const own = state.sorted[candidate.root];
        if (own !== undefined && Date.parse(own) >= start.getTime()) return false;
        const last = lastSort(candidate.root, own);
        return last === null || now.getTime() - Date.parse(last) >= RECENT_SORT_MS;
      })
      .sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));
    if (due.length === 0) return waits;
    if (now.getHours() >= GIVE_UP_HOUR) {
      for (const candidate of due) waits.add(candidate.root);
      return waits;
    }
    const at = now.getTime();
    const times = state.starts.map((iso) => Date.parse(iso)).filter(Number.isFinite);
    const lastStart = times.length === 0 ? -Infinity : Math.max(...times);
    const inHour = times.filter((t) => at - t < 60 * 60_000).length;
    const running = times.filter((t) => at - t < RUNNING_FOR_MS).length;
    if (
      at - lastStart < SORT_GAP_MS ||
      inHour >= MAX_AUTO_STARTS_PER_HOUR ||
      running >= MAX_RUNNING
    ) {
      return waits;
    }
    const next = due[0];
    const words = startWords('daily-sort', { name: next.name });
    let sessionId: string;
    try {
      ({ sessionId } = await sessions.start({
        project: next.root,
        prompt: words.prompt,
        title: words.title,
        reason: words.reason,
      }));
    } catch (error) {
      if (isStartRefusal(error) && error.code === 'start_limit') return waits;
      this.deps.log(`[flow] could not start sorting ${next.name}: ${String(error)}`);
      await this.mark(next.root, now);
      return waits;
    }
    await this.mark(next.root, now, true);
    try {
      await this.deps.record(next, sessionId);
    } catch (error) {
      this.deps.log(`[flow] could not record the sorting of ${next.name}: ${String(error)}`);
    }
    return waits;
  }

  /** Remember a project as sorted today, and count the start. */
  private async mark(root: string, now: Date, started = false): Promise<void> {
    const at = now.toISOString();
    await this.deps.storage.update(DAILY_SORT_KEY, (current) => {
      const state = stateOf(current);
      return {
        starts: started ? [...state.starts, at].slice(-50) : state.starts,
        sorted: { ...state.sorted, [root]: at },
      };
    });
  }
}
