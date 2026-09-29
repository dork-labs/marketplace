/**
 * Which projects on this computer run flow, what each is called, and whether
 * its flow is older than this extension's (spec `flow-multiproject` §9).
 *
 * One loaded Flow extension serves every project: DorkOS may load it once from
 * whichever project holds the newest copy, or once per project. So nothing
 * here assumes the extension lives inside the project it is looking at.
 *
 * - **Candidates:** the projects core lists for flow (`ctx.projects.list()`),
 *   the ones flow finds itself (`discoverCheckouts`: the drain's worktrees and
 *   the chats' folders), and every flow project seen before (kept in the
 *   extension's storage, so one not opened since a restart still shows).
 * - **A flow project** holds a copy of flow (`.dork/plugins/flow`), or flow's
 *   settings (`.agents/flow/config.json`), or runs in flow's run store.
 * - **Names** are core's, as given. Without `ctx.projects` the name is the
 *   folder's, with core's own rule for a clash (`dorkos~work`), so a later
 *   DorkOS with the registry keeps the same names.
 *
 * Everything is read leniently and without zod: DorkOS bundles this module.
 *
 * @module @dorkos/flow/extension/projects
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile } from '../../../../scripts/atomic-json.ts';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';
import { readRunStore } from '../../../../scripts/fleet/sessions.ts';
import type { ProjectsApi } from './host-types.ts';
import type { SharedStorage } from './shared-storage.ts';

/** How a project's tracker is reached, and which code reads it. */
export interface ProjectTracker {
  /** flow's tracker id, such as `linear`. */
  id: string;
  /** What to call it, such as "Linear". */
  label: string;
  /** The team key, such as `DOR`, or `null`. */
  team: string | null;
  /** `cli` can be read from here; `mcp` only inside an agent's session. */
  transport: 'cli' | 'mcp';
  /**
   * Which adapter code a read would run: the one flow ships, one committed in
   * the project (it runs only after a person allows it, spec §2.2), or none
   * flow can vouch for.
   */
  adapter: 'shipped' | 'project' | 'other';
}

/** One flow project, before its runs and tracker read are added. */
export interface FlowProjectEntry {
  /** Its main checkout. */
  root: string;
  /** Core's name for it, or the folder-name fallback. */
  name: string;
  /** `not-set-up`: flow is installed but has no `.agents/flow/config.json`. */
  setup: 'ready' | 'not-set-up';
  /** Its tracker, or `null` when not set up. */
  tracker: ProjectTracker | null;
  /** Its flow's version, behaviour level, and the first thing an older one lacks. */
  version: { flow: string | null; behaviour: number; olderBehaviour: string | null };
}

/** One behaviour level and what it changed (`behaviour.json`). */
export interface BehaviourLevel {
  /** The level. */
  level: number;
  /** What it made the engine do, in words ("timed pauses end on time"). */
  effect: string;
}

/** A flow's behaviour: its level and the changes that led to it. */
export interface Behaviour {
  /** The level; a missing file is 0. */
  behaviour: number;
  /** Every level's effect, oldest first. */
  changes: BehaviourLevel[];
}

/** Where a project holds its copy of flow. */
export const INSTALL_DIR = path.join('.dork', 'plugins', 'flow');

/** The storage key of every flow project seen before. */
export const SEEN_KEY = 'flowProjects';

/** The most project roots remembered. */
const REMEMBERED_ROOTS = 200;

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a flow's `behaviour.json` leniently: a missing or unreadable file is
 * behaviour 0 with no changes.
 *
 * @param file - The file.
 * @returns The behaviour.
 */
export function readBehaviour(file: string): Behaviour {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { behaviour: 0, changes: [] };
  }
  if (!isObject(value)) return { behaviour: 0, changes: [] };
  const behaviour =
    typeof value.behaviour === 'number' && Number.isInteger(value.behaviour) && value.behaviour >= 0
      ? value.behaviour
      : 0;
  const changes = Array.isArray(value.changes)
    ? value.changes.filter(
        (entry): entry is BehaviourLevel =>
          isObject(entry) && typeof entry.level === 'number' && typeof entry.effect === 'string'
      )
    : [];
  return { behaviour, changes: changes.sort((a, b) => a.level - b.level) };
}

/**
 * A project's flow version against this extension's (§9.3). A project with no
 * copy of flow of its own runs whatever flow drives it, which flow cannot see,
 * so nothing is said. A copy older in behaviour names the first thing it lacks.
 *
 * @param root - The project's main checkout.
 * @param own - This extension's behaviour.
 * @returns The version facts.
 */
