/**
 * The Flow tab's routes (spec `flow-multiproject` §2, §5.2, §10, §11):
 * `GET /model` over every flow project; `POST /pause` and `POST /resume` for
 * one project or all, with an end time, through flow's own `config-files.ts`;
 * the expiry sweep that lifts an ended pause and queues the schedules it had
 * switched off; the person guard in front of every route that changes
 * something (and those routes missing on a host without it); and the
 * throttled `model` event.
 *
 * Tracker reads are faked: a test never runs a real adapter.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileLike } from '../lib/advisor.ts';
import type { FlowModel } from '../lib/model.ts';
import {
  EMIT_INTERVAL_MS,
  PAUSE_RANGE_MESSAGE,
  parseTarget,
  parseUntil,
} from '../lib/model-service.ts';
import { pauseFlagPath } from '../lib/model.ts';
import { createFlowExtension } from '../server.ts';
import {
  NOT_A_PERSON,
  fakeCtx,
  fakeProjects,
  fakeRouter,
  git,
  makeWorld,
  runRecord,
  writeRuns,
  type World,
} from './fixtures.ts';

/** The real extension folder, so pause and resume run flow's real `config-files.ts`. */
const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOW = new Date('2026-09-28T12:00:00.000Z');

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  vi.useRealTimers();
  world.cleanup();
});

/** Write a project's committed flow settings (a Linear project over cli). */
function configure(root: string, config: Record<string, unknown> = {}): void {
  mkdirSync(path.join(root, '.agents', 'flow'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'flow', 'config.json'), JSON.stringify(config));
}

/** A second project with flow settings. */
function otherProject(): string {
  const other = path.join(world.root, 'other');
  mkdirSync(other);
  git(other, 'init', '-q');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'init');
  configure(other);
  return other;
}

/**
 * Run flow's real `config-files.ts`, and answer every tracker read (`flow.ts`)
 * as a tracker that did not answer, so no test ever reaches a real tracker.
 */
const execOrFakeRead: ExecFileLike = (file, args, opts, callback) => {
  if (args.some((arg) => arg.endsWith(`${path.sep}flow.ts`))) {
    queueMicrotask(() => callback(Object.assign(new Error('no tracker'), { code: 4 }), '', ''));
    return undefined;
  }
  return (execFile as unknown as ExecFileLike)(file, args, opts, callback);
};

/** Build the extension over the fixture world. */
function setup(
  opts: Parameters<typeof fakeCtx>[1] = {},
  machine: { now?: () => Date; execFile?: ExecFileLike } = {}
) {
  const router = fakeRouter();
  const host = fakeCtx(world, { extensionDir: EXTENSION_DIR, ...opts });
  const ext = createFlowExtension(router, host.ctx, {
    now: machine.now ?? (() => NOW),
    originOf: () => null,
    log: () => {},
    execFile: machine.execFile ?? execOrFakeRead,
    pidAlive: () => true,
  });
  return { router, host, ext };
}

/** `GET /model`'s body. */
async function model(
  router: ReturnType<typeof fakeRouter>,
  cwd: string | null = world.worktree
): Promise<FlowModel> {
  const sent = await router.call('get', '/model', { query: cwd === null ? {} : { cwd } });
  expect(sent.status).toBe(200);
  return sent.body as FlowModel;
}

/**
 * An end `minutes` from the real clock. flow's `config-files.ts` judges an end
 * against the real clock, so the pause tests run the routes on it too.
 */
function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** The routes on the real clock, for tests that run flow's real pause. */
const REAL_CLOCK = { now: () => new Date() };

