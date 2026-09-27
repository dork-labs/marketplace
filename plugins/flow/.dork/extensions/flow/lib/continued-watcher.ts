/**
 * Reports to DorkOS the moves flow makes on its own (spec `claude-account-ui`
 * §8.4, "MARK CONTINUED"): when flow's supervisor hands a claimed run to a new
 * session, the source session's plan becomes `continued` through
 * `accounts.markContinued`.
 *
 * It watches the run stores of the sessions the advisor claimed, by the file's
 * modification time on the host's schedule, and reports each (old, new) session
 * pair exactly once. The claimed sessions and the reported pairs live in the
 * extension's own storage, so a restart or a reload never reports a pair twice
 * and still finds the runs it was watching.
 *
 * @module @dorkos/flow/extension/continued-watcher
 */

import type { AccountsApi, DataProviderContext } from './host-types.ts';
import { readRuns, storeMtime, type FoundRun } from './run-store.ts';

/** How many reported pairs are remembered. */
const REPORTED_LIMIT = 500;

/**
 * How many times one pair is offered to DorkOS before the watcher gives up.
 * DorkOS refuses for good once the source is no longer one this extension may
 * move (its limit cleared, or it was never claimed there).
 */
export const REPORT_ATTEMPTS = 5;

/** What the watcher keeps in the extension's storage. */
interface WatcherData {
  /** Claimed source sessions, with the store and run they are on. */
  claimed: Record<string, { mainCheckout: string; issueId: string }>;
  /** Reported pairs, `<old>→<new>`, oldest first. */
  reported: string[];
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read stored data defensively; anything unexpected starts empty. */
function parseData(value: unknown): WatcherData {
  const data: WatcherData = { claimed: {}, reported: [] };
  if (!isObject(value)) return data;
  if (isObject(value.claimed)) {
    for (const [session, entry] of Object.entries(value.claimed)) {
      if (
        isObject(entry) &&
        typeof entry.mainCheckout === 'string' &&
        typeof entry.issueId === 'string'
      ) {
        data.claimed[session] = { mainCheckout: entry.mainCheckout, issueId: entry.issueId };
      }
    }
  }
  if (Array.isArray(value.reported)) {
    data.reported = value.reported.filter((pair): pair is string => typeof pair === 'string');
  }
  return data;
}

/** The watcher's dependencies. */
export interface WatcherDeps {
  /** The extension's storage. */
  storage: DataProviderContext['storage'];
  /** DorkOS's `markContinued`. */
  accounts: Pick<AccountsApi, 'markContinued'>;
  /** Source sessions a `move` is handing off right now: the move reports those itself. */
  moving: () => ReadonlySet<string>;
  /** Where to log. */
  log: (message: string) => void;
}

/** Reports the moves flow makes on its own. */
export class ContinuedWatcher {
  private data: WatcherData | null = null;
  private loading: Promise<WatcherData> | null = null;
  private readonly mtimes = new Map<string, number | null>();
  private checking: Promise<void> | null = null;
  private readonly reporting = new Set<string>();
  private readonly attempts = new Map<string, number>();

  /**
   * @param deps - Storage, the accounts API, the moves in flight and a logger.
   */
  constructor(private readonly deps: WatcherDeps) {}

  /** The stored data, read once. */
  private load(): Promise<WatcherData> {
    if (this.data !== null) return Promise.resolve(this.data);
    this.loading ??= this.deps.storage.loadData<unknown>().then((value) => {
      this.data = parseData(value);
      return this.data;
    });
    return this.loading;
  }

  /** Save the data; a failure is logged, never thrown. */
  private async save(data: WatcherData): Promise<void> {
    try {
      await this.deps.storage.saveData(data);
    } catch (error) {
      this.deps.log(`[flow] could not save the watcher's state: ${String(error)}`);
    }
  }

