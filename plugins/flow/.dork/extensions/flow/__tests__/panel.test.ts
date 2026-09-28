/**
 * The Flow panel's server side (spec `claude-account-ui` §8.5): the state
 * pill table, the slots math, `GET /panel` over flow's own files, pause and
 * resume through flow's own `config-files.ts`, and the throttled `panel` event.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileLike } from '../lib/advisor.ts';
import type { AccountSummary, AccountUsage } from '../lib/host-types.ts';
import {
  CheckoutResolver,
  discoverCheckouts,
  isLiveDrainRun,
  isStaleRun,
  pauseFlagPath,
  runAccountKey,
  runState,
  slotsOf,
  type PanelModel,
  type RunPill,
} from '../lib/panel.ts';
import { EMIT_INTERVAL_MS, SCHEDULES_NOTE_MS } from '../lib/panel-service.ts';
import { pidExists } from '../../../../scripts/cli/host-io.ts';
import type { RuntimeAccount } from '../../../../scripts/fleet/accounts.ts';
import { IMPLICIT_ACCOUNT_COLOR } from '../lib/fleet.ts';
import { createFlowExtension } from '../server.ts';
import {
  fakeCtx,
  fakeRouter,
  git,
  makeWorld,
  runRecord,
  writeFleet,
  writeLedger,
  writeRuns,
  type World,
} from './fixtures.ts';

/** The real extension folder, so pause and resume run flow's real `config-files.ts`. */
const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOW = new Date('2026-09-27T12:00:00.000Z');

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  vi.useRealTimers();
  world.cleanup();
});

/** One usage row as DorkOS serves it. */
function usage(id: string, extra: Partial<AccountUsage> = {}): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: id,
    label: null,
    color: '#2563eb',
    windows: [
      {
        key: 'five_hour',
        label: '5-hour',
        usedPct: 40,
        resetsAt: '2026-09-27T14:10:00.000Z',
        status: 'allowed',
        expired: false,
        observedAt: NOW.toISOString(),
        source: 'statusline',
      },
      {
        key: 'seven_day',
        label: 'This week',
        usedPct: 72,
        resetsAt: '2026-09-30T15:00:00.000Z',
        status: 'allowed',
        expired: false,
        observedAt: NOW.toISOString(),
        source: 'statusline',
      },
    ],
    state: 'ok',
    limit: null,
    updatedAt: NOW.toISOString(),
    ...extra,
  };
}

/** Build the extension over the fixture world. */
function setup(
  opts: Parameters<typeof fakeCtx>[1] = {},
  machine: { now?: () => Date; pidAlive?: (pid: number) => boolean } = {}
) {
  const router = fakeRouter();
  const host = fakeCtx(world, opts);
  const ext = createFlowExtension(router, host.ctx, {
    now: machine.now ?? (() => NOW),
    originOf: () => null,
    log: () => {},
    execFile: execFile as never,
    pidAlive: machine.pidAlive,
  });
  return { router, host, ext };
}

/** GET /panel's body. */
async function panel(
  router: ReturnType<typeof fakeRouter>,
  cwd: string = world.worktree
): Promise<PanelModel> {
  const sent = await router.call('get', '/panel', { query: { cwd } });
  expect(sent.status).toBe(200);
  return sent.body as PanelModel;
}

/** Write the project's committed flow settings. */
function writeConfig(main: string, drain: Record<string, unknown>): void {
  mkdirSync(path.join(main, '.agents', 'flow'), { recursive: true });
  writeFileSync(path.join(main, '.agents', 'flow', 'config.json'), JSON.stringify({ drain }));
}

