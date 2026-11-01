/**
 * The Flow tab's routes (spec `flow-multiproject` §2, §5.2, §10, §11):
 * `GET /model` over every flow project; `POST /pause` and `POST /resume` for
 * one project or all, with an end time, through flow's own `config-files.ts`;
 * the expiry sweep that lifts an ended pause and queues the schedules it had
 * switched off; the person bar in front of every route that changes
 * something; the fetch handler DorkOS serves, with a JSON 404 for a path flow
 * does not serve; and the throttled `model` event.
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
import { UNKNOWN_CALLER } from '../lib/person.ts';
import register, { createFlowExtension } from '../server.ts';
import {
  AGENT,
  PERSON,
  REFUSED_AGENT,
  fakeCtx,
  fakeProjects,
  git,
  makeWorld,
  readFleet,
  runRecord,
  send,
  writeFleet,
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
  const host = fakeCtx(world, { extensionDir: EXTENSION_DIR, ...opts });
  const ext = createFlowExtension(host.ctx, {
    now: machine.now ?? (() => NOW),
    originOf: () => null,
    log: () => {},
    execFile: machine.execFile ?? execOrFakeRead,
    pidAlive: () => true,
  });
  return { app: ext.app, host, ext };
}

/** `GET /model`'s body. */
async function model(
  app: ReturnType<typeof setup>['app'],
  cwd: string | null = world.worktree
): Promise<FlowModel> {
  const query = cwd === null ? '' : `?cwd=${encodeURIComponent(cwd)}`;
  const sent = await send(app, 'GET', `/model${query}`);
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
    const { app } = setup();
    await model(app, other);
    const body = await model(app);
    expect(body.cwdProject).toBe('main');
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
    const { app, host } = setup({ projects: core.api });
    const body = await model(app);
    expect(body.projects.map((p) => p.name)).toEqual(['app~acme']);
    expect(body.cwdProject).toBe('app~acme');
    expect(core.api.resolve).toHaveBeenCalledWith(world.worktree);
    // A change in core's list sends a new model without waiting for the poll
    // (after the first pass, which runs at start).
    await vi.waitFor(() => expect(host.emit).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, EMIT_INTERVAL_MS + 50));
    host.emit.mockClear();
    core.list[0] = { ...core.list[0], name: 'app~renamed' };
    core.changed();
    await vi.waitFor(() => expect(host.emit).toHaveBeenCalledWith('model', expect.any(Object)));
  });
});

