/**
 * The Flow tab's data (spec `flow-multiproject` §2.1): every flow project on
 * this computer, each with its runs, what is up next, its pause, what is wrong
 * with it, and whether its flow is older than this extension's.
 * `GET /api/ext/flow/model` answers it, and the server re-sends it as the
 * `model` event when it changes.
 *
 * Everything here is read from flow's own files, leniently and without zod
 * (DorkOS bundles this module): each project's run store through flow's
 * `readRunStore`, its drain settings through {@link readDrainSettings}, its
 * pause flag at flow's own path. The tracker is never read here: the model
 * takes the last cached read from `tracker-reads.ts`, so building it never
 * waits on a network call.
 *
 * @module @dorkos/flow/extension/model
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PAUSE_FILE, PROJECT_CONFIG_DIR } from '../../../../scripts/config-names.ts';
import { liveKey } from '../../../../scripts/drain/live-count.ts';
import {
  IMPLICIT_ACCOUNT_ID,
  resolveAccountRef,
  type RuntimeAccount,
} from '../../../../scripts/fleet/accounts.ts';
import {
  ACTIVE_RUN_STATUSES,
  readRunStore,
  sessionState,
} from '../../../../scripts/fleet/sessions.ts';
import { isRuntimeSlug } from '../../../../scripts/fleet/usage-ledger.ts';
import { pidExists } from '../../../../scripts/cli/host-io.ts';
import type { ExecFileLike } from './advisor.ts';
import { readDrainSettings } from './drain-settings.ts';
import { RouteError } from './fleet.ts';
import type { FlowProjectEntry } from './projects.ts';
import { GIT_TIMEOUT_MS } from './run-store.ts';
import type { TrackerRead } from './tracker-reads.ts';

/** A run's state pill. `done` is only for the run chip (a run completed in the last day). */
export type RunPill = 'building' | 'needs-you' | 'in-review' | 'handing-off' | 'parked' | 'done';

/** One item of "Up next". */
export interface QueueItem {
  /** The tracker item, such as `DOR-2412`. */
  identifier: string;
  /** Its title. */
  title: string;
}

/** One run row. */
export interface FlowRunRow {
  /** The tracker item, such as `DOR-2387`. */
  identifier: string;
  /** The item's title, or `null` when the run record has none. */
  title: string | null;
  /** A link to the item, or `null` when the record has none. */
  url: string | null;
  /** The run's session, or `null` while none has started. */
  sessionId: string | null;
  /** The chat that launched the run, or `null`. */
  dispatchedBy: string | null;
  /** The folder its session runs in: the run's worktree, else the project's checkout. */
  cwd: string;
  /** The account it runs on: its key, what to call it, and its dot's color. */
  account: { key: string; label: string; color: string };
  /** What it is doing. */
  state: RunPill;
  /** The newest timestamp on the record, or `null` (§6.2). */
  updatedAt: string | null;
}

/**
 * Something wrong with a project that a person can see. `sign-in` and
 * `settings-problem` are the two kinds the spec's table words separately from
 * a slow tracker (§2.2, §7.1); the paused condition is drawn in the header.
 */
export interface FlowCondition {
  /** What is wrong. */
  kind: 'paused' | 'tracker-unreachable' | 'sign-in' | 'settings-problem' | 'nothing-ready';
  /** When it began. */
  since: string;
  /** Whether an inbox item is live for it (always false until flow asks in the inbox). */
  escalated: boolean;
  /** For nothing-ready: items waiting to be sorted. */
  detail: { untriaged?: number };
}

/** An open decision flow raised (spec §2.1); none are raised until flow asks in the inbox. */
export interface FlowDecision {
  /** flow's key, before core namespaces it. */
  key: string;
  /** The project's name. */
  project: string;
  /** What kind of ask. */
  kind: 'review' | 'question' | 'tracker-unreachable' | 'nothing-ready';
  /** The headline. */
  title: string;
  /** Behind ⓘ, or `null`. */
  detail: string | null;
  /** The item, for review and question. */
  identifier: string | null;
  /** When it was raised. */
  raisedAt: string;
  /** Which buttons it has. */
  actions: 'ship' | 'question' | 'sign-in' | 'sort' | 'retry';
  /** What happens, why now, what "no" means. */
  why: string;
  /** Questions: the agent's pick. */
  defaultChoice: string | null;
  /** Questions: the deadline. */
  decideBy: string | null;
}