describe('runState', () => {
  const rows: [string, Record<string, unknown>, RunPill][] = [
    [
      'a handoff under way',
      { limit: { state: 'handing-off' }, drain: { phase: 'working' } },
      'handing-off',
    ],
    ['winding down before a move', { limit: { state: 'winding-down' } }, 'handing-off'],
    [
      'ask mode waiting for the operator',
      { limit: { state: 'pending-approval' } },
      'waiting-on-you',
    ],
    [
      "a person's hold that will not resume itself",
      { limit: { state: 'waiting-reset', heldBy: 'person', resumeOnReset: false } },
      'waiting-on-you',
    ],
    ['parked for a person', { drain: { phase: 'parked', parkedFor: 'person' } }, 'waiting-on-you'],
    ['parked for another reason', { drain: { phase: 'parked', parkedFor: 'other' } }, 'parked'],
    ['parked by an older flow', { drain: { phase: 'parked' } }, 'parked'],
    ['waiting for the reset', { limit: { state: 'waiting-reset' } }, 'parked'],
    ['awaiting a handoff', { limit: { state: 'awaiting-handoff' } }, 'parked'],
    [
      "a person's hold that resumes at the reset",
      { limit: { heldBy: 'person', resumeOnReset: true } },
      'parked',
    ],
    ['reviewing', { drain: { phase: 'reviewing' } }, 'in-review'],
    ['PR ready', { drain: { phase: 'pr-ready' } }, 'in-review'],
    ['watching the PR', { drain: { phase: 'watching' } }, 'in-review'],
    ['working', { drain: { phase: 'working' } }, 'building'],
    ['fixing', { drain: { phase: 'fixing' } }, 'building'],
    ['fixing CI', { drain: { phase: 'fixing-ci' } }, 'building'],
    ['closing', { drain: { phase: 'closing' } }, 'building'],
    ['queued', { status: 'queued' }, 'building'],
    ['an interactive run', { status: 'running' }, 'building'],
    ['not a record', {}, 'building'],
  ];
  it.each(rows)('%s', (_name, run, pill) => {
    expect(runState(run)).toBe(pill);
  });
});

describe('slots', () => {
  it('counts the sequential default as one slot', () => {
    expect(slotsOf(0)).toBe(1);
    expect(slotsOf(3)).toBe(3);
  });

  it('counts only queued or running drain runs that are not parked as live', () => {
    const drain = (phase: string) => ({ v: 1, rev: 1, phase });
    expect(isLiveDrainRun({ status: 'running', drain: drain('working') })).toBe(true);
    expect(isLiveDrainRun({ status: 'queued', drain: drain('working') })).toBe(true);
    expect(isLiveDrainRun({ status: 'running', drain: drain('parked') })).toBe(false);
    expect(isLiveDrainRun({ status: 'waiting_for_review', drain: drain('watching') })).toBe(false);
    expect(isLiveDrainRun({ status: 'running' })).toBe(false);
  });
});

describe('isStaleRun', () => {
  it('reads a DorkOS run (workerPid -1) as live with the real pid check, as flow fleet does', () => {
    expect(isStaleRun({ status: 'running', workerPid: -1 }, pidExists)).toBe(false);
    expect(isStaleRun({ status: 'running', workerPid: 2 ** 22 + 7 }, pidExists)).toBe(true);
    expect(isStaleRun({ status: 'running', workerPid: process.pid }, pidExists)).toBe(false);
  });
});

describe('runAccountKey', () => {
  const registry = [
    { runtime: 'claude-code', id: 'work', implicit: false, isDefault: true },
    { runtime: 'codex', id: 'default', implicit: true, isDefault: true },
  ] as unknown as RuntimeAccount[];

  it('names a run on default, or on no account, by the registered account default points at', () => {
    expect(runAccountKey(registry, undefined, null)).toBe('claude-code:work');
    expect(runAccountKey(registry, 'claude-code', 'default')).toBe('claude-code:work');
    expect(runAccountKey(registry, 'codex', null)).toBe('codex:default');
    expect(runAccountKey(registry, 'claude-code', 'personal')).toBe('claude-code:personal');
    expect(runAccountKey([], 'claude-code', null)).toBe('claude-code:default');
  });
});