export function versionOf(root: string, own: Behaviour): FlowProjectEntry['version'] {
  const install = path.join(root, INSTALL_DIR);
  const { value: manifest } = readJsonFile(path.join(install, '.claude-plugin', 'plugin.json'));
  if (!isObject(manifest)) return { flow: null, behaviour: own.behaviour, olderBehaviour: null };
  const flow = typeof manifest.version === 'string' ? manifest.version : null;
  const theirs = readBehaviour(path.join(install, 'behaviour.json')).behaviour;
  const lacking = own.changes.find((change) => change.level > theirs);
  return {
    flow,
    behaviour: theirs,
    olderBehaviour: theirs < own.behaviour ? (lacking?.effect ?? null) : null,
  };
}

/** The display name of a tracker flow knows. */
const TRACKER_LABELS: Readonly<Record<string, string>> = {
  linear: 'Linear',
  jira: 'Jira',
  github: 'GitHub',
  'github-issues': 'GitHub',
  gitlab: 'GitLab',
  fake: 'the test tracker',
};

/**
 * What to call a tracker.
 *
 * @param id - flow's tracker id.
 * @returns Its name.
 */
export function trackerLabel(id: string): string {
  return TRACKER_LABELS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
}

/** One config file's object, or `{}`. */
function configOf(file: string): Record<string, unknown> {
  const { value } = readJsonFile(file);
  return isObject(value) ? value : {};
}

/**
 * A project's tracker, from its two config files the way flow's loader merges
 * them (`config.local.json` over `config.json`), read leniently: `tracker`
 * defaults to `linear` and `connection.transport` to `cli`, as the schema does.
 *
 * @param root - The main checkout.
 * @param flowRoot - This extension's flow, whose shipped adapters it can vouch for.
 * @returns The tracker, or `null` without `config.json`.
 */
export function readTracker(root: string, flowRoot: string): ProjectTracker | null {
  const dir = path.join(root, PROJECT_CONFIG_DIR);
  if (!existsSync(path.join(dir, CONFIG_FILE))) return null;
  const shared = configOf(path.join(dir, CONFIG_FILE));
  const local = configOf(path.join(dir, LOCAL_CONFIG_FILE));
  const pick = (read: (config: Record<string, unknown>) => unknown) => {
    const mine = read(local);
    return mine !== undefined ? mine : read(shared);
  };
  const connection = (config: Record<string, unknown>) =>
    isObject(config.connection) ? config.connection : {};
  const trackerValue = pick((config) => config.tracker);
  const id = typeof trackerValue === 'string' && trackerValue !== '' ? trackerValue : 'linear';
  const team = pick((config) => {
    const value = connection(config).team;
    return isObject(value) ? value.key : undefined;
  });
  const transport = pick((config) => connection(config).transport);
  // flow reads an adapter from its SKILL.md folder and runs the adapter.ts
  // beside it (`resolveAdapter` in config-files.ts, `tracker/load.ts`).
  const own = path.join(dir, 'adapters', id, 'SKILL.md');
  const shipped = path.join(flowRoot, 'skills', `${id}-adapter`, 'adapter.ts');
  return {
    id,
    label: trackerLabel(id),
    team: typeof team === 'string' && team !== '' ? team : null,
    transport: transport === 'mcp' ? 'mcp' : 'cli',
    adapter: existsSync(own) ? 'project' : existsSync(shipped) ? 'shipped' : 'other',
  };
}

/**
 * Whether a main checkout is a flow project: it holds a copy of flow, or
 * flow's settings, or runs in flow's run store.
 *
 * @param root - The main checkout.
 * @returns The setup state, or `null` when it is not a flow project.
 */
export function flowSetupOf(root: string): FlowProjectEntry['setup'] | null {
  if (existsSync(path.join(root, PROJECT_CONFIG_DIR, CONFIG_FILE))) return 'ready';
  if (existsSync(path.join(root, INSTALL_DIR, '.claude-plugin', 'plugin.json'))) {
    return 'not-set-up';
  }
  const store = readRunStore(root) ?? {};
  return Object.values(store).some(isObject) ? 'not-set-up' : null;
}

/**
 * Core's project-name rule, for a host without the registry: the folder's
 * name with every character outside `[A-Za-z0-9._-]` as `-`; on a clash
 * `name~parent`, then `name~parent-2` and on. Roots are named in sorted
 * order, so the same set of projects always gets the same names.
 *
 * @param roots - The projects' main checkouts.
 * @returns Each root's name.
 */
export function fallbackNames(roots: readonly string[]): Map<string, string> {
  const sanitize = (segment: string) => segment.replace(/[^A-Za-z0-9._-]/g, '-');
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const root of [...new Set(roots)].sort()) {
    const base = sanitize(path.basename(root)) || 'project';
    let name = base;
    if (taken.has(name)) {
      const withParent = `${base}~${sanitize(path.basename(path.dirname(root))) || 'root'}`;
      name = withParent;
      for (let n = 2; taken.has(name); n++) name = `${withParent}-${n}`;
    }
    taken.add(name);
    names.set(root, name);
  }
  return names;
}