/** One flow project in the model. */
export interface FlowProject {
  /** Core's project name. */
  name: string;
  /** Its main checkout. */
  root: string;
  /** `not-set-up`: flow is installed but has no `.agents/flow/config.json`. */
  setup: 'ready' | 'not-set-up';
  /** Its tracker ("Linear", team "DOR"), or `null` when not set up. */
  tracker: { label: string; team: string | null; url: string | null } | null;
  /** Its pause, or `null` when it is not paused. */
  pause: { since: string | null; until: string | null } | null;
  /** Its runs: active ones, then any completed in the last day (`done`). */
  runs: FlowRunRow[];
  /** "Up next", or `null` when flow cannot read it from here (or has not yet). */
  queue: { next: QueueItem[]; more: number } | null;
  /**
   * Whether flow reads "Up next" on its own: `read` (the adapter flow ships,
   * over `cli`), `agent-only` (the `mcp` transport works only inside an
   * agent's session), or `own-code` (the project's own adapter, which flow
   * never runs without a person's say).
   */
  upNext: 'read' | 'agent-only' | 'own-code';
  /** Live drain runs, and the drain's slots. */
  capacity: { busy: number; slots: number };
  /** What is wrong with it. */
  conditions: FlowCondition[];
  /** Its flow's version, its behaviour level, and what an older one lacks. */
  version: { flow: string | null; behaviour: number; olderBehaviour: string | null };
  /**
   * DorkOS schedules a pause switched off that are now due back on. Only a
   * person's browser can switch a schedule on, so the Flow tab does it and
   * then tells the server (§5.2).
   */
  restoreSchedules: string[];
}

