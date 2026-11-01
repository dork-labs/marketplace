/**
 * Test fixtures for the Flow extension: a temp DorkOS home, a fake host
 * context, a way to call flow's routes as a person or an agent, a temp git
 * project with a linked worktree, and writers for flow's ledger, fleet and run
 * store files.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Hono } from 'hono';
import { vi } from 'vitest';
import type {
  AccountAdvisor,
  AccountSummary,
  AccountUsage,
  DataProviderContext,
  ExtensionCaller,
  PersonRefusal,
  ProjectInfo,
  ProjectsApi,
} from '../lib/host-types.ts';
import type { FlowEnv } from '../lib/person.ts';

/** The repo every fixture project's origin names. */
export const REPO = 'acme/app';

/** Run git quietly. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
}

/** A temp world: DorkOS home, a project's main checkout and one linked worktree. */
export interface World {
  root: string;
  dorkHome: string;
  main: string;
  worktree: string;
  cleanup(): void;
}

/** Make a temp world. */
export function makeWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'flow-ext-')));
  const dorkHome = path.join(root, 'dork');
  const main = path.join(root, 'main');
  const worktree = path.join(root, 'wt');
  mkdirSync(dorkHome);
  mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  git(main, 'worktree', 'add', '-q', '-b', 'dork/acme-1', worktree);
  return {
    root,
    dorkHome,
    main,
    worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Claude Code's two registered accounts and Codex's implicit default. */
export const SUMMARIES: AccountSummary[] = [
  { runtime: 'claude-code', id: 'work', label: 'Work', color: '#2563eb', implicit: false },
  { runtime: 'claude-code', id: 'personal', label: null, color: '#16a34a', implicit: false },
  { runtime: 'codex', id: 'default', label: null, color: '#a855f7', implicit: true },
];

/** Write `<dorkHome>/flow/fleet.json`. */
export function writeFleet(dorkHome: string, fleet: Record<string, unknown>): void {
  mkdirSync(path.join(dorkHome, 'flow'), { recursive: true });
  writeFileSync(path.join(dorkHome, 'flow', 'fleet.json'), JSON.stringify({ v: 1, ...fleet }));
}

/** Read `<dorkHome>/flow/fleet.json`. */
export function readFleet(dorkHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dorkHome, 'flow', 'fleet.json'), 'utf8'));
}

/** Write one account's usage ledger. */
export function writeLedger(
  dorkHome: string,
  runtime: string,
  id: string,
  windows: Record<string, { usedPct: number | null; resetsAt: string | null; status?: string }>,
  observedAt: string
): void {
  const dir = path.join(dorkHome, 'runtimes', runtime, 'usage');
  mkdirSync(dir, { recursive: true });
  const stored: Record<string, unknown> = {};
  for (const [key, w] of Object.entries(windows)) {
    stored[key] = { status: 'allowed', ...w, observedAt, source: 'statusline' };
  }
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ v: 1, runtime, accountId: id, updatedAt: observedAt, windows: stored })
  );
}

/** A drain run record in the fixture project. */
export function runRecord(world: World, overrides: Record<string, unknown> = {}) {
  return {
    issueId: 'i1',
    identifier: 'ACME-1',
    sessionId: 's-old',
    worktreePath: world.worktree,
    branch: 'dork/acme-1',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 0,
    startedAt: '2026-09-27T00:00:00.000Z',
    account: 'work',
    runtime: 'claude-code',
    drain: { v: 1, rev: 3, wakeAfter: null, keepMe: true },
    ...overrides,
  };
}

/** The fixture project's run store path. */
export function storePath(world: World): string {
  return path.join(world.main, '.dork', 'flow', 'flow-state.json');
}

/** Write the fixture project's run store. */
export function writeRuns(world: World, runs: Record<string, unknown>): void {
  mkdirSync(path.dirname(storePath(world)), { recursive: true });
  writeFileSync(storePath(world), JSON.stringify(runs, null, 2));
}

/** Read the fixture project's run store. */
export function readStore(world: World): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(storePath(world), 'utf8'));
}

/** What a route answered. */
export interface Sent {
  status: number;
  body: unknown;
}

/** The words DorkOS's person bar refuses an agent with, for an extension named Flow. */
export const NOT_A_PERSON = "Only a person can change Flow's settings.";

/** A caller DorkOS found to be a person. */
export const PERSON: ExtensionCaller = { person: { ok: true } };