/** What the project directory needs. */
export interface ProjectDirectoryDeps {
  /** This extension's flow folder. */
  flowRoot: string;
  /** Core's project registry, when the host has one. */
  projects?: ProjectsApi;
  /** The extension's storage. */
  storage: SharedStorage;
  /** Where to log. */
  log: (message: string) => void;
}

/** Finds, names and remembers the flow projects on this computer. */
export class ProjectDirectory {
  private readonly own: Behaviour;
  private seen: Set<string> | null = null;
  /** Names core gave roots it did not list, from `report`. */
  private readonly reported = new Map<string, string | null>();

  /**
   * @param deps - flow's folder, core's registry, storage and a logger.
   */
  constructor(private readonly deps: ProjectDirectoryDeps) {
    this.own = readBehaviour(path.join(deps.flowRoot, 'behaviour.json'));
  }

  /** This extension's behaviour level. */
  get behaviour(): number {
    return this.own.behaviour;
  }

  /** Every flow project seen before, read once. */
  private async seenRoots(): Promise<Set<string>> {
    if (this.seen === null) {
      const stored = await this.deps.storage.get(SEEN_KEY);
      this.seen ??= new Set(
        Array.isArray(stored)
          ? stored.filter((root): root is string => typeof root === 'string')
          : []
      );
    }
    return this.seen;
  }

  /**
   * The flow projects on this computer, sorted by name.
   *
   * @param found - Main checkouts flow found itself (`discoverCheckouts`).
   * @returns The projects.
   */
  async list(found: readonly string[]): Promise<FlowProjectEntry[]> {
    const seen = await this.seenRoots();
    const core = await this.coreList();
    const candidates = new Set<string>([...core.keys(), ...found, ...seen]);
    const roots: { root: string; setup: FlowProjectEntry['setup'] }[] = [];
    for (const root of candidates) {
      if (!existsSync(root)) continue;
      const setup = flowSetupOf(root);
      if (setup !== null) roots.push({ root, setup });
    }
    await this.remember(roots.map((entry) => entry.root));
    const names = await this.namesFor(
      roots.map((entry) => entry.root),
      core
    );
    return roots
      .map(({ root, setup }) => ({
        root,
        name: names.get(root) ?? path.basename(root),
        setup,
        tracker: setup === 'ready' ? readTracker(root, this.deps.flowRoot) : null,
        version: versionOf(root, this.own),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  }

  /** Core's list for flow, by root; empty without the registry or when it fails. */
  private async coreList(): Promise<Map<string, string>> {
    const byRoot = new Map<string, string>();
    if (this.deps.projects === undefined) return byRoot;
    try {
      for (const project of await this.deps.projects.list()) byRoot.set(project.root, project.name);
    } catch (error) {
      this.deps.log(`[flow] could not list DorkOS's projects: ${String(error)}`);
    }
    return byRoot;
  }

  /**
   * Each root's name: core's where it lists the root, else core's answer to
   * reporting it (asked once per root), else the folder-name fallback.
   */
  private async namesFor(
    roots: readonly string[],
    core: ReadonlyMap<string, string>
  ): Promise<Map<string, string>> {
    const fallback = fallbackNames(roots);
    if (this.deps.projects === undefined) return fallback;
    const names = new Map<string, string>();
    for (const root of roots) {
      const listed = core.get(root);
      if (listed !== undefined) {
        names.set(root, listed);
        continue;
      }
      if (!this.reported.has(root)) {
        let ref: { name: string } | null = null;
        try {
          ref = await this.deps.projects.report(root);
        } catch (error) {
          this.deps.log(`[flow] could not tell DorkOS about ${root}: ${String(error)}`);
        }
        this.reported.set(root, ref?.name ?? null);
      }
      names.set(root, this.reported.get(root) ?? fallback.get(root) ?? path.basename(root));
    }
    return names;
  }

  /** Remember new flow projects; a failure is logged, never thrown. */
  private async remember(roots: readonly string[]): Promise<void> {
    const seen = await this.seenRoots();
    const fresh = roots.filter((root) => !seen.has(root));
    if (fresh.length === 0) return;
    for (const root of fresh) seen.add(root);
    const kept = [...seen].slice(-REMEMBERED_ROOTS);
    this.seen = new Set(kept);
    try {
      await this.deps.storage.set(SEEN_KEY, kept);
    } catch (error) {
      this.deps.log(`[flow] could not save the list of flow projects: ${String(error)}`);
    }
  }

  /** Forget the names core gave on report, so the next list asks again (core's list changed). */
  refresh(): void {
    this.reported.clear();
  }
}