/** The `GET /model` body. */
export interface FlowModel {
  /** This extension's flow behaviour level (§9.3). */
  behaviour: number;
  /** When it was built. */
  generatedAt: string;
  /** Every flow project, sorted by name. */
  projects: FlowProject[];
  /** Open decisions flow raised, every project, oldest first. */
  decisions: FlowDecision[];
  /** The project name for `?cwd=`, for hosts without `currentProject` (§10). */
  cwdProject: string | null;
  /**
   * Whether pausing and resuming work from the Flow tab: false on a DorkOS
   * with no way to tell a person from an agent, where those routes are not
   * registered (§10).
   */
  canChange: boolean;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drain phases a run is in review in. */
const REVIEW_PHASES = new Set(['reviewing', 'pr-ready', 'watching']);

/** Limit states in which the run waits without moving. */
const WAITING_LIMIT_STATES = new Set(['waiting-reset', 'awaiting-handoff']);

/** How long a completed run still shows, as `done`, in ms. */
export const DONE_SHOWN_MS = 24 * 60 * 60_000;

/**
 * A run's state pill, from its raw record. The first rule that matches wins:
 *
 * 1. **handing off**: `limit.state` is `handing-off` (a move is under way) or
 *    `winding-down` (the worker is finishing up before one).
 * 2. **needs you**: `limit.state` is `pending-approval` (ask mode wants the
 *    operator's move); or a person's hold (`limit.heldBy: 'person'`) that will
 *    not resume by itself (`resumeOnReset: false`); or the drain parked it for
 *    a person (`drain.phase: 'parked'`, `drain.parkedFor: 'person'`).
 * 3. **parked**: the drain parked it for any other reason; or `limit.state` is
 *    `waiting-reset` or `awaiting-handoff`; or any other `limit.heldBy` hold.
 * 4. **in review**: `drain.phase` is `reviewing`, `pr-ready` or `watching`.
 * 5. **building**: everything else: `working`, `fixing`, `fixing-ci` or
 *    `closing`, a `queued` run, and a run with no drain record.
 *
 * A run whose `status` is `complete` is `done` before any of these.
 *
 * @param run - The run as stored (read leniently).
 * @returns The pill.
 */
export function runState(run: unknown): RunPill {
  const record = isObject(run) ? run : {};
  if (record.status === 'complete') return 'done';
  const limit = isObject(record.limit) ? record.limit : null;
  const drain = isObject(record.drain) ? record.drain : null;
  const parked = drain?.phase === 'parked';
  if (limit?.state === 'handing-off' || limit?.state === 'winding-down') return 'handing-off';
  if (limit?.state === 'pending-approval') return 'needs-you';
  if (limit?.heldBy === 'person' && limit.resumeOnReset === false) return 'needs-you';
  if (parked && drain.parkedFor === 'person') return 'needs-you';
  if (parked) return 'parked';
  if (typeof limit?.state === 'string' && WAITING_LIMIT_STATES.has(limit.state)) return 'parked';
  if (limit !== null && limit.heldBy !== undefined && limit.heldBy !== null) return 'parked';
  if (typeof drain?.phase === 'string' && REVIEW_PHASES.has(drain.phase)) return 'in-review';
  return 'building';
}

/**
 * A run's last update (§6.2): the newest of `updatedAt`, `heartbeatAt`,
 * `checkpointAt`, `drain.parkedAt`, `limit.since` and `startedAt`.
 *
 * @param run - The run as stored.
 * @returns The newest readable timestamp, or `null`.
 */
export function lastUpdateOf(run: Record<string, unknown>): string | null {
  const drain = isObject(run.drain) ? run.drain : {};
  const limit = isObject(run.limit) ? run.limit : {};
  let best: { at: number; iso: string } | null = null;
  for (const value of [
    run.updatedAt,
    run.heartbeatAt,
    run.checkpointAt,
    drain.parkedAt,
    limit.since,
    run.startedAt,
  ]) {
    if (typeof value !== 'string') continue;
    const at = Date.parse(value);
    if (Number.isFinite(at) && (best === null || at > best.at)) best = { at, iso: value };
  }
  return best?.iso ?? null;
}

/**
 * Whether a run holds a drain slot: flow's runner counts a drain run that is
 * queued or running and not parked (`isActive` in `drain/runner.ts`).
 *
 * @param run - The run as stored.
 * @returns True when it is live.
 */
export function isLiveDrainRun(run: Record<string, unknown>): boolean {
  const drain = run.drain;
  if (!isObject(drain) || drain.v !== 1 || drain.phase === 'parked') return false;
  return run.status === 'queued' || run.status === 'running';
}

/**
 * The drain slots one project offers: its `drain.parallel`, where flow's
 * sequential default `0` runs one at a time.
 *
 * @param parallel - The project's `drain.parallel`.
 * @returns The slots.
 */
export function slotsOf(parallel: number): number {
  return parallel === 0 ? 1 : parallel;
}

/**
 * The file whose presence pauses flow in a project (flow's `pauseState`).
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The flag's path.
 */
export function pauseFlagPath(mainCheckout: string): string {
  return path.join(mainCheckout, PROJECT_CONFIG_DIR, PAUSE_FILE);
}

/** A project's pause flag as written, whatever its end. */
export interface PauseFlag {
  /** When the pause began, or `null` when unreadable. */
  since: string | null;
  /** When it ends by itself, or `null` for no end (or an end that cannot be read). */
  until: string | null;
  /** Whether it still pauses at the time it was judged against. */
  pauses: boolean;
}

/**
 * Read a project's pause flag the way flow's `pauseState` does: a flag with no
 * end, an end that cannot be read, or an end still to come pauses; a flag
 * that cannot be read at all pauses too (the safe side). A timed pause whose
 * end has passed is over.
 *
 * @param file - The flag's path.
 * @param now - The time to judge the end against.
 * @returns The flag, or `null` when there is none.
 */
export function readPauseFlag(file: string, now: Date = new Date()): PauseFlag | null {
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { since: null, until: null, pauses: true };
  }
  const since = isObject(value) && typeof value.pausedAt === 'string' ? value.pausedAt : null;
  const raw = isObject(value) ? value.until : undefined;
  const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (typeof raw !== 'string' || !Number.isFinite(at)) return { since, until: null, pauses: true };
  return { since, until: raw, pauses: at > now.getTime() };
}

/** The most folders a {@link CheckoutResolver} remembers. */
export const RESOLVER_CACHE_SIZE = 500;

