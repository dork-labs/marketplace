/**
 * The Flow tab's server side (spec `flow-multiproject` §2, §5.2, §7, §9):
 * builds the model over every flow project, pauses and resumes one project or
 * all of them with an end time, lifts a timed pause when its end passes (the
 * expiry sweep), keeps each project's tracker read on its timer, keeps the
 * engine's copy of each project's dial, raises and settles flow's asks in
 * DorkOS's inbox, starts the morning's sorting, and pushes a new model as the
 * `model` event, at most once a second, when it changed.
 *
 * @module @dorkos/flow/extension/model-service
 */

import os from 'node:os';
import path from 'node:path';
import {
  AUTONOMY_KINDS,
  type AutonomyKind,
  type AutonomyStop,
} from '../../../../scripts/autonomy.ts';
import { readJsonFile } from '../../../../scripts/atomic-json.ts';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';
import { loadAccounts } from '../../../../scripts/fleet/accounts.ts';
import { readRunStore } from '../../../../scripts/fleet/sessions.ts';
import { AdapterTrust } from './adapter-trust.ts';
import type { ExecFileLike } from './advisor.ts';
import { sortRecord, type AskProject } from './asks.ts';
import { AutonomyStore } from './autonomy-store.ts';
import { IdleClock, ideasAskDue, ideasWaiting } from './conditions.ts';
import { DailySort } from './daily-sort.ts';
import { DecisionCoordinator, type PlanProject } from './decisions.ts';
import { RouteError, buildFleetView } from './fleet.ts';
import type {
  AccountsApi,
  DecisionActionEvent,
  InboxApi,
  ProjectSettingsReader,
  ProjectsApi,
  SessionsApi,
} from './host-types.ts';
import {
  CheckoutResolver,
  buildProject,
  discoverCheckouts,
  pauseFlagPath,
  readPauseFlag,
  runPauseCommand,
  schedulesOf,
  type AccountLook,
  type FlowCondition,
  type FlowModel,
  type FlowProject,
  type ProjectExtras,
} from './model.ts';
import { ProjectDirectory, type FlowProjectEntry } from './projects.ts';
import type { SharedStorage } from './shared-storage.ts';
import {
  parseSettingsPatch,
  pauseDefaults,
  readProjectSettings,
  writeProjectSettings,
  type ProjectSettingsView,
} from './settings.ts';
import { TrackerReader, projectIdOf } from './tracker-reads.ts';

/** The shortest gap between two `model` events, in ms. */
export const EMIT_INTERVAL_MS = 1_000;

/** The furthest a pause may be set to end, in ms (§5.2). */
export const LONGEST_PAUSE_MS = 30 * 24 * 60 * 60_000;

/** The refusal for an end time out of range. */
export const PAUSE_RANGE_MESSAGE = 'Pick a time in the next 30 days.';

/** The storage key of the DorkOS schedules each project needs switched back on. */
export const RESTORE_KEY = 'restoreSchedules';

/** The most chat folders remembered as places to look for projects. */
const REMEMBERED_CWDS = 50;

/** What the model service needs from its host and machine. */
export interface ModelServiceDeps {
  /** The DorkOS home. */
  dorkHome: string;
  /** flow's plugin folder. */
  flowRoot: string;
  /** DorkOS's accounts API. */
  accounts: Pick<AccountsApi, 'list'>;
  /** Core's project registry, when the host has one. */
  projects?: ProjectsApi;
  /** The extension's storage. */
  storage: SharedStorage;
  /** Sends the `model` event (`ctx.emit`). */
  emit: (event: string, data: unknown) => void;
  /** Runs a command with no shell. */
  execFile: ExecFileLike;
  /** The clock. */
  now: () => Date;
  /** Whether pausing and resuming routes exist on this host. */
  canChange: boolean;
  /** Folder to main checkout (default: git, off the event loop, remembering recent answers). */
  resolver?: CheckoutResolver;
  /** Whether a pid exists (default: `process.kill(pid, 0)`, as `flow fleet`). */
  pidAlive?: (pid: number) => boolean;
  /** The OS home flow resolves each runtime's `default` account from (default: this user's). */
  osHome?: string;
  /** Where to log. */
  log: (message: string) => void;
  /** Core's inbox, when the host has one. */
  inbox?: InboxApi;
  /** Core's read-only per-project settings, when the host has them. */
  settings?: ProjectSettingsReader;
  /** Starting work in a new chat, when the host has it. */
  sessions?: SessionsApi;
  /** How long an answer waits before "Sending…" (tests). */
  answerWaitMs?: number;
}

