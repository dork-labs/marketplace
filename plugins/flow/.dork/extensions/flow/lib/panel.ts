/**
 * The Flow panel's data (spec `claude-account-ui` §8.5): every account with its
 * usage, every flow run in the projects the panel covers, the drain's slots,
 * and whether flow is paused. `GET /api/ext/flow/panel` answers it and the
 * server re-emits it as the `panel` event when it changes.
 *
 * Everything is read from flow's own files, leniently and without zod (this
 * module is bundled by DorkOS): the fleet policy through {@link buildFleetView},
 * each project's run store through flow's `readRunStore`, its drain settings
 * through {@link readDrainSettings}, and its pause flag at flow's own path.
 * Pausing and resuming run flow's own `config-files.ts pause|resume`, which
 * cannot be bundled (it finds its folder from its module URL).
 *
 * @module @dorkos/flow/extension/panel
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PAUSE_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';
import { liveKey } from '../../../../scripts/drain/live-count.ts';
import { ACTIVE_RUN_STATUSES, readRunStore } from '../../../../scripts/fleet/sessions.ts';
import type { ExecFileLike } from './advisor.ts';
import { readDrainSettings } from './drain-settings.ts';
import { buildFleetView, RouteError } from './fleet.ts';
import type { AccountSummary, AccountUsage, AccountUsageWindow } from './host-types.ts';
import { mainCheckoutOf } from './run-store.ts';

/** A run's state pill. */
export type RunPill = 'building' | 'in-review' | 'waiting-on-you' | 'handing-off' | 'parked';

/** One usage window as the panel draws it. */
export interface PanelWindow {
  /** Share used, or `null` when unknown. */
  usedPct: number | null;
  /** When it resets, or `null`. */
  resetsAt: string | null;
  /** The reported status, or `null`. */
  status: AccountUsageWindow['status'];
}

/** One account row of the panel. */
export interface PanelAccount {
  /** flow's policy key, `<runtime>:<id>`. */
  key: string;
  /** The runtime. */
  runtime: string;
  /** The registry id, or `default`. */
  id: string;
  /** What to call it. */
  label: string;
  /** Its display color. */
  color: string;
  /** The 5-hour and weekly windows; `null` when the account has no reading for one. */
  windows: { five_hour: PanelWindow | null; seven_day: PanelWindow | null };
  /** Set when the account is out of usage: when it comes back, if known. */
  out: { resetsAt: string | null } | null;
  /** True when it is Main and flow is keeping its reserve (outside the spend-down window). */
  reserved: boolean;
  /** The plan's name as its source reports it (`max`), or `null`. */
  plan: string | null;
}

/** One run row of the panel. */
export interface PanelRun {
  /** The tracker item, such as `DOR-2387`. */
  identifier: string;
  /** The item's title, or `null` when the run record has none. */
  title: string | null;
  /** The run's session, or `null` while none has started. */
  sessionId: string | null;
  /** The folder its session runs in: the run's worktree, else the project's checkout. */
  cwd: string;
  /** The account it runs on, `<runtime>:<id>`. */
  accountKey: string;
  /** What it is doing. */
  state: RunPill;
}