/**
 * The main checkout of a folder, from git, without blocking the event loop:
 * the parent of `git rev-parse --git-common-dir` (flow's `resolveMainCheckout`).
 *
 * @param cwd - Any folder.
 * @returns The main checkout, or `null` outside git (or when git is slow).
 */
export function gitMainCheckout(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        if (error !== null || stdout.trim() === '') resolve(null);
        else resolve(path.dirname(path.resolve(cwd, stdout.trim())));
      }
    );
  });
}

/**
 * Resolves folders to main checkouts, remembering the most recent answers
 * (the least recently used is forgotten first), and asking git once for a
 * folder asked about twice at once.
 */
export class CheckoutResolver {
  private readonly cache = new Map<string, Promise<string | null>>();

  /**
   * @param resolve - The resolver (default: git, off the event loop).
   * @param max - How many answers to remember.
   */
  constructor(
    private readonly resolve: (cwd: string) => Promise<string | null> = gitMainCheckout,
    private readonly max: number = RESOLVER_CACHE_SIZE
  ) {}

  /**
   * The main checkout of `cwd`, or `null` outside git.
   *
   * @param cwd - Any folder.
   * @returns The main checkout, or `null`.
   */
  of(cwd: string): Promise<string | null> {
    let answer = this.cache.get(cwd);
    if (answer === undefined) {
      answer = this.resolve(cwd).catch(() => null);
    } else {
      this.cache.delete(cwd);
    }
    this.cache.set(cwd, answer);
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return answer;
  }

  /** How many answers it remembers now. */
  get size(): number {
    return this.cache.size;
  }
}

/** The sub-folders of `dir`, sorted, or none when it cannot be read. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Main checkouts flow can find by itself: the projects behind the worktrees in
 * `<dorkHome>/workspaces/<repo>/` (where `flow drain` puts its worktrees, one
 * resolved per repo folder), and the projects of `cwds` (the folders of the
 * chats the Flow tab was opened beside).
 *
 * @param dorkHome - The DorkOS home.
 * @param cwds - More folders to cover.
 * @param resolver - Folder to main checkout.
 * @returns The main checkouts, each once, sorted.
 */
export async function discoverCheckouts(
  dorkHome: string,
  cwds: Iterable<string>,
  resolver: CheckoutResolver
): Promise<string[]> {
  const found = new Set<string>();
  for (const repoDir of subdirs(path.join(dorkHome, 'workspaces'))) {
    for (const worktree of subdirs(repoDir)) {
      if (!existsSync(path.join(worktree, '.git'))) continue;
      const main = await resolver.of(worktree);
      if (main !== null) {
        found.add(main);
        break;
      }
    }
  }
  for (const cwd of cwds) {
    const main = await resolver.of(cwd);
    if (main !== null) found.add(main);
  }
  return [...found].sort();
}

/**
 * Whether a run's worker is gone, by `flow fleet`'s own rule for a run with no
 * live session row (`sessionState`'s run-only branch): a run waiting for review
 * is parked, never stale; otherwise it is stale when it names a worker pid that
 * no longer exists. A DorkOS-hosted run records `workerPid: -1`, which that
 * check (`process.kill(-1, 0)`) never reads as gone, exactly as in `flow fleet`.
 *
 * @param run - The run as stored.
 * @param pidAlive - Whether a pid exists.
 * @returns True when the run should be neither shown nor counted.
 */
export function isStaleRun(
  run: Record<string, unknown>,
  pidAlive: (pid: number) => boolean
): boolean {
  return (
    sessionState({
      runOnly: {
        status: typeof run.status === 'string' ? run.status : '',
        workerPid: typeof run.workerPid === 'number' ? run.workerPid : null,
      },
      accountLimited: false,
      pidAlive,
    }) === 'stale'
  );
}

/**
 * The account a run bills, `<runtime>:<id>`, named the way `flow fleet` names
 * it (its `canonicalId`): a run with no account bills its runtime's `default`,
 * and `default` resolves through flow's registry to the registered account it
 * points at, when it points at one.
 *
 * @param registry - flow's accounts (`loadAccounts`).
 * @param runtime - The run's runtime, absent for `claude-code`.
 * @param account - The run's account, or `null`.
 * @returns The key.
 */
