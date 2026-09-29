/**
 * The inbox and autonomy wiring of the server half (spec `flow-multiproject`
 * §7, §10, §11): flow registers its answer handler with core's inbox and
 * raises a review gate on the poll; `POST /decisions/:key` answers only on a
 * DorkOS without the inbox (410 elsewhere); `POST /projects/:name/allow-adapter`
 * lets flow run a project's own adapter; every changing route sits behind the
 * person guard and is missing without it; the dial's copy follows core's
 * per-project settings.
 *
 * Every command of flow's CLI is faked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autonomyCopyPath } from '../../../../scripts/autonomy.ts';
import type { ExecFileLike } from '../lib/advisor.ts';
import type {
  DecisionActionEvent,
  DecisionActionResult,
  DecisionInput,
  InboxApi,
  ProjectSettingsReader,
} from '../lib/host-types.ts';
import type { FlowModel } from '../lib/model.ts';
import {
  ANSWER_IN_INBOX,
  createFlowExtension,
  hostSupportsInbox,
  hostSupportsProjectSettings,
  hostSupportsStartWork,
} from '../server.ts';
import {
  NOT_A_PERSON,
  fakeCtx,
  fakeRouter,
  makeWorld,
  runRecord,
  writeRuns,
  type World,
} from './fixtures.ts';

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOW = new Date('2026-09-28T12:00:00.000Z');

let world: World;

beforeEach(() => {
  world = makeWorld();
  mkdirSync(path.join(world.main, '.agents', 'flow'), { recursive: true });
  writeFileSync(path.join(world.main, '.agents', 'flow', 'config.json'), '{}');
  writeRuns(world, {
    a: runRecord(world, {
      identifier: 'ACME-7',
      title: 'Faster sidebar',
      stage: 'review',
      drain: {
        v: 1,
        rev: 1,
        phase: 'pr-ready',
        verdict: 'clean',
        reviewRound: 1,
        reviewedSha: 'abc1234def',
        pushedSha: 'abc1234def',
        pr: { number: 12, armed: false },
      },
    }),
  });
});

afterEach(() => {
  world.cleanup();
});

/** flow's CLI, faked: tracker reads fail as unreachable, answers succeed. */
function fakeCli() {
  const calls: string[][] = [];
  const execFile: ExecFileLike = (_file, args, _opts, callback) => {
    const rest = args.slice(2);
    calls.push(rest);
    const read = rest[0] === 'snapshot' || rest[0] === 'next';
    queueMicrotask(() =>
      read
        ? callback(Object.assign(new Error('no tracker'), { code: 4 }), '', '')
        : callback(null, '{"ok":true}', '')
    );
    return undefined;
  };
  return { calls, execFile };
}