/** A project's flag, as written. */
function flag(root: string): Record<string, unknown> | null {
  const file = pauseFlagPath(root);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

describe('parseTarget and parseUntil', () => {
  it('takes one project or all, and an old empty body as all with no end', () => {
    expect(parseTarget(undefined)).toEqual({ all: true });
    expect(parseTarget({ project: 'dorkos' })).toEqual({ project: 'dorkos' });
    expect(() => parseTarget({ project: 'dorkos', all: true })).toThrow();
    expect(parseUntil(undefined, NOW)).toBeNull();
    expect(parseUntil({ until: null }, NOW)).toBeNull();
  });

  it('takes an end in the next 30 days, with its zone, and nothing else', () => {
    expect(parseUntil({ until: '2026-09-29T09:00:00+02:00' }, NOW)).toBe(
      '2026-09-29T09:00:00+02:00'
    );
    for (const until of [
      '2026-09-28T11:59:59Z',
      '2026-10-28T12:00:01Z',
      '2026-09-29T09:00:00',
      'tomorrow',
      42,
    ]) {
      expect(() => parseUntil({ until }, NOW)).toThrow(PAUSE_RANGE_MESSAGE);
    }
  });
});

describe('GET /model', () => {
  it('shows each flow project with its runs, says which one the chat is in, and never shows accounts', async () => {
    configure(world.main, { drain: { parallel: 2 } });
    writeRuns(world, { a: runRecord(world, { title: 'Out-of-usage banner' }) });
    const other = otherProject();
    const { router } = setup();
    await model(router, other);
    const body = await model(router);
    expect(body.cwdProject).toBe('main');
    expect(body.canChange).toBe(true);
    expect(body.decisions).toEqual([]);
    expect(body.projects.map((p) => [p.name, p.setup, p.capacity])).toEqual([
      ['main', 'ready', { busy: 1, slots: 2 }],
      ['other', 'ready', { busy: 0, slots: 1 }],
    ]);
    expect(body.projects[0].runs.map((run) => [run.identifier, run.account.label])).toEqual([
      ['ACME-1', 'Work'],
    ]);
    expect(body.projects[1].runs).toEqual([]);
    expect(body).not.toHaveProperty('accounts');
  });

  it("uses core's project names and its answer for the chat's folder", async () => {
    configure(world.main);
    const core = fakeProjects([
      { root: world.main, name: 'app~acme', originRepo: 'acme/app', lastSeenAt: NOW.toISOString() },
    ]);
    const { router, host } = setup({ projects: core.api });
    const body = await model(router);
    expect(body.projects.map((p) => p.name)).toEqual(['app~acme']);
    expect(body.cwdProject).toBe('app~acme');
    expect(core.api.resolve).toHaveBeenCalledWith(world.worktree);
    // A change in core's list sends a new model without waiting for the poll.
    expect(host.emit).not.toHaveBeenCalled();
    core.changed();
    await vi.waitFor(() => expect(host.emit).toHaveBeenCalledWith('model', expect.any(Object)));
  });

  it('answers 501 host-too-old for every route on an older DorkOS', async () => {
    const router = fakeRouter();
    createFlowExtension(router, fakeCtx(world, { dorkHome: false }).ctx);
    for (const [method, route] of [
      ['get', '/model'],
      ['post', '/pause'],
      ['post', '/resume'],
      ['post', '/schedules/restored'],
      ['get', '/capacity'],
    ] as const) {
      expect(await router.call(method, route)).toEqual({
        status: 501,
        body: { reason: 'host-too-old' },
      });
    }
    expect(router.has('get', '/panel')).toBe(false);
  });
});

describe('the person guard', () => {
  it('stands in front of every route that changes something, and refuses an agent', async () => {
    configure(world.main);
    const { router, host } = setup();
    for (const [method, route] of [
      ['put', '/fleet/accounts/:key'],
      ['put', '/fleet/handoff'],
      ['put', '/fleet/cross-runtime'],
      ['post', '/pause'],
      ['post', '/resume'],
      ['post', '/schedules/restored'],
    ] as const) {
      expect(router.chain(method, route)[0]).toBe(host.requirePerson);
      expect(await router.call(method, route, { agent: true, body: { all: true } })).toEqual({
        status: 403,
        body: { error: NOT_A_PERSON },
      });
    }
    expect(flag(world.main)).toBeNull();
    // Reading is open to anyone.
    expect(router.chain('get', '/model')).toHaveLength(1);
    expect(router.chain('get', '/fleet')).toHaveLength(1);
    expect(router.chain('get', '/capacity')).toHaveLength(1);
  });

  it('registers no pause route on a host that cannot tell a person from an agent', async () => {
    configure(world.main);
    const { router } = setup({ personGuard: false });
    expect(router.has('post', '/pause')).toBe(false);
    expect(router.has('post', '/resume')).toBe(false);
    expect(router.has('post', '/schedules/restored')).toBe(false);
    expect((await model(router)).canChange).toBe(false);
    // The fleet writes keep working there, as they always have.
    expect(router.chain('put', '/fleet/handoff')).toHaveLength(1);
  });
});

describe('POST /pause and /resume', () => {
  it('pauses one project until a time, then every project, then resumes one', async () => {
    configure(world.main);
    const other = otherProject();
    const { router } = setup({}, REAL_CLOCK);
    await model(router);
    await model(router, other);

    const first = inMinutes(60);
    const one = await router.call('post', '/pause', { body: { project: 'main', until: first } });
    expect(one.status).toBe(200);
    const paused = one.body as FlowModel;
    expect(paused.projects.map((p) => [p.name, p.pause?.until ?? null])).toEqual([
      ['main', first],
      ['other', null],
    ]);
    expect(paused.projects[1].pause).toBeNull();

    // Pause all applies one new end everywhere, the paused project included.
    const second = inMinutes(120);
    const all = await router.call('post', '/pause', { body: { all: true, until: second } });
    expect((all.body as FlowModel).projects.map((p) => p.pause?.until)).toEqual([second, second]);

    const resumed = await router.call('post', '/resume', { body: { project: 'other' } });
    expect((resumed.body as FlowModel).projects.map((p) => p.pause !== null)).toEqual([
      true,
      false,
    ]);
    expect(flag(other)).toBeNull();
  }, 30_000);

  it('pauses every project with no end for a client from before (empty body)', async () => {
    configure(world.main);
    const { router } = setup();
    await model(router);
    const sent = await router.call('post', '/pause');
    expect(sent.status).toBe(200);
    expect((sent.body as FlowModel).projects[0].pause).toMatchObject({ until: null });
    expect(flag(world.main)).toMatchObject({ until: null });
  }, 30_000);

  it('refuses an end in the past or more than 30 days away, and an unknown project', async () => {
    configure(world.main);
    const { router } = setup();
    await model(router);
    for (const until of ['2026-09-28T11:00:00Z', '2026-11-28T11:00:00Z']) {
      expect(await router.call('post', '/pause', { body: { all: true, until } })).toEqual({
        status: 400,
        body: { error: PAUSE_RANGE_MESSAGE, refusedBy: 'flow' },
      });
    }
    expect(await router.call('post', '/pause', { body: { project: 'nope', until: null } })).toEqual(
      {
        status: 404,
        body: { error: 'No flow project is called nope on this computer.', refusedBy: 'flow' },
      }
    );
    expect(flag(world.main)).toBeNull();
  });

  it('ends a pause over switched-off schedules, and queues them to switch back on', async () => {
    // A terminal /flow:pause switched a schedule off; a timed pause from the
    // tab keeps it recorded, and a resume hands it back to switch on.
    configure(world.main);
    mkdirSync(path.dirname(pauseFlagPath(world.main)), { recursive: true });
    writeFileSync(
      pauseFlagPath(world.main),
      JSON.stringify({ pausedAt: NOW.toISOString(), hostSchedules: ['sched-1'] })
    );
    const { router } = setup({}, REAL_CLOCK);
    await model(router);
    const until = inMinutes(60);
    const timed = await router.call('post', '/pause', { body: { project: 'main', until } });
    expect(timed.status).toBe(200);
    expect(flag(world.main)).toMatchObject({ until, hostSchedules: ['sched-1'] });
    const resumed = (await router.call('post', '/resume', { body: { project: 'main' } }))
      .body as FlowModel;
    expect(resumed.projects[0].restoreSchedules).toEqual(['sched-1']);
    const done = (
      await router.call('post', '/schedules/restored', {
        body: { project: 'main', ids: ['sched-1'] },
      })
    ).body as FlowModel;
    expect(done.projects[0].restoreSchedules).toEqual([]);
  }, 30_000);

  it('answers 502 in plain words when flow could not pause', async () => {
    configure(world.main);
    const { router } = setup(
      {},
      {
        execFile: ((_file, _args, _opts, callback) => {
          callback(Object.assign(new Error('boom'), { code: 1 }), '', '');
        }) satisfies ExecFileLike,
      }
    );
    await model(router);
    expect(await router.call('post', '/pause', { body: { project: 'main', until: null } })).toEqual(
      { status: 502, body: { error: "Flow couldn't pause main. Try again.", refusedBy: 'flow' } }
    );
  });
});

describe('the expiry sweep', () => {
  it('lifts a pause once its end has passed, once, and queues its schedules', async () => {
    configure(world.main);
    mkdirSync(path.dirname(pauseFlagPath(world.main)), { recursive: true });
    writeFileSync(
      pauseFlagPath(world.main),
      JSON.stringify({
        pausedAt: '2026-09-28T08:00:00.000Z',
        until: '2026-09-28T11:00:00.000Z',
        hostSchedules: ['sched-2'],
      })
    );
    const calls: string[] = [];
    const counting: ExecFileLike = (file, args, opts, callback) => {
      if (args.includes('resume')) calls.push('resume');
      return execOrFakeRead(file, args, opts, callback);
    };
    const { router, host } = setup({}, { execFile: counting });
    await model(router);
    const poll = host.scheduled[0];
    await poll();
    expect(flag(world.main)).toBeNull();
    await poll();
    expect(calls).toEqual(['resume']);
    const body = await model(router);
    expect(body.projects[0].pause).toBeNull();
    expect(body.projects[0].restoreSchedules).toEqual(['sched-2']);
  }, 30_000);

  it('leaves a pause with no end, or an end still to come', async () => {
    configure(world.main);
    mkdirSync(path.dirname(pauseFlagPath(world.main)), { recursive: true });
    writeFileSync(pauseFlagPath(world.main), JSON.stringify({ until: '2026-09-28T13:00:00Z' }));
    const { router, host } = setup();
    await model(router);
    await host.scheduled[0]();
    expect(flag(world.main)).not.toBeNull();
  });
});

describe('the model event', () => {
  it('is sent when the model changed, at most once a second, and polls the run stores', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    configure(world.main);
    const { host, router } = setup();
    await model(router);
    const poll = host.scheduled[0];
    await poll();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.emit).toHaveBeenCalledTimes(1);
    expect(host.emit.mock.calls[0][0]).toBe('model');
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    await poll();
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    expect(host.emit).toHaveBeenCalledTimes(1);

    writeRuns(world, { i1: runRecord(world) });
    await poll();
    await vi.advanceTimersByTimeAsync(EMIT_INTERVAL_MS);
    expect(host.emit).toHaveBeenCalledTimes(2);
    const sent = host.emit.mock.calls[1][1] as FlowModel;
    expect(sent.projects[0].runs.map((run) => run.identifier)).toEqual(['ACME-1']);
  });

  it('stops polling and listening on dispose', () => {
    const core = fakeProjects();
    const { host, ext } = setup({ projects: core.api });
    expect(core.listeners).toHaveLength(1);
    ext.dispose();
    expect(core.listeners).toHaveLength(0);
    expect(host.cancelSchedule).toHaveBeenCalledTimes(2);
  });
});