describe('discoverCheckouts', () => {
  it("finds the projects behind the drain's worktrees and the chats' folders, once each", () => {
    const repoDir = path.join(world.dorkHome, 'workspaces', 'app');
    mkdirSync(repoDir, { recursive: true });
    git(world.main, 'worktree', 'add', '-q', '-b', 'dork/acme-2', path.join(repoDir, 'ACME-2'));
    mkdirSync(path.join(repoDir, 'not-a-worktree'));
    const resolve = vi.fn((cwd: string) =>
      cwd.startsWith(world.root) && !cwd.endsWith('elsewhere') ? world.main : null
    );
    const resolver = new CheckoutResolver(resolve);
    const found = discoverCheckouts(
      world.dorkHome,
      [world.worktree, path.join(world.root, 'elsewhere')],
      resolver
    );
    expect(found).toEqual([world.main]);
    discoverCheckouts(world.dorkHome, [world.worktree], resolver);
    // Each folder is resolved once and remembered.
    expect(resolve.mock.calls.map(([cwd]) => cwd).sort()).toEqual(
      [path.join(repoDir, 'ACME-2'), world.worktree, path.join(world.root, 'elsewhere')].sort()
    );
  });
});

describe('GET /panel', () => {
  it("shows this computer's Claude sign-in once, as Main, beside the registered accounts", async () => {
    // The operator's shape: no registered row at the default folder, so DorkOS
    // lists the default on its own, labelled as its own sign-in; Main is it.
    const summaries: AccountSummary[] = [
      {
        runtime: 'claude-code',
        id: 'claude2',
        label: 'Claude2',
        color: '#16a34a',
        implicit: false,
      },
      {
        runtime: 'claude-code',
        id: 'claude3',
        label: 'Claude3',
        color: '#d97706',
        implicit: false,
      },
      {
        runtime: 'claude-code',
        id: 'claude4',
        label: 'Claude4',
        color: '#9333ea',
        implicit: false,
      },
      {
        runtime: 'claude-code',
        id: 'default',
        label: "Main (this computer's sign-in)",
        color: '#2563eb',
        implicit: true,
      },
      {
        runtime: 'codex',
        id: 'default',
        label: "Main (this computer's sign-in)",
        color: '#a855f7',
        implicit: true,
      },
    ];
    writeFleet(world.dorkHome, {
      accounts: {
        'claude-code:default': { role: 'main' },
        'claude-code:claude2': { role: 'rotation' },
      },
    });
    writeLedger(
      world.dorkHome,
      'claude-code',
      'default',
      { seven_day: { usedPct: 91, resetsAt: '2026-09-30T15:00:00.000Z' } },
      NOW.toISOString()
    );
    const { router } = setup({ summaries });
    const model = await panel(router);
    expect(model.accounts.map((a) => [a.key, a.label, a.reserved])).toEqual([
      ['claude-code:claude2', 'Claude2', false],
      ['claude-code:claude3', 'Claude3', false],
      ['claude-code:claude4', 'Claude4', false],
      ['claude-code:default', "Main (this computer's sign-in)", true],
      // Codex keeps its runtime's name: the panel has no runtime captions.
      ['codex:default', "Codex (this computer's sign-in)", false],
    ]);
    // Main takes DorkOS's color; Codex's own sign-in stays stone (Q21).
    expect(model.accounts.map((a) => [a.key, a.color])).toEqual([
      ['claude-code:claude2', '#16a34a'],
      ['claude-code:claude3', '#d97706'],
      ['claude-code:claude4', '#9333ea'],
      ['claude-code:default', '#2563eb'],
      ['codex:default', IMPLICIT_ACCOUNT_COLOR],
    ]);
  });

  it("falls back to flow's own label when DorkOS gives the Claude default none", async () => {
    const { router } = setup({
      summaries: [
        { runtime: 'claude-code', id: 'default', label: null, color: '#2563eb', implicit: true },
      ],
    });
    expect((await panel(router)).accounts.map((a) => a.label)).toEqual([
      "Main (this computer's sign-in)",
    ]);
  });

  it('shows a registered account at the default folder once, under its own label', async () => {
    // DorkOS folds `default` into the registered row whose folder it is.
    const { router } = setup({
      summaries: [
        { runtime: 'claude-code', id: 'work', label: 'Work', color: '#2563eb', implicit: false },
        {
          runtime: 'claude-code',
          id: 'claude2',
          label: 'Claude2',
          color: '#16a34a',
          implicit: false,
        },
      ],
    });
    expect((await panel(router)).accounts.map((a) => [a.key, a.label])).toEqual([
      ['claude-code:work', 'Work'],
      ['claude-code:claude2', 'Claude2'],
    ]);
  });

  it('shows every account with its usage, and every active run with its state', async () => {
    writeFleet(world.dorkHome, { accounts: { 'claude-code:work': { role: 'main' } } });
    writeLedger(
      world.dorkHome,
      'claude-code',
      'work',
      { seven_day: { usedPct: 72, resetsAt: '2026-09-30T15:00:00.000Z' } },
      NOW.toISOString()
    );
    writeConfig(world.main, { parallel: 3 });
    writeRuns(world, {
      i1: runRecord(world, { title: 'account chip' }),
      i2: runRecord(world, {
        issueId: 'i2',
        identifier: 'ACME-2',
        sessionId: '',
        status: 'queued',
        worktreePath: '',
        account: 'personal',
        drain: { v: 1, rev: 1, phase: 'working' },
      }),
      i3: runRecord(world, {
        issueId: 'i3',
        identifier: 'ACME-3',
        sessionId: 's-3',
        drain: { v: 1, rev: 1, phase: 'parked', parkedFor: 'person' },
      }),
      i4: runRecord(world, { issueId: 'i4', identifier: 'ACME-4', status: 'complete' }),
    });
    const { router } = setup({
      usage: [
        usage('work', { subscriptionType: 'max' }),
        usage('personal', {
          state: 'limited',
          limit: { window: 'seven_day', resetsAt: '2026-09-29T15:00:00.000Z' },
        }),
      ],
    });
    const model = await panel(router);

    expect(model.accounts.map((a) => [a.key, a.label, a.reserved])).toEqual([
      ['claude-code:work', 'Work', true],
      ['claude-code:personal', 'personal', false],
      ['codex:default', "Codex (this computer's sign-in)", false],
    ]);
    const [work, personal, codex] = model.accounts;
    expect(work).toMatchObject({
      runtime: 'claude-code',
      id: 'work',
      color: '#2563eb',
      out: null,
      plan: 'max',
      windows: {
        five_hour: { usedPct: 40, resetsAt: '2026-09-27T14:10:00.000Z', status: 'allowed' },
        seven_day: { usedPct: 72, resetsAt: '2026-09-30T15:00:00.000Z', status: 'allowed' },
      },
    });
    expect(personal.out).toEqual({ resetsAt: '2026-09-29T15:00:00.000Z' });
    expect(codex.windows).toEqual({ five_hour: null, seven_day: null });
    expect(codex.plan).toBeNull();

    expect(model.runs).toEqual([
      {
        identifier: 'ACME-1',
        title: 'account chip',
        sessionId: 's-old',
        cwd: world.worktree,
        accountKey: 'claude-code:work',
        state: 'building',
      },
      {
        identifier: 'ACME-2',
        title: null,
        sessionId: null,
        cwd: world.main,
        accountKey: 'claude-code:personal',
        state: 'building',
      },
      {
        identifier: 'ACME-3',
        title: null,
        sessionId: 's-3',
        cwd: world.worktree,
        accountKey: 'claude-code:work',
        state: 'waiting-on-you',
      },
    ]);
    // Two live drain runs (the parked one holds no slot) of drain.parallel 3.
    expect(model.slots).toEqual({ busy: 2, total: 3 });
    expect(model.paused).toBe('none');
    expect(model.canPause).toBe(true);
    expect(model.schedulesOff).toBe(false);
  });

  it("neither shows nor counts a run whose worker is gone, by flow fleet's rule", async () => {
    writeConfig(world.main, { parallel: 3 });
    writeRuns(world, {
      live: runRecord(world, { issueId: 'live', identifier: 'ACME-1', workerPid: 111 }),
      crashed: runRecord(world, { issueId: 'crashed', identifier: 'ACME-2', workerPid: 222 }),
      dorkos: runRecord(world, {
        issueId: 'dorkos',
        identifier: 'ACME-3',
        host: 'dorkos',
        workerPid: -1,
      }),
      review: runRecord(world, {
        issueId: 'review',
        identifier: 'ACME-4',
        status: 'waiting_for_review',
        workerPid: 222,
        drain: { v: 1, rev: 1, phase: 'watching' },
      }),
    });
    const { router } = setup({}, { pidAlive: (pid) => pid !== 222 });
    const model = await panel(router);
    expect(model.runs.map((r) => r.identifier)).toEqual(['ACME-1', 'ACME-3', 'ACME-4']);
    expect(model.slots).toEqual({ busy: 2, total: 3 });
  });

  it('has nothing to pause when no project has flow runs or settings', async () => {
    const { router } = setup();
    const model = await panel(router);
    expect(model.runs).toEqual([]);
    expect(model.slots).toEqual({ busy: 0, total: 0 });
    expect(model.canPause).toBe(false);
    expect(model.paused).toBe('none');
  });

  it('counts parallel 0 as one slot per project', async () => {
    writeConfig(world.main, {});
    const { router } = setup();
    expect((await panel(router)).slots).toEqual({ busy: 0, total: 1 });
  });

  it('answers 501 host-too-old on an older DorkOS', async () => {
    const router = fakeRouter();
    createFlowExtension(router, fakeCtx(world, { dorkHome: false }).ctx);
    for (const [method, route] of [
      ['get', '/panel'],
      ['post', '/pause'],
      ['post', '/resume'],
    ] as const) {
      expect(await router.call(method, route)).toEqual({
        status: 501,
        body: { reason: 'host-too-old' },
      });
    }
  });
});