/** The `GET /panel` body. */
export interface PanelModel {
  /** Every account DorkOS knows, in DorkOS's order. */
  accounts: PanelAccount[];
  /** Every active run in the projects the panel covers. */
  runs: PanelRun[];
  /** Live drain runs, and the drain's slots across those projects. */
  slots: { busy: number; total: number };
  /** Whether flow is paused in all, some or none of those projects. */
  paused: 'all' | 'some' | 'none';
  /** Whether there is any project to pause. */
  canPause: boolean;
  /** True after a resume found DorkOS schedules that `/flow:pause` had switched off. */
  schedulesOff: boolean;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drain phases a run is in review in. */
const REVIEW_PHASES = new Set(['reviewing', 'pr-ready', 'watching']);

/** Limit states in which the run waits without moving. */
const WAITING_LIMIT_STATES = new Set(['waiting-reset', 'awaiting-handoff']);

/**
 * A run's state pill, from its raw record. The first rule that matches wins:
 *
 * 1. **handing off**: `limit.state` is `handing-off` (a move is under way) or
 *    `winding-down` (the worker is finishing up before one).
 * 2. **waiting on you**: `limit.state` is `pending-approval` (ask mode wants the
 *    operator's move); or a person's hold (`limit.heldBy: 'person'`) that will
 *    not resume by itself (`resumeOnReset: false`); or the drain parked it for
 *    a person (`drain.phase: 'parked'`, `drain.parkedFor: 'person'`).
 * 3. **parked**: the drain parked it for any other reason; or `limit.state` is
 *    `waiting-reset` or `awaiting-handoff`; or any other `limit.heldBy` hold.
 * 4. **in review**: `drain.phase` is `reviewing`, `pr-ready` or `watching`.
 * 5. **building**: everything else: `working`, `fixing`, `fixing-ci` or
 *    `closing`, a `queued` run, and a run with no drain record.
 *
 * @param run - The run as stored (read leniently).
 * @returns The pill.
 */
export function runState(run: unknown): RunPill {
  const record = isObject(run) ? run : {};
  const limit = isObject(record.limit) ? record.limit : null;
  const drain = isObject(record.drain) ? record.drain : null;
  const parked = drain?.phase === 'parked';
  if (limit?.state === 'handing-off' || limit?.state === 'winding-down') return 'handing-off';
  if (limit?.state === 'pending-approval') return 'waiting-on-you';
  if (limit?.heldBy === 'person' && limit.resumeOnReset === false) return 'waiting-on-you';
  if (parked && drain.parkedFor === 'person') return 'waiting-on-you';
  if (parked) return 'parked';
  if (typeof limit?.state === 'string' && WAITING_LIMIT_STATES.has(limit.state)) return 'parked';
  if (limit !== null && limit.heldBy !== undefined && limit.heldBy !== null) return 'parked';
  if (typeof drain?.phase === 'string' && REVIEW_PHASES.has(drain.phase)) return 'in-review';
  return 'building';
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

/** A project the panel covers. */
export interface PanelProject {
  /** Its main checkout. */
  mainCheckout: string;
  /** Its raw run store (`{}` when there is none). */
  store: Record<string, unknown>;
  /** Whether flow is paused there. */
  paused: boolean;
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

/** Whether a project has flow settings of its own. */
function hasFlowSettings(mainCheckout: string): boolean {
  const dir = path.join(mainCheckout, PROJECT_CONFIG_DIR);
  return existsSync(path.join(dir, CONFIG_FILE)) || existsSync(path.join(dir, LOCAL_CONFIG_FILE));
}

/** Resolves folders to main checkouts, remembering each answer. */
export class CheckoutResolver {
  private readonly cache = new Map<string, string | null>();

  /**
   * @param resolve - The resolver (default: flow's `resolveMainCheckout`, through {@link mainCheckoutOf}).
   */
  constructor(private readonly resolve: (cwd: string) => string | null = mainCheckoutOf) {}

  /**
   * The main checkout of `cwd`, or `null` outside git.
   *
   * @param cwd - Any folder.
   * @returns The main checkout, or `null`.
   */
  of(cwd: string): string | null {
    if (!this.cache.has(cwd)) this.cache.set(cwd, this.resolve(cwd));
    return this.cache.get(cwd) ?? null;
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
 * The main checkouts the panel covers: the projects behind the worktrees in
 * `<dorkHome>/workspaces/<repo>/` (where `flow drain` puts its worktrees, one
 * resolved per repo folder), and the projects of `cwds` (the folders of the
 * chats the panel was opened beside).
 *
 * @param dorkHome - The DorkOS home.
 * @param cwds - More folders to cover.
 * @param resolver - Folder to main checkout.
 * @returns The main checkouts, each once, sorted.
 */
export function discoverCheckouts(
  dorkHome: string,
  cwds: Iterable<string>,
  resolver: CheckoutResolver
): string[] {
  const found = new Set<string>();
  for (const repoDir of subdirs(path.join(dorkHome, 'workspaces'))) {
    for (const worktree of subdirs(repoDir)) {
      if (!existsSync(path.join(worktree, '.git'))) continue;
      const main = resolver.of(worktree);
      if (main !== null) {
        found.add(main);
        break;
      }
    }
  }
  for (const cwd of cwds) {
    const main = resolver.of(cwd);
    if (main !== null) found.add(main);
  }
  return [...found].sort();
}

/**
 * The projects the panel shows: of `checkouts`, those with flow runs or flow
 * settings, with their run stores and pause flags.
 *
 * @param checkouts - Candidate main checkouts.
 * @returns The projects.
 */
export function readProjects(checkouts: readonly string[]): PanelProject[] {
  const projects: PanelProject[] = [];
  for (const mainCheckout of checkouts) {
    const store = readRunStore(mainCheckout) ?? {};
    const hasRuns = Object.values(store).some(isObject);
    if (!hasRuns && !hasFlowSettings(mainCheckout)) continue;
    projects.push({ mainCheckout, store, paused: existsSync(pauseFlagPath(mainCheckout)) });
  }
  return projects;
}

/** One window of DorkOS's usage as the panel draws it. */
function panelWindow(usage: AccountUsage | undefined, key: string): PanelWindow | null {
  const entry = usage?.windows.find((w) => w.key === key);
  if (entry === undefined) return null;
  return { usedPct: entry.usedPct, resetsAt: entry.resetsAt, status: entry.status };
}

/** The run rows of one project, in the store's order. */
function projectRuns(project: PanelProject): PanelRun[] {
  const rows: PanelRun[] = [];
  for (const run of Object.values(project.store)) {
    if (!isObject(run) || typeof run.identifier !== 'string') continue;
    if (typeof run.status !== 'string' || !ACTIVE_RUN_STATUSES.has(run.status)) continue;
    const runtime = typeof run.runtime === 'string' && run.runtime !== '' ? run.runtime : undefined;
    const account = typeof run.account === 'string' && run.account !== '' ? run.account : null;
    rows.push({
      identifier: run.identifier,
      title: typeof run.title === 'string' && run.title.trim() !== '' ? run.title : null,
      sessionId: typeof run.sessionId === 'string' && run.sessionId !== '' ? run.sessionId : null,
      cwd:
        typeof run.worktreePath === 'string' && run.worktreePath !== ''
          ? run.worktreePath
          : project.mainCheckout,
      accountKey: liveKey(runtime, account),
      state: runState(run),
    });
  }
  return rows;
}

/**
 * Build the panel's model.
 *
 * @param input - The DorkOS home, DorkOS's accounts and usage, the projects, the clock, and the resume note.
 * @returns The model.
 */
export function buildPanel(input: {
  dorkHome: string;
  summaries: readonly AccountSummary[];
  usage: readonly AccountUsage[];
  projects: readonly PanelProject[];
  now: Date;
  schedulesOff: boolean;
}): PanelModel {
  const view = buildFleetView(input.dorkHome, input.summaries, input.now);
  const accounts: PanelAccount[] = view.groups.flatMap((group) =>
    group.accounts.map((account) => {
      const usage = input.usage.find(
        (u) => u.runtime === group.runtime && (u.accountId ?? 'default') === account.id
      );
      return {
        key: account.key,
        runtime: group.runtime,
        id: account.id,
        label: account.label,
        color: account.color,
        windows: {
          five_hour: panelWindow(usage, 'five_hour'),
          seven_day: panelWindow(usage, 'seven_day'),
        },
        out: usage?.state === 'limited' ? { resetsAt: usage.limit?.resetsAt ?? null } : null,
        reserved: account.role === 'main' && account.effectiveReservePct > 0,
        plan: usage?.plan?.name ?? usage?.subscriptionType ?? null,
      };
    })
  );
  const runs = input.projects.flatMap(projectRuns);
  let busy = 0;
  let total = 0;
  for (const project of input.projects) {
    for (const run of Object.values(project.store)) {
      if (isObject(run) && isLiveDrainRun(run)) busy += 1;
    }
    total += slotsOf(readDrainSettings(project.mainCheckout).parallel);
  }
  const pausedCount = input.projects.filter((project) => project.paused).length;
  return {
    accounts,
    runs,
    slots: { busy, total },
    paused: pausedCount === 0 ? 'none' : pausedCount === input.projects.length ? 'all' : 'some',
    canPause: input.projects.length > 0,
    schedulesOff: input.schedulesOff,
  };
}

/** What `config-files.ts resume` prints. */
interface ResumeOutput {
  hostSchedules?: unknown;
}

/**
 * Run flow's `config-files.ts pause` or `resume` for one project, with `node`
 * from `PATH` (flow's scripts need Node 22.6 or newer).
 *
 * @param opts - How to run it, flow's folder, the command and the project.
 * @returns The printed result.
 * @throws {RouteError} 502 naming the project when flow could not do it.
 */
export function runPauseCommand(opts: {
  execFile: ExecFileLike;
  flowRoot: string;
  command: 'pause' | 'resume';
  mainCheckout: string;
}): Promise<ResumeOutput> {
  const script = path.join(opts.flowRoot, 'scripts', 'config-files.ts');
  const args = ['--experimental-strip-types', script, opts.command, '--project', opts.mainCheckout];
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
              `Flow couldn't ${opts.command} in ${path.basename(opts.mainCheckout)}. Try again.`
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
 * Whether a resume reported DorkOS schedules that `/flow:pause` switched off,
 * which only a person can switch back on.
 *
 * @param output - What `config-files.ts resume` printed.
 * @returns True when it named any.
 */
export function reportsSchedulesOff(output: ResumeOutput): boolean {
  return Array.isArray(output.hostSchedules) && output.hostSchedules.length > 0;
}