/** DorkOS's verdict on an agent, worded for an extension named Flow. */
export const AGENT_REFUSAL: PersonRefusal = {
  ok: false,
  status: 403,
  body: {
    error: NOT_A_PERSON,
    code: 'extension_person_required',
    message: `DorkOS changed nothing. ${NOT_A_PERSON} Ask them to do it in DorkOS.`,
  },
};

/** A caller DorkOS refused: an agent. */
export const AGENT: ExtensionCaller = { person: AGENT_REFUSAL };

/** What a route answers an agent with: the verdict's status and body. */
export const REFUSED_AGENT: Sent = { status: AGENT_REFUSAL.status, body: AGENT_REFUSAL.body };

/**
 * Call one of flow's routes the way DorkOS's fetch handler does: the path
 * below the mount, a JSON body when one is given, and the caller as `c.env`.
 *
 * @param app - flow's routes.
 * @param method - The HTTP method.
 * @param route - The path below `/api/ext/flow`, with its query.
 * @param opts - The body, and who is asking (a person unless `agent`).
 * @returns The status and the parsed JSON body (`undefined` when empty).
 */
export async function send(
  app: Hono<FlowEnv>,
  method: 'GET' | 'PUT' | 'POST',
  route: string,
  opts: { body?: unknown; agent?: boolean } = {}
): Promise<Sent> {
  const res = await app.request(
    route,
    {
      method,
      headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    opts.agent === true ? AGENT : PERSON
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** A fake `ctx.projects` over a list the test can change. */
export function fakeProjects(initial: ProjectInfo[] = []) {
  const list = [...initial];
  const listeners: (() => void)[] = [];
  const api = {
    resolve: vi.fn(async (cwd: string) => {
      const found = list
        .filter((p) => cwd === p.root || cwd.startsWith(`${p.root}/`))
        .sort((a, b) => b.root.length - a.root.length)[0];
      return found === undefined ? null : { root: found.root, name: found.name };
    }),
    list: vi.fn(async () => [...list]),
    report: vi.fn(async (dir: string) => ({ root: dir, name: `${path.basename(dir)}~reported` })),
    onChange: vi.fn((listener: () => void) => {
      listeners.push(listener);
      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    }),
  } satisfies ProjectsApi;
  return {
    api,
    list,
    listeners,
    /** Tell every listener the list changed. */
    changed: () => {
      for (const listener of listeners) listener();
    },
  };
}

/** A fake host context over `world`, with an in-memory storage that can be shared. */
export function fakeCtx(
  world: World,
  opts: {
    summaries?: AccountSummary[];
    storage?: { data: unknown };
    usage?: AccountUsage[];
    extensionDir?: string;
    /** Core's project registry (default: none, as on a DorkOS from before it). */
    projects?: ProjectsApi;
    /** More seams: the inbox, per-project settings, starting work. */
    extra?: Pick<DataProviderContext, 'inbox' | 'projectSettings' | 'sessions'>;
  } = {}
) {
  const store = opts.storage ?? { data: null };
  const registered: AccountAdvisor[] = [];
  const unregister = vi.fn();
  const cancelSchedule = vi.fn();
  const scheduled: (() => Promise<void>)[] = [];
  const emit = vi.fn((_event: string, _data: unknown) => {});
  const usageListeners: ((usage: AccountUsage) => void)[] = [];
  const accounts = {
    list: vi.fn(async () => opts.summaries ?? SUMMARIES),
    usage: vi.fn(async (): Promise<AccountUsage[]> => opts.usage ?? []),
    onUsage: vi.fn((listener: (usage: AccountUsage) => void) => {
      usageListeners.push(listener);
      return () => {
        usageListeners.splice(usageListeners.indexOf(listener), 1);
      };
    }),
    markContinued: vi.fn(async () => {}),
    registerAdvisor: vi.fn((advisor: AccountAdvisor) => {
      registered.push(advisor);
      return unregister;
    }),
  };
  const ctx: DataProviderContext = {
    storage: {
      loadData: async <T>() => store.data as T | null,
      saveData: async <T>(data: T) => {
        store.data = JSON.parse(JSON.stringify(data));
      },
    },
    schedule: (_seconds, fn) => {
      scheduled.push(fn);
      return cancelSchedule;
    },
    emit,
    extensionId: 'flow',
    extensionDir:
      opts.extensionDir ?? path.join(world.root, 'plugins', 'flow', '.dork', 'extensions', 'flow'),
    dorkHome: world.dorkHome,
    accounts,
    ...(opts.projects === undefined ? {} : { projects: opts.projects }),
    ...opts.extra,
  };
  return {
    ctx,
    accounts,
    registered,
    unregister,
    cancelSchedule,
    scheduled,
    store,
    emit,
    usageListeners,
  };
}