/**
 * Whether a reviewer agent checks a project's work (`review.adversarial`, its
 * own machine's file over the committed one; on when neither says).
 *
 * @param root - The project's main checkout.
 * @returns True unless turned off.
 */
export function reviewerAgentOf(root: string): boolean {
  let on = true;
  for (const file of [CONFIG_FILE, LOCAL_CONFIG_FILE]) {
    const { value } = readJsonFile(path.join(root, PROJECT_CONFIG_DIR, file));
    const review =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).review
        : undefined;
    const adversarial =
      typeof review === 'object' && review !== null
        ? (review as Record<string, unknown>).adversarial
        : undefined;
    if (typeof adversarial === 'boolean') on = adversarial;
  }
  return on;
}

/** The body of the no-inbox answer route (§7.6). */
export interface LocalAnswer {
  /** `approve`, `reject`, `word` or `choice`. */
  action: DecisionActionEvent['action'];
  /** The "Send it back" note. */
  note?: string;
  /** A typed answer. */
  text?: string;
  /** A chosen chip. */
  choiceId?: string;
}

/** What `POST /pause` and `POST /resume` act on. */
export interface PauseTarget {
  /** One project, by name. */
  project?: string;
  /** Every set-up project. */
  all?: true;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a pause or resume body: exactly one of `project` and `all`. A body with
 * neither, as the Flow panel from before sent, means every project.
 *
 * @param body - The request body.
 * @returns The target.
 * @throws {RouteError} 400 when it names both, or a project that is not a string.
 */
export function parseTarget(body: unknown): PauseTarget {
  const value = isObject(body) ? body : {};
  const hasProject = value.project !== undefined;
  const hasAll = value.all !== undefined;
  if (hasProject && hasAll) throw new RouteError(400, 'Choose one project, or all of them.');
  if (hasProject) {
    if (typeof value.project !== 'string' || value.project === '') {
      throw new RouteError(400, 'Choose one project, or all of them.');
    }
    return { project: value.project };
  }
  return { all: true };
}

/**
 * Read a pause's end: `null` (until someone resumes), or a time in the next 30
 * days. A body with no `until`, as the Flow panel from before sent, has no end.
 *
 * @param body - The request body.
 * @param now - The clock.
 * @returns The end, as sent.
 * @throws {RouteError} 400 with {@link PAUSE_RANGE_MESSAGE} for any other value.
 */
export function parseUntil(body: unknown, now: Date): string | null {
  const until = isObject(body) ? body.until : undefined;
  if (until === undefined || until === null) return null;
  const at = typeof until === 'string' ? Date.parse(until) : Number.NaN;
  // flow's engine needs the zone written out, so a bare local time is refused too.
  const zoned = typeof until === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(until);
  if (!zoned || !Number.isFinite(at) || at <= now.getTime()) {
    throw new RouteError(400, PAUSE_RANGE_MESSAGE);
  }
  if (at - now.getTime() > LONGEST_PAUSE_MS) throw new RouteError(400, PAUSE_RANGE_MESSAGE);
  return until as string;
}

/**
 * Read the stored restore list leniently: root to schedule ids, empty lists dropped.
 *
 * @param stored - The stored value.
 * @returns The list.
 */
export function parseRestoreList(stored: unknown): Record<string, string[]> {
  const list: Record<string, string[]> = {};
  if (!isObject(stored)) return list;
  for (const [root, ids] of Object.entries(stored)) {
    if (Array.isArray(ids)) {
      const kept = ids.filter((id): id is string => typeof id === 'string' && id !== '');
      if (kept.length > 0) list[root] = kept;
    }
  }
  return list;
}

/** The waits after each failed attempt to end a pause on time, in ms; the last repeats. */
export const SWEEP_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** The Flow tab's model, its writes, the expiry sweep and its live event. */
export class ModelService {
  private readonly resolver: CheckoutResolver;
  private readonly directory: ProjectDirectory;
  private readonly reader: TrackerReader;
  private readonly cwds: string[] = [];
  private lastSent: string | null = null;
  private lastEmitAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private sweeping: Promise<void> | null = null;
  /** Pause and resume commands run one at a time, so the sweep never undoes a fresh pause. */
  private commands: Promise<unknown> = Promise.resolve();
  /** Failed attempts to end a pause on time, by root. */
  private readonly sweepFailures = new Map<string, { count: number; retryAt: number }>();
  /** Each project's dial. */
  readonly autonomy: AutonomyStore;
  /** Which projects' own adapters a person allowed. */
  readonly trust: AdapterTrust;
  /** flow's asks. */
  readonly decisions: DecisionCoordinator;
  private readonly idleClock: IdleClock;
  private readonly dailySort: DailySort;
  /** Since when each project has run nothing, from the last poll. */
  private idle = new Map<string, string | null>();
  /** Projects whose morning sorting waits until tomorrow. */
  private sortWaits = new Set<string>();
  /** Roots whose own adapter a person allowed, from the last poll. */
  private allowed = new Set<string>();

