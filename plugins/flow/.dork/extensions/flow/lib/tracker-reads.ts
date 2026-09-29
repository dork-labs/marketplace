/**
 * Reading each project's tracker for "Up next" and for whether the tracker
 * answers (spec `flow-multiproject` §2.2, §7.1).
 *
 * The extension never loads a tracker adapter itself (it cannot load zod). It
 * runs this extension's own flow CLI (`<flowRoot>/scripts/flow.ts`) against
 * the project, as pausing does:
 *
 * 1. `flow snapshot --json --out <dorkHome>/flow/cache/<projectId>/snapshot.json`
 *    pulls the backlog once;
 * 2. `flow next --count 3 --json --no-account --manual --snapshot <file>` ranks
 *    it. `--manual` only lets the read run while the project is paused; `next`
 *    writes nothing.
 *
 * Rules:
 *
 * - Only a project on the `cli` transport with the adapter flow ships is read
 *   on the timer. A project's own adapter is code committed to its repo, and
 *   runs only after a person allows it; until then nothing is read.
 * - Every 5 minutes per project, at most two reads at once, never two for one
 *   project, and at once when a Flow tab looks at a project whose last read is
 *   over a minute old.
 * - The exit code decides health: 0 answered; 4 did not (a refused sign-in,
 *   twice in a row, is `auth`, anything else `unreachable`, retried after 1, 2,
 *   then 5 minutes); 3 is a settings problem; anything else is logged and
 *   changes nothing.
 *
 * The model only ever takes the last read ({@link TrackerReader.latest}), so a
 * slow tracker never delays it.
 *
 * @module @dorkos/flow/extension/tracker-reads
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ExecError, ExecFileLike } from './advisor.ts';
import type { QueueItem } from './model.ts';
import type { FlowProjectEntry } from './projects.ts';

/** How long "Up next" is read at most per project: once every 5 minutes, in ms. */
export const READ_INTERVAL_MS = 5 * 60_000;

/** How old a read may be before a Flow tab looking at the project asks for a new one, in ms. */
export const STALE_ON_VIEW_MS = 60_000;

/** The waits after each failed read in a row, in ms; the last repeats. */
export const RETRY_AFTER_MS = [60_000, 2 * 60_000, 5 * 60_000] as const;

/** The most reads at once, across every project. */
export const MAX_READS_AT_ONCE = 2;

/** How many items "Up next" shows. */
export const UP_NEXT_COUNT = 3;

/** How long one read command may take, in ms. */
const READ_TIMEOUT_MS = 60_000;

/** A backlog can be large: the snapshot's JSON is printed whole. */
const READ_MAX_BUFFER = 64 * 1024 * 1024;

/** flow's exit codes this module tells apart (`scripts/errors.ts` `EXIT`). */
const EXIT_CONFIG = 3;
const EXIT_TRACKER = 4;

/** What the last reads of one project found. */
export interface TrackerRead {
  /** When the tracker last answered, or `null`. */
  at: string | null;
  /** "Up next" from the last read that answered, or `null` before one. */
  queue: { next: QueueItem[]; more: number } | null;
  /** The team's page in the tracker, when the adapter reports it. */
  teamUrl: string | null;
  /** What `flow next` said about the queue, from the last read that answered. */
  facts: {
    eligibleCount: number;
    shapeableCount: number;
    starved: boolean;
    atWipCap: boolean;
  } | null;
  /** Why the tracker does not answer now, and since when; `null` when it does. */
  failure: { kind: 'unreachable' | 'auth' | 'settings'; since: string } | null;
}

