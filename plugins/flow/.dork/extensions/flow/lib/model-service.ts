/**
 * The Flow tab's server side (spec `flow-multiproject` §2, §5.2, §9): builds
 * the model over every flow project, pauses and resumes one project or all of
 * them with an end time, lifts a timed pause when its end passes (the expiry
 * sweep), keeps each project's tracker read on its timer, and pushes a new
 * model as the `model` event, at most once a second, when it changed.
 *
 * @module @dorkos/flow/extension/model-service
 */

import os from 'node:os';
import { loadAccounts } from '../../../../scripts/fleet/accounts.ts';
import type { ExecFileLike } from './advisor.ts';
import { RouteError, buildFleetView } from './fleet.ts';
import type { AccountsApi, ProjectsApi } from './host-types.ts';
import {
  CheckoutResolver,
  buildProject,
  discoverCheckouts,
  pauseFlagPath,
  readPauseFlag,
  runPauseCommand,
  schedulesOf,
  type AccountLook,
  type FlowModel,
} from './model.ts';
import { ProjectDirectory, type FlowProjectEntry } from './projects.ts';
import type { SharedStorage } from './shared-storage.ts';
import { TrackerReader } from './tracker-reads.ts';

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
  /** Folder to main checkout (default: flow's `resolveMainCheckout`). */
  resolver?: CheckoutResolver;
  /** Whether a pid exists (default: `process.kill(pid, 0)`, as `flow fleet`). */
  pidAlive?: (pid: number) => boolean;
  /** The OS home flow resolves each runtime's `default` account from (default: this user's). */
  osHome?: string;
  /** Where to log. */
  log: (message: string) => void;
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

  /**
   * @param deps - The host, machine and clock.
   */
  constructor(private readonly deps: ModelServiceDeps) {
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
  }

  /** Every flow project now. */
  async projects(): Promise<FlowProjectEntry[]> {
    return this.directory.list(discoverCheckouts(this.deps.dorkHome, this.cwds, this.resolver));
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
    return this.resolver.of(cwd);
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
    const stored = await this.deps.storage.get(RESTORE_KEY);
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

  /** Add schedules for a project to switch back on. */
  private async addRestore(root: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = await this.restoreList();
    list[root] = [...new Set([...(list[root] ?? []), ...ids])];
    await this.deps.storage.set(RESTORE_KEY, list);
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
    const list = await this.restoreList();
    const left = (list[entry.root] ?? []).filter((id) => !done.has(id));
    if (left.length > 0) list[entry.root] = left;
    else delete list[entry.root];
    await this.deps.storage.set(RESTORE_KEY, list);
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
    const [accounts, restore] = await Promise.all([this.accountLook(), this.restoreList()]);
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
    return {
      behaviour: this.directory.behaviour,
      generatedAt: now.toISOString(),
      projects: entries.map((entry) =>
        buildProject({
          entry,
          read: this.reader.latest(entry.root),
          accounts,
          registry,
          pidAlive: this.deps.pidAlive,
          now,
          restoreSchedules: restore[entry.root] ?? [],
        })
      ),
      decisions: [],
      cwdProject,
      canChange: this.deps.canChange,
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
    for (const entry of await this.targets(target)) {
      await runPauseCommand({
        ...this.commandDeps(),
        command: 'pause',
        mainCheckout: entry.root,
        until,
        name: entry.name,
      });
    }
    return this.answer();
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
    for (const entry of await this.targets(target)) {
      if (readPauseFlag(pauseFlagPath(entry.root), this.deps.now()) === null) continue;
      const output = await runPauseCommand({
        ...this.commandDeps(),
        command: 'resume',
        mainCheckout: entry.root,
        name: entry.name,
      });
      await this.addRestore(entry.root, schedulesOf(output));
    }
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
    const now = this.deps.now();
    for (const entry of entries) {
      const flag = readPauseFlag(pauseFlagPath(entry.root), now);
      if (flag === null || flag.pauses || flag.until === null) continue;
      try {
        const output = await runPauseCommand({
          ...this.commandDeps(),
          command: 'resume',
          mainCheckout: entry.root,
          name: entry.name,
        });
        await this.addRestore(entry.root, schedulesOf(output));
      } catch (error) {
        this.deps.log(
          `[flow] could not end the pause in ${entry.name} on time: ${String(error)}; trying again`
        );
      }
    }
  }

  /**
   * The 5-second poll: lift expired pauses, start the tracker reads that are
   * due, and send a model when it changed.
   */
  async poll(): Promise<void> {
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
    this.reader.tick(entries);
    this.request();
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
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
