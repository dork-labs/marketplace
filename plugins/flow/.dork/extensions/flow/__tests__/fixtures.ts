/**
 * Test fixtures for the Flow extension: a temp DorkOS home, a fake host
 * context and router, a temp git project with a linked worktree, and writers
 * for flow's ledger, fleet and run store files.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type {
  AccountAdvisor,
  AccountSummary,
  DataProviderContext,
  ExtensionRouter,
  RouteHandler,
} from '../lib/host-types.ts';

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

/** A fake response that records what a handler sent. */
export interface Sent {
  status: number;
  body: unknown;
}

/** A router that records handlers and can call them. */
export interface FakeRouter extends ExtensionRouter {
  call(
    method: 'get' | 'put',
    route: string,
    req?: { params?: Record<string, string>; body?: unknown }
  ): Promise<Sent>;
}

/** Make a fake router. */
export function fakeRouter(): FakeRouter {
  const handlers = new Map<string, RouteHandler>();
  return {
    get(route, handler) {
      handlers.set(`get ${route}`, handler);
    },
    put(route, handler) {
      handlers.set(`put ${route}`, handler);
    },
    async call(method, route, req = {}) {
      const handler = handlers.get(`${method} ${route}`);
      if (handler === undefined) throw new Error(`no ${method} ${route}`);
      const sent: Sent = { status: 200, body: undefined };
      const res = {
        status(code: number) {
          sent.status = code;
          return res;
        },
        json(body: unknown) {
          sent.body = body;
          return res;
        },
      };
      await handler({ params: req.params ?? {}, body: req.body }, res);
      return sent;
    },
  };
}

/** A fake host context over `world`, with an in-memory storage that can be shared. */
export function fakeCtx(
  world: World,
  opts: {
    summaries?: AccountSummary[];
    storage?: { data: unknown };
    accounts?: 'full' | 'none' | 'no-mark-continued';
    dorkHome?: boolean;
  } = {}
) {
  const store = opts.storage ?? { data: null };
  const registered: AccountAdvisor[] = [];
  const unregister = vi.fn();
  const cancelSchedule = vi.fn();
  const scheduled: (() => Promise<void>)[] = [];
  const accounts = {
    list: vi.fn(async () => opts.summaries ?? SUMMARIES),
    usage: vi.fn(async () => []),
    onUsage: vi.fn(() => () => {}),
    markContinued: vi.fn(async () => {}),
    registerAdvisor: vi.fn((advisor: AccountAdvisor) => {
      registered.push(advisor);
      return unregister;
    }),
  };
  const mode = opts.accounts ?? 'full';
  const ctxAccounts =
    mode === 'none'
      ? undefined
      : mode === 'no-mark-continued'
        ? { ...accounts, markContinued: undefined }
        : accounts;
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
    extensionId: 'flow',
    extensionDir: path.join(world.root, 'plugins', 'flow', '.dork', 'extensions', 'flow'),
    ...(opts.dorkHome === false ? {} : { dorkHome: world.dorkHome }),
    ...(ctxAccounts === undefined ? {} : { accounts: ctxAccounts }),
  };
  return { ctx, accounts, registered, unregister, cancelSchedule, scheduled, store };
}