/** The short id of a project: the first 12 hex characters of the SHA-256 of its root. */
export function projectIdOf(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether flow can read a project's tracker on its own, from here.
 *
 * @param entry - The project.
 * @returns True for a set-up project on the `cli` transport whose adapter flow ships.
 */
export function canReadOnTimer(entry: FlowProjectEntry): boolean {
  return (
    entry.setup === 'ready' &&
    entry.tracker !== null &&
    entry.tracker.transport === 'cli' &&
    entry.tracker.adapter === 'shipped'
  );
}

/** One command's result. */
interface CommandResult {
  /** The exit code; 0 on success, `null` when it did not run or was killed. */
  code: number | null;
  /** What it printed. */
  stdout: string;
}

/** The last JSON value a command printed, or `null`. */
function lastJson(stdout: string): unknown {
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Per-project read state. */
interface ReadState {
  read: TrackerRead;
  inFlight: boolean;
  /** When the next read on the timer is due, ms. */
  dueAt: number;
  /** When the last read started, ms. */
  startedAt: number | null;
  /** Failed reads in a row. */
  failures: number;
  /** Refused sign-ins in a row. */
  refusals: number;
}

/** What the reader needs. */
export interface TrackerReaderDeps {
  /** The DorkOS home, for the snapshot cache. */
  dorkHome: string;
  /** This extension's flow folder. */
  flowRoot: string;
  /** Runs a command with no shell. */
  execFile: ExecFileLike;
  /** The clock. */
  now: () => Date;
  /** Where to log. */
  log: (message: string) => void;
  /** Called when a read changed what the model shows. */
  onChange: () => void;
}

/** Reads each project's tracker on a timer, a few at a time. */
export class TrackerReader {
  private readonly states = new Map<string, ReadState>();
  private readonly wanted = new Set<string>();
  private running = 0;
  private disposed = false;

  /**
   * @param deps - flow's folder, the command runner, the clock and a logger.
   */
  constructor(private readonly deps: TrackerReaderDeps) {}

  /**
   * The last read of a project, or `null` before one finished.
   *
   * @param root - The project's main checkout.
   * @returns The read.
   */
  latest(root: string): TrackerRead | null {
    const state = this.states.get(root);
    if (state === undefined) return null;
    return state.read.at === null && state.read.failure === null ? null : state.read;
  }

  /**
   * Ask for a read of a project a Flow tab is looking at, when its last read
   * started over a minute ago.
   *
   * @param root - The project's main checkout.
   */
  view(root: string): void {
    this.wanted.add(root);
  }

  /**
   * Start the reads that are due, up to {@link MAX_READS_AT_ONCE} at once:
   * the ones a Flow tab asked for first, then the rest by when they fell due.
   * Returns at once; each read reports through `onChange`.
   *
   * @param projects - Every flow project now.
   */
  tick(projects: readonly FlowProjectEntry[]): void {
    if (this.disposed) return;
    const now = this.deps.now().getTime();
    const readable = new Map(
      projects.filter(canReadOnTimer).map((entry) => [entry.root, entry] as const)
    );
    for (const root of [...this.states.keys()]) {
      if (!readable.has(root)) this.states.delete(root);
    }
    const due: { entry: FlowProjectEntry; order: number }[] = [];
    for (const entry of readable.values()) {
      const state = this.stateOf(entry.root);
      if (state.inFlight) continue;
      const viewed =
        this.wanted.has(entry.root) &&
        (state.startedAt === null || now - state.startedAt > STALE_ON_VIEW_MS);
      if (viewed) due.push({ entry, order: -Infinity });
      else if (now >= state.dueAt) due.push({ entry, order: state.dueAt });
    }
    this.wanted.clear();
    due.sort((a, b) => a.order - b.order);
    for (const { entry } of due) {
      if (this.running >= MAX_READS_AT_ONCE) break;
      void this.read(entry);
    }
  }

  /** Stop starting reads. */
  dispose(): void {
    this.disposed = true;
  }

  /** A project's state, created empty and due now. */
  private stateOf(root: string): ReadState {
    let state = this.states.get(root);
    if (state === undefined) {
      state = {
        read: { at: null, queue: null, teamUrl: null, facts: null, failure: null },
        inFlight: false,
        dueAt: 0,
        startedAt: null,
        failures: 0,
        refusals: 0,
      };
      this.states.set(root, state);
    }
    return state;
  }

  /** Run one command of flow's CLI against a project. */
  private run(args: readonly string[]): Promise<CommandResult> {
    const script = path.join(this.deps.flowRoot, 'scripts', 'flow.ts');
    return new Promise((resolve) => {
      this.deps.execFile(
        'node',
        ['--experimental-strip-types', script, ...args],
        { timeout: READ_TIMEOUT_MS, shell: false, encoding: 'utf8', maxBuffer: READ_MAX_BUFFER },
        (error: ExecError | null, stdout: string) => {
          if (error === null) resolve({ code: 0, stdout });
          else resolve({ code: typeof error.code === 'number' ? error.code : null, stdout });
        }
      );
    });
  }

  /** Read one project and record what it found. */
  private async read(entry: FlowProjectEntry): Promise<void> {
    const state = this.stateOf(entry.root);
    const started = this.deps.now();
    state.inFlight = true;
    state.startedAt = started.getTime();
    this.running += 1;
    const before = JSON.stringify(state.read);
    try {
      const file = path.join(
        this.deps.dorkHome,
        'flow',
        'cache',
        projectIdOf(entry.root),
        'snapshot.json'
      );
      const snapshot = await this.run([
        'snapshot',
        '--json',
        '--out',
        file,
        '--project',
        entry.root,
      ]);
      if (snapshot.code !== 0) {
        this.failed(entry, state, snapshot, started);
        return;
      }
      const next = await this.run([
        'next',
        '--count',
        String(UP_NEXT_COUNT),
        '--json',
        '--no-account',
        '--manual',
        '--snapshot',
        file,
        '--project',
        entry.root,
      ]);
      if (next.code !== 0) {
        this.failed(entry, state, next, started);
        return;
      }
      this.answered(state, next.stdout, file, started);
    } finally {
      state.inFlight = false;
      this.running -= 1;
      if (this.states.get(entry.root) === state && JSON.stringify(state.read) !== before) {
        this.deps.onChange();
      }
    }
  }

  /** Record a read the tracker answered. */
  private answered(state: ReadState, stdout: string, file: string, started: Date): void {
    const body = lastJson(stdout);
    const picked =
      isObject(body) && Array.isArray(body.picked)
        ? body.picked.flatMap((item): QueueItem[] =>
            isObject(item) && typeof item.identifier === 'string'
              ? [
                  {
                    identifier: item.identifier,
                    title: typeof item.title === 'string' ? item.title : '',
                  },
                ]
              : []
          )
        : [];
    const count = (key: string) =>
      isObject(body) && typeof body[key] === 'number' ? (body[key] as number) : 0;
    const flag = (key: string) => isObject(body) && body[key] === true;
    const eligibleCount = count('eligibleCount');
    let teamUrl: string | null = null;
    try {
      const snapshot: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const url = isObject(snapshot) && isObject(snapshot.team) ? snapshot.team.url : null;
      teamUrl = typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
    } catch {
      // The file is the snapshot just written; without it, the link is hidden.
    }
    state.read = {
      at: started.toISOString(),
      queue: { next: picked, more: Math.max(0, eligibleCount - picked.length) },
      teamUrl,
      facts: {
        eligibleCount,
        shapeableCount: count('shapeableCount'),
        starved: flag('starved'),
        atWipCap: flag('atWipCap'),
      },
      failure: null,
    };
    state.failures = 0;
    state.refusals = 0;
    state.dueAt = started.getTime() + READ_INTERVAL_MS;
  }

  /** Record a read that failed, by its exit code. */
  private failed(
    entry: FlowProjectEntry,
    state: ReadState,
    result: CommandResult,
    started: Date
  ): void {
    const since = state.read.failure?.since ?? started.toISOString();
    if (result.code === EXIT_TRACKER) {
      const body = lastJson(result.stdout);
      const error = isObject(body) && isObject(body.error) ? body.error : {};
      state.refusals = error.kind === 'auth' ? state.refusals + 1 : 0;
      // One refusal can be a token mid-refresh; two in a row is a sign-in that is gone.
      const kind = state.refusals >= 2 ? 'auth' : 'unreachable';
      state.read = { ...state.read, failure: { kind, since } };
      state.failures += 1;
      const wait = RETRY_AFTER_MS[Math.min(state.failures, RETRY_AFTER_MS.length) - 1];
      state.dueAt = started.getTime() + wait;
      return;
    }
    if (result.code === EXIT_CONFIG) {
      // A missing config.json makes the project not set up (projects.ts), so this is a real problem.
      state.read = { ...state.read, failure: { kind: 'settings', since } };
      state.dueAt = started.getTime() + READ_INTERVAL_MS;
      return;
    }
    this.deps.log(
      `[flow] could not read the tracker of ${entry.name} (exit ${String(result.code)}); trying again later`
    );
    state.dueAt = started.getTime() + READ_INTERVAL_MS;
  }
}