describe('the person bar', () => {
  it('stands in front of every route that changes something, and answers an agent with its verdict', async () => {
    configure(world.main);
    writeFleet(world.dorkHome, { handoff: 'auto' });
    const { app } = setup();
    await model(app);
    const served = [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))];
    // Every GET route, listed: a new one fails here until someone decides it
    // only reads, or puts it behind the bar. GET /model?cwd= also remembers
    // the folder and reports it to DorkOS's project registry with no bar; that
    // is a known gap, to be closed in its own ticket.
    expect(served.filter((route) => route.startsWith('GET ')).sort()).toEqual([
      'GET /capacity',
      'GET /fleet',
      'GET /fleet/migration',
      'GET /model',
      'GET /settings/:name',
    ]);
    // Every other route (any method, `app.all` included), so a write route
    // added later is held to the same bar without anyone listing it here.
    const writes = served.filter(
      (route) => !route.startsWith('GET ') && !route.startsWith('HEAD ')
    );
    expect(writes.sort()).toEqual(
      expect.arrayContaining([
        'POST /decisions/:key',
        'POST /pause',
        'POST /projects/:name/allow-adapter',
        'POST /resume',
        'POST /schedules/restored',
        'PUT /fleet/accounts/:key',
        'PUT /fleet/cross-runtime',
        'PUT /fleet/handoff',
        'PUT /fleet/migration',
        'PUT /settings/:name',
      ])
    );
    for (const write of writes) {
      const [declared, pattern] = write.split(' ') as [string, string];
      // A real value for each parameter: the project, or an account's key.
      const route = pattern.replace(/:name/g, 'main').replace(/:key/g, 'claude-code%3Awork');
      // An `app.all` route answers every method, so it is tried as a read too.
      const methods = (declared === 'ALL' ? ['GET', 'POST', 'PUT'] : [declared]) as (
        'GET' | 'PUT' | 'POST'
      )[];
      for (const method of methods) {
        const sent = await send(app, method, route, {
          agent: true,
          body: method === 'GET' ? undefined : { all: true, handoff: 'ask', role: 'main' },
        });
        expect(sent, `${method} via ${write}`).toEqual(REFUSED_AGENT);
      }
    }
    // The routes never ran: nothing was paused or written.
    expect(flag(world.main)).toBeNull();
    expect(readFleet(world.dorkHome)).toEqual({ v: 1, handoff: 'auto' });
    // Reading is open to anyone.
    for (const route of ['/model', '/fleet', '/capacity', '/settings/main', '/fleet/migration']) {
      expect((await send(app, 'GET', route, { agent: true })).status).toBe(200);
    }
    // A trailing slash reaches the same route, and the same bar.
    for (const route of ['/pause/', '/fleet/handoff/']) {
      const method = route === '/pause/' ? 'POST' : 'PUT';
      expect(await send(app, method, route, { agent: true, body: { all: true } }), route).toEqual(
        REFUSED_AGENT
      );
    }
    // No verdict, or one flow cannot read, fails closed on every write.
    for (const caller of [undefined, {}, { person: { ok: 'yes' } }, { person: { ok: false } }]) {
      for (const write of writes) {
        const [declared, pattern] = write.split(' ') as [string, string];
        const method = declared === 'ALL' ? 'POST' : declared;
        const route = pattern.replace(/:name/g, 'main').replace(/:key/g, 'claude-code%3Awork');
        const res = await app.request(
          route,
          {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ all: true, handoff: 'ask', role: 'main' }),
          },
          caller as never
        );
        expect(res.status, write).toBe(403);
        expect(await res.json(), write).toEqual(UNKNOWN_CALLER.body);
      }
    }
    expect(flag(world.main)).toBeNull();
    expect(readFleet(world.dorkHome)).toEqual({ v: 1, handoff: 'auto' });
  });
});

describe('the fetch handler', () => {
  it('serves the routes below the mount with the caller as c.env, and stops on cleanup', async () => {
    const core = fakeProjects();
    const host = fakeCtx(world, { extensionDir: EXTENSION_DIR, projects: core.api });
    const handlers = register(undefined, host.ctx);
    const fleet = await handlers.fetch(new Request('http://localhost/fleet'), PERSON);
    expect(fleet.status).toBe(200);
    expect(fleet.headers.get('content-type')).toMatch(/^application\/json/);
    const refused = await handlers.fetch(
      new Request('http://localhost/fleet/handoff', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handoff: 'ask' }),
      }),
      AGENT
    );
    expect(refused.status).toBe(403);
    expect(core.listeners).toHaveLength(1);
    await handlers.cleanup();
    expect(core.listeners).toHaveLength(0);
    expect(host.unregister).toHaveBeenCalledTimes(1);
  });

  it('answers a path flow does not serve with a JSON 404', async () => {
    const { app } = setup();
    expect(await send(app, 'GET', '/panel')).toEqual({
      status: 404,
      body: { error: 'Flow has no GET /panel route.' },
    });
    // A known path with a method it does not take is not served either.
    expect((await send(app, 'POST', '/fleet')).status).toBe(404);
  });
});