export function runAccountKey(
  registry: readonly RuntimeAccount[],
  runtime: string | undefined,
  account: string | null
): string {
  const slug = runtime ?? 'claude-code';
  const id = account ?? IMPLICIT_ACCOUNT_ID;
  if (id === IMPLICIT_ACCOUNT_ID && isRuntimeSlug(slug)) {
    const target = resolveAccountRef(registry, slug, id);
    if (target !== null) return liveKey(slug, target.id);
  }
  return liveKey(slug, id);
}

/** What to call an account and its dot's color, by key. */
export type AccountLook = ReadonlyMap<string, { label: string; color: string }>;

/** The color of a run's dot when its account is unknown to DorkOS. */
const UNKNOWN_ACCOUNT_COLOR = '#a1a1aa';

/** A string field, or `null` when missing or blank. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The runs of one project to show: active ones that are not stale, then those
 * completed in the last day, in the store's order within each.
 *
 * @param input - The project, its raw run store, the account names, flow's
 *   registry, the pid check and the clock.
 * @returns The rows.
 */
export function projectRuns(input: {
  root: string;
  store: Record<string, unknown>;
  accounts: AccountLook;
  registry: readonly RuntimeAccount[];
  pidAlive: (pid: number) => boolean;
  now: Date;
}): FlowRunRow[] {
  const active: FlowRunRow[] = [];
  const done: FlowRunRow[] = [];
  for (const run of Object.values(input.store)) {
    if (!isObject(run) || typeof run.identifier !== 'string' || typeof run.status !== 'string') {
      continue;
    }
    let into: FlowRunRow[];
    if (ACTIVE_RUN_STATUSES.has(run.status)) {
      if (isStaleRun(run, input.pidAlive)) continue;
      into = active;
    } else if (run.status === 'complete') {
      const at = Date.parse(text(run.completedAt) ?? lastUpdateOf(run) ?? '');
      if (!Number.isFinite(at) || input.now.getTime() - at > DONE_SHOWN_MS) continue;
      into = done;
    } else {
      continue;
    }
    const runtime = text(run.runtime) ?? undefined;
    const key = runAccountKey(input.registry, runtime, text(run.account));
    const look = input.accounts.get(key);
    into.push({
      identifier: run.identifier,
      title: text(run.title),
      url: text(run.url),
      sessionId: text(run.sessionId),
      dispatchedBy: text(run.dispatchedBy),
      cwd: text(run.worktreePath) ?? input.root,
      account: {
        key,
        label: look?.label ?? key.slice(key.indexOf(':') + 1),
        color: look?.color ?? UNKNOWN_ACCOUNT_COLOR,
      },
      state: runState(run),
      updatedAt: lastUpdateOf(run),
    });
  }
  return [...active, ...done];
}

/** How long a tracker that does not answer stays quiet before the lens says so, in ms (§7.1). */
export const UNREACHABLE_SHOWN_AFTER_MS = 15 * 60_000;

/**
 * A project's conditions (§7.1) from its pause and its last tracker read. None
 * is escalated: flow shows them where you look and never asks about them yet.
 *
 * @param pause - The project's pause, or `null`.
 * @param read - Its last tracker read, or `null`.
 * @param now - The clock.
 * @returns The conditions.
 */
export function conditionsOf(
  pause: FlowProject['pause'],
  read: TrackerRead | null,
  now: Date
): FlowCondition[] {
  const conditions: FlowCondition[] = [];
  if (pause !== null) {
    conditions.push({
      kind: 'paused',
      since: pause.since ?? now.toISOString(),
      escalated: false,
      detail: {},
    });
  }
  if (read?.failure !== undefined && read.failure !== null) {
    const { kind, since } = read.failure;
    const age = now.getTime() - Date.parse(since);
    if (kind === 'auth') {
      conditions.push({ kind: 'sign-in', since, escalated: false, detail: {} });
    } else if (kind === 'settings') {
      conditions.push({ kind: 'settings-problem', since, escalated: false, detail: {} });
    } else if (age >= UNREACHABLE_SHOWN_AFTER_MS) {
      conditions.push({ kind: 'tracker-unreachable', since, escalated: false, detail: {} });
    }
  }
  return conditions;
}

/**
 * Whether flow reads a project's "Up next" on its own (see {@link FlowProject.upNext}).
 *
 * @param entry - The project.
 * @returns How "Up next" is reached.
 */