describe('POST /pause and /resume', () => {
  it("pause and resume flow in every project shown, through flow's own pause file", async () => {
    // A second project, covered through a chat opened in it.
    const other = path.join(world.root, 'other');
    mkdirSync(other);
    git(other, 'init', '-q');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'init');
    writeConfig(world.main, { parallel: 2 });
    writeConfig(other, {});
    const { router } = setup({ extensionDir: EXTENSION_DIR });
    await panel(router, world.worktree);
    await panel(router, other);

    const paused = await router.call('post', '/pause');
    expect(paused.status).toBe(200);
    expect((paused.body as PanelModel).paused).toBe('all');
    expect(existsSync(pauseFlagPath(world.main))).toBe(true);
    expect(existsSync(pauseFlagPath(other))).toBe(true);

    // Resume one by hand: the panel reads some, and Pause pauses only the rest.
    rmSync(pauseFlagPath(other));
    expect((await panel(router)).paused).toBe('some');
    expect(((await router.call('post', '/pause')).body as PanelModel).paused).toBe('all');

    const resumed = await router.call('post', '/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body as PanelModel).toMatchObject({ paused: 'none', schedulesOff: false });
    expect(existsSync(pauseFlagPath(world.main))).toBe(false);
    expect(existsSync(pauseFlagPath(other))).toBe(false);
  }, 30_000);

  it('notes when a resume leaves DorkOS schedules that /flow:pause switched off', async () => {
    writeConfig(world.main, {});
    mkdirSync(path.dirname(pauseFlagPath(world.main)), { recursive: true });
    writeFileSync(
      pauseFlagPath(world.main),
      JSON.stringify({ pausedAt: NOW.toISOString(), hostSchedules: ['sched-1'] })
    );
    let now = NOW;
    const { router } = setup({ extensionDir: EXTENSION_DIR }, { now: () => now });
    expect((await panel(router)).paused).toBe('all');
    const resumed = await router.call('post', '/resume');
    expect(resumed.body as PanelModel).toMatchObject({ paused: 'none', schedulesOff: true });

    // Still up just under ten minutes later, gone on the first read after.
    now = new Date(NOW.getTime() + SCHEDULES_NOTE_MS - 1);
    expect((await panel(router)).schedulesOff).toBe(true);
    now = new Date(NOW.getTime() + SCHEDULES_NOTE_MS);
    expect((await panel(router)).schedulesOff).toBe(false);
  }, 30_000);

  it('drops the note from the live panel event too, once it has been up ten minutes', async () => {
    writeConfig(world.main, {});
    mkdirSync(path.dirname(pauseFlagPath(world.main)), { recursive: true });
    writeFileSync(
      pauseFlagPath(world.main),
      JSON.stringify({ pausedAt: NOW.toISOString(), hostSchedules: ['sched-1'] })
    );
    let now = NOW;
    const { router, host } = setup({ extensionDir: EXTENSION_DIR }, { now: () => now });
    await panel(router);
    await router.call('post', '/resume');
    const lastSent = () => host.emit.mock.calls.at(-1)?.[1] as PanelModel | undefined;
    await vi.waitFor(() => expect(lastSent()?.schedulesOff).toBe(true), { timeout: 3_000 });

    // No GET /panel: only the panel's own poll runs, and its event drops the note.
    now = new Date(NOW.getTime() + SCHEDULES_NOTE_MS);
    await host.scheduled[0]();
    await vi.waitFor(() => expect(lastSent()?.schedulesOff).toBe(false), { timeout: 3_000 });
  }, 30_000);

  it('drops the note when resume is called again and finds nothing switched off', async () => {
    writeConfig(world.main, {});
    const flag = pauseFlagPath(world.main);
    mkdirSync(path.dirname(flag), { recursive: true });
    writeFileSync(flag, JSON.stringify({ pausedAt: NOW.toISOString(), hostSchedules: ['s-1'] }));
    const { router } = setup({ extensionDir: EXTENSION_DIR });
    await panel(router);
    expect(((await router.call('post', '/resume')).body as PanelModel).schedulesOff).toBe(true);
    writeFileSync(flag, JSON.stringify({ pausedAt: NOW.toISOString(), hostSchedules: [] }));
    expect(((await router.call('post', '/resume')).body as PanelModel).schedulesOff).toBe(false);
  }, 30_000);

  it('answers 502 in plain words when flow could not pause', async () => {
    writeConfig(world.main, {});
    const router = fakeRouter();
    const host = fakeCtx(world);
    createFlowExtension(router, host.ctx, {
      now: () => NOW,
      log: () => {},
      execFile: ((_file, _args, _opts, callback) => {
        callback(Object.assign(new Error('boom'), { code: 1 }), '', '');
      }) satisfies ExecFileLike,
    });
    await router.call('get', '/panel', { query: { cwd: world.worktree } });
    expect(await router.call('post', '/pause')).toEqual({
      status: 502,
      body: { error: "Flow couldn't pause in main. Try again.", refusedBy: 'flow' },
    });
  });
});