describe('POST /pause and /resume', () => {
  it('pauses one project until a time, then every project, then resumes one', async () => {
    configure(world.main);
    const other = otherProject();
    const { app } = setup({}, REAL_CLOCK);
    await model(app);
    await model(app, other);

    const first = inMinutes(60);
    const one = await send(app, 'POST', '/pause', { body: { project: 'main', until: first } });
    expect(one.status).toBe(200);
    const paused = one.body as FlowModel;
    expect(paused.projects.map((p) => [p.name, p.pause?.until ?? null])).toEqual([
      ['main', first],
      ['other', null],
    ]);
    expect(paused.projects[1].pause).toBeNull();

    // Pause all applies one new end everywhere, the paused project included.
    const second = inMinutes(120);
    const all = await send(app, 'POST', '/pause', { body: { all: true, until: second } });
    expect((all.body as FlowModel).projects.map((p) => p.pause?.until)).toEqual([second, second]);

    const resumed = await send(app, 'POST', '/resume', { body: { project: 'other' } });
    expect((resumed.body as FlowModel).projects.map((p) => p.pause !== null)).toEqual([
      true,
      false,
    ]);
    expect(flag(other)).toBeNull();
  }, 30_000);

  it('pauses every project with no end for a client from before (empty body)', async () => {
    configure(world.main);
    const { app } = setup();
    await model(app);
    const sent = await send(app, 'POST', '/pause');
    expect(sent.status).toBe(200);
    expect((sent.body as FlowModel).projects[0].pause).toMatchObject({ until: null });
    expect(flag(world.main)).toMatchObject({ until: null });
  }, 30_000);

  it('refuses an end in the past or more than 30 days away, and an unknown project', async () => {
    configure(world.main);
    const { app } = setup();
    await model(app);
    for (const until of ['2026-09-28T11:00:00Z', '2026-11-28T11:00:00Z']) {
      expect(await send(app, 'POST', '/pause', { body: { all: true, until } })).toEqual({
        status: 400,
        body: { error: PAUSE_RANGE_MESSAGE, refusedBy: 'flow' },
      });
    }
    expect(await send(app, 'POST', '/pause', { body: { project: 'nope', until: null } })).toEqual({
      status: 404,
      body: { error: 'No flow project is called nope on this computer.', refusedBy: 'flow' },
    });
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
    const { app } = setup({}, REAL_CLOCK);
    await model(app);
    const until = inMinutes(60);
    const timed = await send(app, 'POST', '/pause', { body: { project: 'main', until } });
    expect(timed.status).toBe(200);
    expect(flag(world.main)).toMatchObject({ until, hostSchedules: ['sched-1'] });
    const resumed = (await send(app, 'POST', '/resume', { body: { project: 'main' } }))
      .body as FlowModel;
    expect(resumed.projects[0].restoreSchedules).toEqual(['sched-1']);
    const done = (
      await send(app, 'POST', '/schedules/restored', {
        body: { project: 'main', ids: ['sched-1'] },
      })
    ).body as FlowModel;
    expect(done.projects[0].restoreSchedules).toEqual([]);
  }, 30_000);

  it('answers 502 in plain words when flow could not pause', async () => {
    configure(world.main);
    const { app } = setup(
      {},
      {
        execFile: ((_file, _args, _opts, callback) => {
          callback(Object.assign(new Error('boom'), { code: 1 }), '', '');
        }) satisfies ExecFileLike,
      }
    );
    await model(app);
    expect(await send(app, 'POST', '/pause', { body: { project: 'main', until: null } })).toEqual({
      status: 502,
      body: { error: "Flow couldn't pause main. Try again.", refusedBy: 'flow' },
    });
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
    const { app, host } = setup({}, { execFile: counting });
    await model(app);
    const poll = host.scheduled[0];
    await poll();
    expect(flag(world.main)).toBeNull();
    await poll();
    expect(calls).toEqual(['resume']);
    const body = await model(app);
    expect(body.projects[0].pause).toBeNull();
    expect(body.projects[0].restoreSchedules).toEqual(['sched-2']);
  }, 30_000);

  it('leaves a pause with no end, or an end still to come', async () => {
    configure(world.main);
    mkdirSync(path.dirname(pauseFlagPath(world.main)), { recursive: true });
    writeFileSync(pauseFlagPath(world.main), JSON.stringify({ until: '2026-09-28T13:00:00Z' }));
    const { app, host } = setup();
    await model(app);
    await host.scheduled[0]();
    expect(flag(world.main)).not.toBeNull();
  });
});

describe('the model event', () => {
  it('is sent when the model changed, at most once a second, and polls the run stores', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    configure(world.main);
    const { host, app } = setup();
    await model(app);
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