  /**
   * @param deps - The host, machine and clock.
   */
  constructor(private readonly deps: ModelServiceDeps) {
    this.autonomy = new AutonomyStore({
      dorkHome: deps.dorkHome,
      settings: deps.settings,
      storage: deps.storage,
      log: deps.log,
      now: () => deps.now().getTime(),
    });
    this.trust = new AdapterTrust(deps.storage);
    this.idleClock = new IdleClock(deps.storage);
    this.dailySort = new DailySort({
      storage: deps.storage,
      sessions: deps.sessions,
      now: deps.now,
      log: deps.log,
      record: async (candidate) => {
        const plan = this.lastPlans.get(candidate.root);
        if (plan === undefined) return;
        await this.decisions.recordOnce(
          sortRecord(plan.ask, candidate.stop, candidate.waiting),
          `sort:${candidate.root}:${deps.now().toISOString().slice(0, 10)}`
        );
      },
    });
    this.decisions = new DecisionCoordinator({
      inbox: deps.inbox,
      sessions: deps.sessions,
      storage: deps.storage,
      flowRoot: deps.flowRoot,
      dorkHome: deps.dorkHome,
      execFile: deps.execFile,
      now: deps.now,
      log: deps.log,
      autonomy: this.autonomy,
      onChange: () => this.request(),
      onStarted: () => void this.dailySort.noteStart().catch(() => {}),
      answerWaitMs: deps.answerWaitMs,
    });
    this.resolver = deps.resolver ?? new CheckoutResolver();
    this.directory = new ProjectDirectory({
      flowRoot: deps.flowRoot,
      projects: deps.projects,
      storage: deps.storage,
      log: deps.log,
    });
    this.reader = new TrackerReader({
      dorkHome: deps.dorkHome,
      flowRoot: deps.flowRoot,
      execFile: deps.execFile,
      now: deps.now,
      log: deps.log,
      onChange: () => this.request(),
    });
  }

  /**
   * Look for projects in a chat's folder from now on.
   *
   * @param cwd - The folder the Flow tab was opened beside.
   */
  noteCwd(cwd: unknown): void {
    if (typeof cwd !== 'string' || cwd === '' || this.cwds.includes(cwd)) return;
    this.cwds.push(cwd);
    if (this.cwds.length > REMEMBERED_CWDS) this.cwds.shift();
    // "Set up flow here" starts work in this folder's project, which DorkOS
    // accepts only for a project flow reported (§7.9).
    void this.deps.projects?.report(cwd).catch(() => null);
  }

  /** Every flow project now. */
  async projects(): Promise<FlowProjectEntry[]> {
    return this.directory.list(
      await discoverCheckouts(this.deps.dorkHome, this.cwds, this.resolver)
    );
  }

  /** The project a folder belongs to: core's answer, else the main checkout of it. */
  private async rootOf(cwd: string): Promise<string | null> {
    if (this.deps.projects !== undefined) {
      try {
        const ref = await this.deps.projects.resolve(cwd);
        if (ref !== null) return ref.root;
      } catch {
        // Fall back to flow's own resolver below.
      }
    }
    return await this.resolver.of(cwd);
  }

  /** What to call each account a run may bill, and its dot's color. */
  private async accountLook(): Promise<AccountLook> {
    const view = buildFleetView(
      this.deps.dorkHome,
      await this.deps.accounts.list(),
      this.deps.now()
    );
    const look = new Map<string, { label: string; color: string }>();
    for (const group of view.groups) {
      for (const account of group.accounts) {
        look.set(account.key, { label: account.label, color: account.color });
      }
    }
    return look;
  }

