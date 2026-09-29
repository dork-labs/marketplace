/**
 * When a project's condition reaches a person (spec `flow-multiproject` §7.1,
 * V8, N11): only when only a person can fix it.
 *
 * | Condition                      | Reaches the inbox                                          |
 * | ------------------------------ | ---------------------------------------------------------- |
 * | Paused                         | never (it has an end time)                                 |
 * | Tracker slow or unreachable    | never; flow retries quietly (`tracker-reads.ts`)           |
 * | Sign-in gone (refused twice)   | at once                                                    |
 * | Nothing ready, ideas waiting   | at Ask me first only, after 24 hours idle with free room   |
 * | Nothing ready, nothing waiting | never                                                      |
 *
 * "Idle" is kept per project in the extension's storage, so a restart does
 * not reset the 24 hours.
 *
 * @module @dorkos/flow/extension/conditions
 */

import type { AutonomyStop } from '../../../../scripts/autonomy.ts';
import type { SharedStorage } from './shared-storage.ts';
import type { TrackerRead } from './tracker-reads.ts';

/** How long a project with ideas waiting sits idle before flow asks to sort them, in ms. */
export const IDLE_BEFORE_ASK_MS = 24 * 60 * 60_000;

/** The storage key: since when each project has run nothing. */
export const IDLE_KEY = 'idleSince';

/**
 * How many ideas wait to be sorted while nothing is ready to work on, from
 * the last read that answered; `null` when that is not the case.
 *
 * @param read - The project's last tracker read.
 * @returns The count, or `null`.
 */
export function ideasWaiting(read: TrackerRead | null): number | null {
  const facts = read?.facts;
  if (facts === null || facts === undefined) return null;
  if (facts.eligibleCount > 0 || facts.atWipCap || facts.shapeableCount <= 0) return null;
  return facts.shapeableCount;
}

/**
 * Whether "N new ideas haven't been sorted" is due (§7.1): ideas wait,
 * "Sort new ideas" is at Ask me first, nothing has run for a day, the project
 * has room to work, and it is not paused.
 *
 * @param input - The facts.
 * @returns True when it is due.
 */
export function ideasAskDue(input: {
  waiting: number | null;
  stop: AutonomyStop;
  idleSince: string | null;
  busy: number;
  slots: number;
  paused: boolean;
  now: Date;
}): boolean {
  if (input.waiting === null || input.stop !== 'ask' || input.paused) return false;
  if (input.busy >= input.slots || input.idleSince === null) return false;
  const since = Date.parse(input.idleSince);
  return Number.isFinite(since) && input.now.getTime() - since >= IDLE_BEFORE_ASK_MS;
}

/** Keeps, per project, since when it has run nothing. */
export class IdleClock {
  private cache: Record<string, string> | null = null;

  /**
   * @param storage - The extension's storage.
   */
  constructor(private readonly storage: SharedStorage) {}

  /** The stored map, read once. */
  private async read(): Promise<Record<string, string>> {
    if (this.cache === null) {
      const stored = await this.storage.get(IDLE_KEY);
      const map: Record<string, string> = {};
      if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        for (const [root, at] of Object.entries(stored)) {
          if (typeof at === 'string') map[root] = at;
        }
      }
      this.cache ??= map;
    }
    return this.cache;
  }

  /**
   * Note whether each project runs something now, and answer since when each
   * has run nothing (`null` while it runs something).
   *
   * @param active - Each project's root, and whether a run is active there.
   * @param now - The clock.
   * @returns Since when each project has been idle.
   */
  async note(active: ReadonlyMap<string, boolean>, now: Date): Promise<Map<string, string | null>> {
    const map = { ...(await this.read()) };
    let changed = false;
    const answer = new Map<string, string | null>();
    for (const [root, running] of active) {
      if (running) {
        if (map[root] !== undefined) {
          delete map[root];
          changed = true;
        }
        answer.set(root, null);
      } else {
        if (map[root] === undefined) {
          map[root] = now.toISOString();
          changed = true;
        }
        answer.set(root, map[root]);
      }
    }
    for (const root of Object.keys(map)) {
      if (!active.has(root)) {
        delete map[root];
        changed = true;
      }
    }
    if (changed) {
      this.cache = map;
      await this.storage.set(IDLE_KEY, map);
    }
    return answer;
  }
}