describe('the panel event', () => {
  it('sends the model when usage changes, at most once a second', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { host } = setup({ usage: [usage('work')] });
    const changed = () => {
      for (const listener of host.usageListeners) listener(usage('work'));
    };

    changed();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.emit).toHaveBeenCalledTimes(1);
    expect(host.emit.mock.calls[0][0]).toBe('panel');

    // A burst inside the second shares one event, sent when the second is up.
    const listenerUsage = usage('work', {
      windows: [{ ...usage('work').windows[0], usedPct: 91 }],
    });
    host.accounts.usage.mockResolvedValue([listenerUsage]);
    changed();
    changed();
    changed();
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS / 2);
    expect(host.emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    expect(host.emit).toHaveBeenCalledTimes(2);
    const sent = host.emit.mock.calls[1][1] as PanelModel;
    expect(sent.accounts[0].windows.five_hour?.usedPct).toBe(91);
  });

  it('sends nothing when the model did not change, and polls the run stores', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { host, router } = setup();
    await panel(router);
    // The panel's poll is scheduled first, before the continued-watcher's.
    const poll = host.scheduled[0];
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    await poll();
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    expect(host.emit).toHaveBeenCalledTimes(1);

    writeRuns(world, { i1: runRecord(world) });
    await poll();
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    expect(host.emit).toHaveBeenCalledTimes(2);
    expect((host.emit.mock.calls[1][1] as PanelModel).runs.map((r) => r.identifier)).toEqual([
      'ACME-1',
    ]);
  });

  it('stops listening on dispose', () => {
    const { host, ext } = setup();
    expect(host.usageListeners).toHaveLength(1);
    ext.dispose();
    expect(host.usageListeners).toHaveLength(0);
  });
});