/** A fake inbox. */
function fakeInbox() {
  const raised: DecisionInput[] = [];
  let handler: ((event: DecisionActionEvent) => unknown) | null = null;
  const inbox: InboxApi = {
    raise: vi.fn(async (input) => {
      raised.push(input);
      return {
        ...input,
        id: 'core-1',
        detail: input.detail ?? null,
        project: null,
        projectLabel: input.projectLabel ?? null,
        since: null,
        link: input.link ?? null,
        raisedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
    }),
    resolve: vi.fn(async () => true),
    record: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    onAction: vi.fn((next) => {
      handler = next as never;
      return () => {};
    }),
  };
  return {
    inbox,
    raised,
    answer: (event: DecisionActionEvent) =>
      (handler as (event: DecisionActionEvent) => Promise<DecisionActionResult>)(event),
  };
}

/** Build the extension, with the seams given. */
function setup(
  extra: NonNullable<Parameters<typeof fakeCtx>[1]>['extra'] = {},
  opts: { personGuard?: boolean } = {}
) {
  const router = fakeRouter();
  const cli = fakeCli();
  const host = fakeCtx(world, { extensionDir: EXTENSION_DIR, extra, ...opts });
  const ext = createFlowExtension(router, host.ctx, {
    now: () => NOW,
    originOf: () => null,
    log: () => {},
    execFile: cli.execFile,
    pidAlive: () => true,
  });
  // A Flow tab beside a chat in the project tells flow where to look.
  const seen = router.call('get', '/model', { query: { cwd: world.worktree } });
  /** Run the model's 5-second poll once. */
  const poll = async () => {
    await seen;
    await host.scheduled[0]();
  };
  return { router, host, ext, cli, poll, seen };
}

describe('the host probes', () => {
  it('find each seam only when all of it is there', () => {
    const { ctx } = fakeCtx(world);
    expect(hostSupportsInbox(ctx)).toBe(false);
    expect(hostSupportsProjectSettings(ctx)).toBe(false);
    expect(hostSupportsStartWork(ctx)).toBe(false);
    const inbox = fakeInbox().inbox;
    expect(hostSupportsInbox({ ...ctx, inbox })).toBe(true);
    expect(hostSupportsInbox({ ...ctx, inbox: { ...inbox, record: undefined } as never })).toBe(
      false
    );
    expect(
      hostSupportsStartWork({ ...ctx, sessions: { start: async () => ({ sessionId: 'x' }) } })
    ).toBe(true);
  });
});

describe('with the inbox', () => {
  it('registers the answer handler, raises the review gate on the poll, and shows it in the model', async () => {
    const inbox = fakeInbox();
    const { router, poll } = setup({ inbox: inbox.inbox });
    await vi.waitFor(() => expect(inbox.inbox.onAction).toHaveBeenCalled());
    await poll();
    expect(inbox.raised.map((r) => r.title)).toEqual(['Ship Faster sidebar?']);
    expect(inbox.raised[0].link).toBe('/x/flow/p/main');
    const sent = await router.call('get', '/model');
    expect((sent.body as FlowModel).decisions).toEqual([
      expect.objectContaining({ kind: 'review', project: 'main', identifier: 'ACME-7' }),
    ]);
  });

  it('runs flow review with the commit the ask showed when a person ships from the inbox', async () => {
    const inbox = fakeInbox();
    const { cli, poll } = setup({ inbox: inbox.inbox });
    await vi.waitFor(() => expect(inbox.inbox.onAction).toHaveBeenCalled());
    await poll();
    const result = await inbox.answer({
      key: inbox.raised[0].key,
      action: 'approve',
      choiceId: null,
      decidedBy: 'person',
      offerId: null,
      pendingActionId: 'p1',
      note: null,
      text: null,
      project: null,
    });
    expect(result).toMatchObject({ resolve: 'approved' });
    const review = cli.calls.find((args) => args[0] === 'review');
    expect(review).toEqual([
      'review',
      'ACME-7',
      '--approve',
      '--by',
      'person',
      '--head',
      'abc1234def',
      '--json',
      '--project',
      world.main,
    ]);
  });

  it('answers 410 on flow’s own answer route: the inbox is the path', async () => {
    const { router, seen } = setup({ inbox: fakeInbox().inbox });
    await seen;
    const sent = await router.call('post', '/decisions/:key', {
      params: { key: 'review:x:ACME-7' },
      body: { action: 'approve' },
    });
    expect(sent).toEqual({ status: 410, body: { error: ANSWER_IN_INBOX, refusedBy: 'flow' } });
  });
});

describe('without the inbox', () => {
  it('raises nothing, and answers from flow’s pages through its own person-only route', async () => {
    const { router, cli, poll } = setup();
    await poll();
    const model = (await router.call('get', '/model')).body as FlowModel;
    const [decision] = model.decisions;
    expect(decision.kind).toBe('review');
    const refused = await router.call('post', '/decisions/:key', {
      params: { key: decision.key },
      body: { action: 'approve' },
      agent: true,
    });
    expect(refused).toEqual({ status: 403, body: { error: NOT_A_PERSON } });
    expect(cli.calls.some((args) => args[0] === 'review')).toBe(false);
    const sent = await router.call('post', '/decisions/:key', {
      params: { key: decision.key },
      body: { action: 'approve' },
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ resolved: true, message: null, watch: null });
    expect(cli.calls.find((args) => args[0] === 'review')).toContain('--approve');
    const bad = await router.call('post', '/decisions/:key', {
      params: { key: decision.key },
      body: { action: 'maybe' },
    });
    expect(bad.status).toBe(400);
  });
});

describe("a project's own adapter", () => {
  it('is allowed only by a person, and then read on the timer', async () => {
    const own = path.join(world.main, '.agents', 'flow', 'adapters', 'linear');
    mkdirSync(own, { recursive: true });
    writeFileSync(path.join(own, 'SKILL.md'), '# own');
    writeFileSync(path.join(own, 'adapter.ts'), 'export {};\n');
    const { router, cli, seen } = setup();
    await seen;
    const before = (await router.call('get', '/model')).body as FlowModel;
    expect(before.projects[0].upNext).toBe('own-code');
    expect(cli.calls.filter((args) => args[0] === 'snapshot')).toEqual([]);
    const refused = await router.call('post', '/projects/:name/allow-adapter', {
      params: { name: 'main' },
      agent: true,
    });
    expect(refused.status).toBe(403);
    const sent = await router.call('post', '/projects/:name/allow-adapter', {
      params: { name: 'main' },
    });
    expect(sent.status).toBe(200);
    expect((sent.body as FlowModel).projects[0].upNext).toBe('read');
    await vi.waitFor(() =>
      expect(cli.calls.filter((args) => args[0] === 'snapshot').length).toBeGreaterThan(0)
    );
  });

  it('refuses a project that has no adapter of its own', async () => {
    const { router, seen } = setup();
    await seen;
    const sent = await router.call('post', '/projects/:name/allow-adapter', {
      params: { name: 'main' },
    });
    expect(sent).toEqual({
      status: 400,
      body: { error: "main doesn't use an adapter of its own.", refusedBy: 'flow' },
    });
  });
});

describe('the person guard and older hosts', () => {
  it('registers neither changing route on a DorkOS that cannot tell a person from an agent', () => {
    const { router } = setup({}, { personGuard: false });
    expect(router.has('post', '/decisions/:key')).toBe(false);
    expect(router.has('post', '/projects/:name/allow-adapter')).toBe(false);
  });

  it('answers 501 host-too-old for the new routes on a DorkOS before 0.88.0', async () => {
    const router = fakeRouter();
    createFlowExtension(router, fakeCtx(world, { dorkHome: false }).ctx);
    for (const route of ['/decisions/:key', '/projects/:name/allow-adapter']) {
      expect(await router.call('post', route)).toEqual({
        status: 501,
        body: { reason: 'host-too-old' },
      });
    }
  });
});

describe('the dial', () => {
  it("writes the engine's copy from core's settings, and again when a person changes them", async () => {
    const listeners: ((root: string) => void)[] = [];
    const values: Record<string, unknown> = {
      [world.main]: { dial: 'ask', kinds: { ship: 'tell' } },
    };
    const settings: ProjectSettingsReader = {
      get: vi.fn(async (root: string) => (values[root] ?? null) as never),
      onChange: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    };
    const { poll, router } = setup({ projectSettings: settings });
    await poll();
    const file = autonomyCopyPath(world.dorkHome, world.main);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      dial: 'ask',
      kinds: { ship: 'tell' },
    });
    const model = (await router.call('get', '/model')).body as FlowModel;
    expect(model.projects[0].autonomy).toMatchObject({
      chosen: true,
      stops: { ship: 'tell', sort: 'ask' },
    });
    // At Tell me after the gate is the reviewer agent's: nothing is asked.
    expect(model.decisions).toEqual([]);
    values[world.main] = { dial: 'auto' };
    for (const listener of listeners) listener(world.main);
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ dial: 'auto' })
    );
    expect(existsSync(file)).toBe(true);
  });
});