  /** The schedules each project needs switched back on, by root. */
  private async restoreList(): Promise<Record<string, string[]>> {
    return parseRestoreList(await this.deps.storage.get(RESTORE_KEY));
  }

  /**
   * Add schedules for a project to switch back on. The list is changed inside
   * the storage's save queue, so a sweep and a Flow tab's report never lose
   * each other's change.
   */
  private async addRestore(root: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.deps.storage.update(RESTORE_KEY, (current) => {
      const list = parseRestoreList(current);
      list[root] = [...new Set([...(list[root] ?? []), ...ids])];
      return list;
    });
  }

  /**
   * Forget schedules the Flow tab switched back on (or found gone).
   *
   * @param projectName - The project, by name.
   * @param ids - The schedule ids.
   * @returns The new model.
   */
  async schedulesRestored(projectName: unknown, ids: unknown): Promise<FlowModel> {
    const entry = await this.named(projectName);
    const done = new Set(
      Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    );
    await this.deps.storage.update(RESTORE_KEY, (current) => {
      const list = parseRestoreList(current);
      const left = (list[entry.root] ?? []).filter((id) => !done.has(id));
      if (left.length > 0) list[entry.root] = left;
      else delete list[entry.root];
      return list;
    });
    return this.answer();
  }

  /**
   * Build the model.
   *
   * @param cwd - The folder of the chat asking, for `cwdProject` and to read
   *   that project's tracker soon.
   * @returns The `GET /model` body.
   */
  async model(cwd?: string): Promise<FlowModel> {
    const now = this.deps.now();
    const entries = await this.projects();
    // flow's registry names the account a run on `default` bills (`flow fleet`'s canonicalId).
    const registry = loadAccounts(this.deps.dorkHome, {
      home: this.deps.osHome ?? os.homedir(),
    }).accounts;
    const [accounts, restore, pauseDefaultOf] = await Promise.all([
      this.accountLook(),
      this.restoreList(),
      pauseDefaults(this.deps.storage),
    ]);
    let cwdProject: string | null = null;
    if (typeof cwd === 'string' && cwd !== '') {
      const root = await this.rootOf(cwd);
      const entry = entries.find((candidate) => candidate.root === root);
      if (entry !== undefined) {
        cwdProject = entry.name;
        this.reader.view(entry.root);
        this.reader.tick(entries);
      }
    }
    const projects = entries.map((entry) =>
      buildProject({
        entry,
        read: this.reader.latest(entry.root),
        accounts,
        registry,
        pidAlive: this.deps.pidAlive,
        now,
        restoreSchedules: restore[entry.root] ?? [],
        extras: { ...this.extrasOf(entry), pauseDefault: pauseDefaultOf(entry.root) },
      })
    );
    const names = new Set(projects.map((project) => project.name));
    return {
      behaviour: this.directory.behaviour,
      generatedAt: now.toISOString(),
      projects,
      decisions: this.decisions.decisions().filter((decision) => names.has(decision.project)),
      cwdProject,
      canChange: this.deps.canChange,
    };
  }

  /** What the model adds to a project from the dial, the asks and the adapter allows. */
  private extrasOf(entry: FlowProjectEntry): ProjectExtras {
    const id = projectIdOf(entry.root);
    const open = this.decisions.keys();
    const escalated = new Set<FlowCondition['kind']>();
    if (open.has(`tracker:${id}`)) escalated.add('sign-in');
    if (open.has(`idle:${id}`)) escalated.add('nothing-ready');
    const dial = this.autonomy.of(entry.root);
    const reviewer = reviewerAgentOf(entry.root);
    const stops = Object.fromEntries(
      AUTONOMY_KINDS.map((kind) => [kind, this.autonomy.stop(entry.root, kind, reviewer)])
    ) as Record<AutonomyKind, AutonomyStop>;
    return {
      ownAdapterAllowed: this.allowed.has(entry.root),
      autonomy:
        dial === null || !this.autonomy.available
          ? null
          : { chosen: dial.chosen, firstSeen: dial.firstSeen, stops },
      idleSince: this.idle.get(entry.root) ?? null,
      escalated,
      sortWaits: this.sortWaits.has(entry.root),
    };
  }

  /** The last pass's plans, by root. */
  private lastPlans = new Map<string, PlanProject>();