export function upNextOf(entry: FlowProjectEntry): FlowProject['upNext'] {
  if (entry.tracker === null) return 'read';
  if (entry.tracker.transport === 'mcp') return 'agent-only';
  return entry.tracker.adapter === 'shipped' ? 'read' : 'own-code';
}

/**
 * Build one project of the model.
 *
 * @param input - The project, its tracker read, the account names, flow's
 *   registry, the pid check, the clock and the schedules to restore.
 * @returns The project.
 */
export function buildProject(input: {
  entry: FlowProjectEntry;
  read: TrackerRead | null;
  accounts: AccountLook;
  registry: readonly RuntimeAccount[];
  pidAlive?: (pid: number) => boolean;
  now: Date;
  restoreSchedules?: readonly string[];
}): FlowProject {
  const { entry, read, now } = input;
  const pidAlive = input.pidAlive ?? pidExists;
  const store = readRunStore(entry.root) ?? {};
  const runs = projectRuns({
    root: entry.root,
    store,
    accounts: input.accounts,
    registry: input.registry,
    pidAlive,
    now,
  });
  let busy = 0;
  for (const run of Object.values(store)) {
    if (
      isObject(run) &&
      typeof run.status === 'string' &&
      ACTIVE_RUN_STATUSES.has(run.status) &&
      !isStaleRun(run, pidAlive) &&
      isLiveDrainRun(run)
    ) {
      busy += 1;
    }
  }
  const flag = readPauseFlag(pauseFlagPath(entry.root), now);
  const pause = flag?.pauses ? { since: flag.since, until: flag.until } : null;
  return {
    name: entry.name,
    root: entry.root,
    setup: entry.setup,
    tracker:
      entry.tracker === null
        ? null
        : { label: entry.tracker.label, team: entry.tracker.team, url: read?.teamUrl ?? null },
    pause,
    runs,
    queue: read?.queue ?? null,
    upNext: upNextOf(entry),
    capacity: { busy, slots: slotsOf(readDrainSettings(entry.root).parallel) },
    conditions: conditionsOf(pause, read, now),
    version: entry.version,
    restoreSchedules: [...(input.restoreSchedules ?? [])],
  };
}

/** What `config-files.ts pause` or `resume` prints. */
export interface PauseOutput {
  /** The DorkOS schedules the pause had switched off (resume). */
  hostSchedules?: unknown;
}

/**
 * Run flow's `config-files.ts pause` or `resume` for one project, with `node`
 * from `PATH` (flow's scripts need Node 22.6 or newer). A pause with an end
 * passes `--host-restores`: DorkOS switches back on any schedules an earlier
 * pause switched off when this one ends (§5.2).
 *
 * @param opts - How to run it, flow's folder, the command, the project and the end.
 * @returns The printed result.
 * @throws {RouteError} 502 naming the project when flow could not do it.
 */
export function runPauseCommand(opts: {
  execFile: ExecFileLike;
  flowRoot: string;
  command: 'pause' | 'resume';
  mainCheckout: string;
  until?: string | null;
  name?: string;
}): Promise<PauseOutput> {
  const script = path.join(opts.flowRoot, 'scripts', 'config-files.ts');
  const args = ['--experimental-strip-types', script, opts.command, '--project', opts.mainCheckout];
  if (opts.command === 'pause' && typeof opts.until === 'string') {
    args.push('--until', opts.until, '--host-restores');
  }
  const name = opts.name ?? path.basename(opts.mainCheckout);
  return new Promise((resolve, reject) => {
    opts.execFile(
      'node',
      args,
      { timeout: 15_000, shell: false, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(
            new RouteError(
              502,
              `Flow couldn't ${opts.command === 'pause' ? 'pause' : 'resume'} ${name}. Try again.`
            )
          );
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '');
          resolve(isObject(parsed) ? parsed : {});
        } catch {
          resolve({});
        }
      }
    );
  });
}

/**
 * The DorkOS schedules a resume reported the pause had switched off.
 *
 * @param output - What `config-files.ts resume` printed.
 * @returns Their ids.
 */
export function schedulesOf(output: PauseOutput): string[] {
  return Array.isArray(output.hostSchedules)
    ? output.hostSchedules.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
}
