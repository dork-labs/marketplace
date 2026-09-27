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
   * Record a pair as reported, unless it already was. Call before reporting it.
   *
   * @param from - The source session.
   * @param to - The new session.
   * @returns True when the pair was new (so the caller reports it).
   */
  async markReported(from: string, to: string): Promise<boolean> {
    const data = await this.load();
    const pair = `${from}→${to}`;
    if (data.reported.includes(pair)) return false;
    data.reported.push(pair);
    if (data.reported.length > REPORTED_LIMIT)
      data.reported.splice(0, data.reported.length - REPORTED_LIMIT);
    delete data.claimed[from];
    await this.save(data);
    return true;
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
      this.mtimes.set(mainCheckout, mtime);
      const runs = readRuns(mainCheckout);
      for (const [source, claim] of Object.entries(data.claimed)) {
        if (claim.mainCheckout !== mainCheckout || moving.has(source)) continue;
        const run = runs[claim.issueId];
        if (run === undefined) {
          delete data.claimed[source];
          await this.save(data);
          continue;
        }
        if (run.sessionId === '' || run.sessionId === source) continue;
        if (!(await this.markReported(source, run.sessionId))) continue;
        try {
          await this.deps.accounts.markContinued(source, {
            sessionId: run.sessionId,
            runtime: run.runtime ?? 'claude-code',
            accountId: run.account ?? 'default',
          });
        } catch (error) {
          this.deps.log(
            `[flow] DorkOS did not take the move of ${run.identifier}: ${String(error)}`
          );
        }
      }
    }
  }
}