  /**
   * A project's settings, by who a change reaches (§8.3).
   *
   * @param name - The project, by name.
   * @returns The settings page's view.
   */
  async settings(name: unknown): Promise<ProjectSettingsView> {
    const entry = await this.named(name);
    const pauseDefaultOf = await pauseDefaults(this.deps.storage);
    return readProjectSettings(entry, {
      pauseDefault: pauseDefaultOf(entry.root),
      canChange: this.deps.canChange,
    });
  }

  /**
   * Change a project's settings. Called only from the person-only route.
   *
   * @param name - The project, by name.
   * @param body - `{ shared?, local?, pauseDefault? }`.
   * @returns The settings page's new view.
   */
  async saveSettings(name: unknown, body: unknown): Promise<ProjectSettingsView> {
    const entry = await this.named(name);
    const patch = parseSettingsPatch(body, entry.version.behaviour);
    await writeProjectSettings(
      { execFile: this.deps.execFile, flowRoot: this.deps.flowRoot, storage: this.deps.storage },
      entry,
      patch
    );
    this.request();
    return this.settings(name);
  }

  /**
   * Allow a project's own tracker adapter as it is now (§2.2). Called only
   * from the person-only route.
   *
   * @param name - The project, by name.
   * @returns The new model.
   */
  async allowAdapter(name: unknown): Promise<FlowModel> {
    const entry = await this.named(name);
    if (entry.tracker === null || entry.tracker.adapter !== 'project') {
      throw new RouteError(400, `${entry.name} doesn't use an adapter of its own.`);
    }
    if (!(await this.trust.allow(entry.root, entry.tracker.id))) {
      throw new RouteError(
        400,
        `Flow can't vouch for ${entry.name}'s own adapter: it couldn't read its folder, or the adapter loads code from outside it.`
      );
    }
    this.allowed.add(entry.root);
    this.reader.view(entry.root);
    this.reader.tick(await this.projects(), this.allowed);
    return this.answer();
  }

  /**
   * Answer an ask from flow's own pages on a DorkOS without the inbox (§7.6).
   *
   * @param key - The ask's key.
   * @param body - What was chosen.
   * @returns Whether it settled, what to tell the person, and a chat to watch.
   */
  async answerLocal(
    key: string,
    body: unknown
  ): Promise<{
    resolved: boolean;
    message: string | null;
    watch: { sessionId: string; label: string } | null;
    model: FlowModel;
  }> {
    const value =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const action = value.action;
    if (action !== 'approve' && action !== 'reject' && action !== 'word' && action !== 'choice') {
      throw new RouteError(400, 'Choose an answer.');
    }
    const str = (field: unknown) => (typeof field === 'string' ? field : null);
    const result = await this.decisions.handle(
      {
        key,
        action,
        choiceId: str(value.choiceId),
        decidedBy: 'person',
        offerId: null,
        pendingActionId: null,
        note: str(value.note),
        text: str(value.text),
        project: null,
      },
      'local',
      str(value.shown) ?? undefined
    );
    const model = await this.answer();
    if ('settled' in result) return { resolved: true, message: null, watch: null, model };
    return {
      resolved: 'resolve' in result,
      message: result.message ?? null,
      watch: result.watch ?? null,
      model,
    };
  }

  /** The project a request names. */
  private async named(name: unknown): Promise<FlowProjectEntry> {
    const entry = (await this.projects()).find((candidate) => candidate.name === name);
    if (entry === undefined) {
      throw new RouteError(
        404,
        `No flow project is called ${typeof name === 'string' ? name : 'that'} on this computer.`
      );
    }
    return entry;
  }

  /** The projects a pause or resume acts on. */
  private async targets(target: PauseTarget): Promise<FlowProjectEntry[]> {
    if (target.project !== undefined) return [await this.named(target.project)];
    return (await this.projects()).filter((entry) => entry.setup === 'ready');
  }

  /**
   * Pause flow in one project or every set-up one. Paused projects are paused
   * again, so a new end applies to all of them.
   *
   * @param body - `{ project?, all?, until }`.
   * @returns The new model.
   */
  async pause(body: unknown): Promise<FlowModel> {
    const target = parseTarget(body);
    const until = parseUntil(body, this.deps.now());
    const entries = await this.targets(target);
    await this.serial(async () => {
      for (const entry of entries) {
        await runPauseCommand({
          ...this.commandDeps(),
          command: 'pause',
          mainCheckout: entry.root,
          until,
          name: entry.name,
        });
      }
    });
    return this.answer();
  }