  /**
   * Remember a session the advisor claimed, so a later move of its run is reported.
   *
   * @param sessionId - The claimed session.
   * @param found - Its run and store.
   */
  async noteClaimed(sessionId: string, found: FoundRun): Promise<void> {
    const data = await this.load();
    const existing = data.claimed[sessionId];
    if (existing?.mainCheckout === found.mainCheckout && existing.issueId === found.run.issueId) {
      return;
    }
    data.claimed[sessionId] = { mainCheckout: found.mainCheckout, issueId: found.run.issueId };
    await this.save(data);
  }

  /**
   * Tell DorkOS a source session moved on, once per (old, new) pair. The pair
   * is recorded only after `markContinued` succeeds, so a failure is tried
   * again on a later pass, up to {@link REPORT_ATTEMPTS} times in all; then the
   * pair is recorded as given up, its claim dropped, and one line logged. A
   * pair already reported (or given up), or being reported now, is skipped.
   *
   * @param from - The source session.
   * @param to - Where it went.
   * @returns True when DorkOS took the report now.
   */
  async report(
    from: string,
    to: { sessionId: string; runtime: string; accountId: string }
  ): Promise<boolean> {
    const data = await this.load();
    const pair = `${from}→${to.sessionId}`;
    if (data.reported.includes(pair) || this.reporting.has(pair)) return false;
    this.reporting.add(pair);
    try {
      await this.deps.accounts.markContinued(from, to);
    } catch (error) {
      const tries = (this.attempts.get(pair) ?? 0) + 1;
      this.attempts.set(pair, tries);
      const claim = data.claimed[from];
      if (tries < REPORT_ATTEMPTS) {
        // Read that store again next pass, so the report is retried.
        if (claim !== undefined) this.mtimes.delete(claim.mainCheckout);
        return false;
      }
      this.deps.log(
        `[flow] gave up telling DorkOS that ${from} moved to ${to.sessionId} after ${tries} tries: ${String(error)}`
      );
      await this.record(data, from, pair);
      return false;
    } finally {
      this.reporting.delete(pair);
    }
    await this.record(data, from, pair);
    return true;
  }

  /** Record a pair as settled (reported or given up) and drop its source's claim. */
  private async record(data: WatcherData, from: string, pair: string): Promise<void> {
    this.attempts.delete(pair);
    data.reported.push(pair);
    if (data.reported.length > REPORTED_LIMIT) {
      data.reported.splice(0, data.reported.length - REPORTED_LIMIT);
    }
    delete data.claimed[from];
    await this.save(data);
  }

  /** Check every watched store once. Overlapping calls share one pass. */
  check(): Promise<void> {
    this.checking ??= this.pass().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** One pass: read each changed store and report sessions that moved on. */
  private async pass(): Promise<void> {
    const data = await this.load();
    const moving = this.deps.moving();
    const checkouts = new Set(Object.values(data.claimed).map((c) => c.mainCheckout));
    for (const mainCheckout of checkouts) {
      const mtime = storeMtime(mainCheckout);
      if (this.mtimes.has(mainCheckout) && this.mtimes.get(mainCheckout) === mtime) continue;
      const sources = Object.entries(data.claimed).filter(
        ([, claim]) => claim.mainCheckout === mainCheckout
      );
      // While a move of one of its runs is in flight, read this store again
      // next pass: a handoff that times out may still have written its session.
      if (!sources.some(([source]) => moving.has(source))) this.mtimes.set(mainCheckout, mtime);
      const runs = readRuns(mainCheckout);
      for (const [source, claim] of sources) {
        if (moving.has(source)) continue;
        const run = runs[claim.issueId];
        if (run === undefined) {
          delete data.claimed[source];
          await this.save(data);
          continue;
        }
        if (run.sessionId === '' || run.sessionId === source) continue;
        await this.report(source, {
          sessionId: run.sessionId,
          runtime: run.runtime ?? 'claude-code',
          accountId: run.account ?? 'default',
        });
      }
    }
  }
}