  /** Run pause and resume commands one at a time, in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commands.then(fn);
    this.commands = run.catch(() => {});
    return run;
  }

  /**
   * Resume flow in one project or every set-up one, where it is paused. The
   * schedules a pause switched off go on the list the Flow tab switches back on.
   *
   * @param body - `{ project?, all? }`.
   * @returns The new model.
   */
  async resume(body: unknown): Promise<FlowModel> {
    const target = parseTarget(body);
    const entries = await this.targets(target);
    await this.serial(async () => {
      for (const entry of entries) {
        if (readPauseFlag(pauseFlagPath(entry.root), this.deps.now()) === null) continue;
        const output = await runPauseCommand({
          ...this.commandDeps(),
          command: 'resume',
          mainCheckout: entry.root,
          name: entry.name,
        });
        await this.addRestore(entry.root, schedulesOf(output));
      }
    });
    return this.answer();
  }

  /**
   * The expiry sweep (§5.2): lift every pause whose end has passed, with
   * flow's own `resume`, which removes the stale flag for every reader and
   * hands back the schedules the pause recorded. It is what ends a pause in a
   * project whose older flow does not read the end itself.
   *
   * @param entries - Every flow project now.
   */
  private async sweep(entries: readonly FlowProjectEntry[]): Promise<void> {
    for (const entry of entries) {
      if (!this.ended(entry.root)) {
        this.sweepFailures.delete(entry.root);
        continue;
      }
      const failed = this.sweepFailures.get(entry.root);
      if (failed !== undefined && this.deps.now().getTime() < failed.retryAt) continue;
      await this.serial(async () => {
        // Read again in the queue: a person may have paused afresh since.
        if (!this.ended(entry.root)) return;
        try {
          const output = await runPauseCommand({
            ...this.commandDeps(),
            command: 'resume',
            mainCheckout: entry.root,
            name: entry.name,
          });
          this.sweepFailures.delete(entry.root);
          await this.addRestore(entry.root, schedulesOf(output));
        } catch (error) {
          const count = (failed?.count ?? 0) + 1;
          const wait = SWEEP_RETRY_MS[Math.min(count, SWEEP_RETRY_MS.length) - 1];
          this.sweepFailures.set(entry.root, {
            count,
            retryAt: this.deps.now().getTime() + wait,
          });
          // Said once; the retries that follow are quiet until one works.
          if (count === 1) {
            this.deps.log(
              `[flow] could not end the pause in ${entry.name} on time: ${String(error)}; trying again later`
            );
          }
        }
      });
    }
  }

  /** Whether a project's pause flag has an end that has passed. */
  private ended(root: string): boolean {
    const flag = readPauseFlag(pauseFlagPath(root), this.deps.now());
    return flag !== null && !flag.pauses && flag.until !== null;
  }

  /**
   * The 5-second poll: lift expired pauses, start the tracker reads that are
   * due, and send a model when it changed.
   */
  async poll(): Promise<void> {
    // One pass at a time: the 5-second timer and a settings change can both
    // ask for one, and two passes at once could start the same morning's
    // sorting twice or write a history row twice.
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
      this.decisions.ready();
    });
    await this.polling;
  }

  /** The pass in progress, if any. */
  private polling: Promise<void> | null = null;

  /** One poll pass. */
  private async pollOnce(): Promise<void> {
    if (this.disposed) return;
    let entries: FlowProjectEntry[];
    try {
      entries = await this.projects();
    } catch (error) {
      this.deps.log(`[flow] could not list flow projects: ${String(error)}`);
      return;
    }
    this.sweeping ??= this.sweep(entries).finally(() => {
      this.sweeping = null;
    });
    await this.sweeping;
    try {
      await this.autonomy.sync(entries.map((entry) => entry.root));
    } catch (error) {
      this.deps.log(`[flow] could not read the Flow settings: ${String(error)}`);
    }
    const allowed = new Set<string>();
    for (const entry of entries) {
      if (
        entry.tracker?.adapter === 'project' &&
        (await this.trust.isAllowed(entry.root, entry.tracker.id))
      ) {
        allowed.add(entry.root);
      }
    }
    this.allowed = allowed;
    this.reader.tick(entries, allowed);
    try {
      await this.askPass(entries);
    } catch (error) {
      this.deps.log(`[flow] could not update flow's asks: ${String(error)}`);
    }
    this.request();
  }

  /**
   * Plan each project's asks, raise and settle them, and start the morning's
   * sorting where it is due.
   */
  private async askPass(entries: readonly FlowProjectEntry[]): Promise<void> {
    const now = this.deps.now();
    const registry = loadAccounts(this.deps.dorkHome, {
      home: this.deps.osHome ?? os.homedir(),
    }).accounts;
    const accounts = await this.accountLook();
    const built: { entry: FlowProjectEntry; project: FlowProject }[] = entries.map((entry) => ({
      entry,
      project: buildProject({
        entry,
        read: this.reader.latest(entry.root),
        accounts,
        registry,
        pidAlive: this.deps.pidAlive,
        now,
        extras: this.extrasOf(entry),
      }),
    }));
    this.idle = await this.idleClock.note(
      new Map(
        built.map(({ project }) => [project.root, project.runs.some((run) => run.state !== 'done')])
      ),
      now
    );
    const plans: PlanProject[] = built.map(({ entry, project }) => {
      const read = this.reader.latest(entry.root);
      const reviewerAgent = reviewerAgentOf(entry.root);
      const waiting = ideasWaiting(read);
      const idleSince = this.idle.get(entry.root) ?? null;
      const trackerName = entry.tracker?.label ?? null;
      const team = entry.tracker?.team ?? null;
      const ask: AskProject = {
        name: project.name,
        root: project.root,
        id: projectIdOf(project.root),
        label: trackerName === null ? null : team === null ? trackerName : `${trackerName} ${team}`,
        tracker: trackerName,
        link: `/x/flow/p/${encodeURIComponent(project.name)}`,
      };
      return {
        project,
        store: readRunStore(entry.root) ?? {},
        read,
        reviewerAgent,
        actionable:
          entry.tracker !== null &&
          entry.tracker.transport === 'cli' &&
          (entry.tracker.adapter === 'shipped' || this.allowed.has(entry.root)),
        ideas: {
          waiting,
          idleSince,
          due: ideasAskDue({
            waiting,
            stop: this.autonomy.stop(entry.root, 'sort', reviewerAgent),
            idleSince,
            busy: project.capacity.busy,
            slots: project.capacity.slots,
            paused: project.pause !== null,
            now,
          }),
        },
        ask,
      };
    });
    this.lastPlans = new Map(plans.map((plan) => [plan.project.root, plan]));
    await this.decisions.sync(plans);
    this.sortWaits = await this.dailySort.tick(
      plans
        .filter((plan) => plan.project.setup === 'ready' && this.autonomy.available)
        .map((plan) => ({
          root: plan.project.root,
          name: plan.project.name,
          waiting: plan.read?.facts?.shapeableCount ?? 0,
          paused: plan.project.pause !== null,
          stop: this.autonomy.stop(plan.project.root, 'sort', plan.reviewerAgent),
        }))
    );
  }

  /** Core's project list changed: ask core for names again and send a new model. */
  projectsChanged(): void {
    this.directory.refresh();
    this.request();
  }

  /** The command runner and flow's folder. */
  private commandDeps() {
    return { execFile: this.deps.execFile, flowRoot: this.deps.flowRoot };
  }

  /** Build the model after a write, and tell every open Flow tab. */
  private async answer(): Promise<FlowModel> {
    const model = await this.model();
    this.request();
    return model;
  }

  /**
   * Ask for a `model` event: sent now, or when a second has passed since the
   * last one. Requests in between share one event. An event whose model is the
   * same as the last one sent (apart from when it was built) is not sent.
   */
  request(): void {
    if (this.disposed || this.timer !== null) return;
    const wait = this.lastEmitAt + EMIT_INTERVAL_MS - Date.now();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.send();
      },
      Math.max(0, wait)
    );
  }

  /** Build the model and send it when it changed. */
  private async send(): Promise<void> {
    if (this.disposed) return;
    let model: FlowModel;
    try {
      model = await this.model();
    } catch (error) {
      this.deps.log(`[flow] could not build the Flow tab's model: ${String(error)}`);
      return;
    }
    const text = JSON.stringify({ ...model, generatedAt: null });
    if (text === this.lastSent) return;
    this.lastSent = text;
    this.lastEmitAt = Date.now();
    this.deps.emit('model', model);
  }

  /** Stop sending events and starting reads. */
  dispose(): void {
    this.disposed = true;
    this.reader.dispose();
    this.autonomy.dispose();
    this.decisions.dispose();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
