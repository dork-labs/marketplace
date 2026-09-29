/**
 * The Flow tab's model (spec `flow-multiproject` §2.1): the state pill table
 * with its new words, a run's last update, the pause flag with its end, the
 * slots math, run rows kept per project, conditions from a tracker read, and
 * the pause command's arguments.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pidExists } from '../../../../scripts/cli/host-io.ts';
import type { RuntimeAccount } from '../../../../scripts/fleet/accounts.ts';
import type { ExecFileLike } from '../lib/advisor.ts';
import {
  CheckoutResolver,
  DONE_SHOWN_MS,
  UNREACHABLE_SHOWN_AFTER_MS,
  buildProject,
  conditionsOf,
  discoverCheckouts,
  isLiveDrainRun,
  isStaleRun,
  lastUpdateOf,
  pauseFlagPath,
  projectRuns,
  readPauseFlag,
  runAccountKey,
  runPauseCommand,
  runState,
  schedulesOf,
  slotsOf,
  upNextOf,
  type RunPill,
} from '../lib/model.ts';
import type { FlowProjectEntry } from '../lib/projects.ts';
import type { TrackerRead } from '../lib/tracker-reads.ts';
import { git, makeWorld, runRecord, type World } from './fixtures.ts';

const NOW = new Date('2026-09-28T12:00:00.000Z');

let world: World;

beforeEach(() => {
  world = makeWorld();
});

afterEach(() => {
  world.cleanup();
});

/** A project entry over the fixture's main checkout. */
function entry(overrides: Partial<FlowProjectEntry> = {}): FlowProjectEntry {
  return {
    root: world.main,
    name: 'main',
    setup: 'ready',
    tracker: { id: 'linear', label: 'Linear', team: 'DOR', transport: 'cli', adapter: 'shipped' },
    version: { flow: '0.49.0', behaviour: 1, olderBehaviour: null },
    ...overrides,
  };
}

/** A tracker read. */
function read(overrides: Partial<TrackerRead> = {}): TrackerRead {
  return {
    at: NOW.toISOString(),
    queue: { next: [{ identifier: 'DOR-9', title: 'Faster sidebar' }], more: 4 },
    teamUrl: 'https://linear.app/acme/team/DOR',
    facts: { eligibleCount: 5, shapeableCount: 0, starved: false, atWipCap: false },
    failure: null,
    ...overrides,
  };
}

describe('runState', () => {
  const rows: [string, Record<string, unknown>, RunPill][] = [
    ['a handoff under way', { limit: { state: 'handing-off' } }, 'handing-off'],
    ['winding down before a move', { limit: { state: 'winding-down' } }, 'handing-off'],
    ['ask mode waiting for the operator', { limit: { state: 'pending-approval' } }, 'needs-you'],
    [
      "a person's hold that will not resume itself",
      { limit: { state: 'waiting-reset', heldBy: 'person', resumeOnReset: false } },
      'needs-you',
    ],
    ['parked for a person', { drain: { phase: 'parked', parkedFor: 'person' } }, 'needs-you'],
    ['parked for another reason', { drain: { phase: 'parked', parkedFor: 'other' } }, 'parked'],
    ['waiting for the reset', { limit: { state: 'waiting-reset' } }, 'parked'],
    ['awaiting a handoff', { limit: { state: 'awaiting-handoff' } }, 'parked'],
    [
      'a hold that resumes at the reset',
      { limit: { heldBy: 'person', resumeOnReset: true } },
      'parked',
    ],
    ['reviewing', { drain: { phase: 'reviewing' } }, 'in-review'],
    ['PR ready', { drain: { phase: 'pr-ready' } }, 'in-review'],
    ['watching the PR', { drain: { phase: 'watching' } }, 'in-review'],
    // DOR-2533 live check: VERIFY's own gate (no drain) read as Building.
    [
      'at the review gate VERIFY left',
      { stage: 'review', status: 'waiting_for_review' },
      'in-review',
    ],
    [
      'a drain run working, whatever its stage',
      { stage: 'review', drain: { phase: 'fixing' } },
      'building',
    ],
    ['working', { drain: { phase: 'working' } }, 'building'],
    ['fixing CI', { drain: { phase: 'fixing-ci' } }, 'building'],
    ['queued', { status: 'queued' }, 'building'],
    ['finished', { status: 'complete', drain: { phase: 'parked' } }, 'done'],
    ['not a record', {}, 'building'],
  ];
  it.each(rows)('%s', (_name, run, pill) => {
    expect(runState(run)).toBe(pill);
  });
});

describe('lastUpdateOf', () => {
  it('takes the newest readable timestamp on the record (§6.2)', () => {
    expect(
      lastUpdateOf({
        startedAt: '2026-09-28T08:00:00.000Z',
        heartbeatAt: '2026-09-28T09:00:00.000Z',
        updatedAt: 'not a time',
        drain: { parkedAt: '2026-09-28T10:00:00.000Z' },
        limit: { since: '2026-09-28T09:30:00.000Z' },
      })
    ).toBe('2026-09-28T10:00:00.000Z');
    expect(lastUpdateOf({})).toBeNull();
  });
});

describe('readPauseFlag', () => {
  // Purpose: the tab reads a timed pause the way flow's engine does, so a
  // pause whose end has passed stops showing as paused (§5.1), while a flag
  // with no end, or one nobody can read, still pauses.
  it('reads a timed pause as over at its end, and anything unclear as paused', () => {
    const dir = path.join(world.root, 'flags');
    mkdirSync(dir, { recursive: true });
    const flag = (name: string, body: string) => {
      const file = path.join(dir, name);
      writeFileSync(file, body);
      return file;
    };
    expect(readPauseFlag(path.join(dir, 'none.json'), NOW)).toBeNull();
    expect(readPauseFlag(flag('open.json', '{"pausedAt":"x"}'), NOW)).toEqual({
      since: 'x',
      until: null,
      pauses: true,
    });
    expect(readPauseFlag(flag('junk.json', 'not json'), NOW)?.pauses).toBe(true);
    expect(readPauseFlag(flag('later.json', '{"until":"2026-09-28T13:00:00Z"}'), NOW)).toEqual({
      since: null,
      until: '2026-09-28T13:00:00Z',
      pauses: true,
    });
    expect(readPauseFlag(flag('ended.json', '{"until":"2026-09-28T12:00:00Z"}'), NOW)?.pauses).toBe(
      false
    );
    expect(readPauseFlag(flag('odd.json', '{"until":"whenever"}'), NOW)).toMatchObject({
      until: null,
      pauses: true,
    });
  });
});

describe('slots', () => {
  it('counts the sequential default as one slot, and only unparked live drain runs', () => {
    expect(slotsOf(0)).toBe(1);
    expect(slotsOf(3)).toBe(3);
    const drain = (phase: string) => ({ v: 1, rev: 1, phase });
    expect(isLiveDrainRun({ status: 'running', drain: drain('working') })).toBe(true);
    expect(isLiveDrainRun({ status: 'queued', drain: drain('working') })).toBe(true);
    expect(isLiveDrainRun({ status: 'running', drain: drain('parked') })).toBe(false);
    expect(isLiveDrainRun({ status: 'running' })).toBe(false);
  });
});

describe('isStaleRun and runAccountKey', () => {
  it('reads a DorkOS run (workerPid -1) as live, as flow fleet does', () => {
    expect(isStaleRun({ status: 'running', workerPid: -1 }, pidExists)).toBe(false);
    expect(isStaleRun({ status: 'running', workerPid: 2 ** 22 + 7 }, pidExists)).toBe(true);
  });

  it('names a run on default by the registered account default points at', () => {
    const registry = [
      { runtime: 'claude-code', id: 'work', implicit: false, isDefault: true },
    ] as unknown as RuntimeAccount[];
    expect(runAccountKey(registry, undefined, null)).toBe('claude-code:work');
    expect(runAccountKey(registry, 'claude-code', 'personal')).toBe('claude-code:personal');
    expect(runAccountKey([], 'claude-code', null)).toBe('claude-code:default');
  });
});

describe('discoverCheckouts', () => {
  it("finds the projects behind the drain's worktrees and the chats' folders, once each", async () => {
    const repoDir = path.join(world.dorkHome, 'workspaces', 'app');
    mkdirSync(repoDir, { recursive: true });
    git(world.main, 'worktree', 'add', '-q', '-b', 'dork/acme-2', path.join(repoDir, 'ACME-2'));
    const resolve = vi.fn(async (cwd: string) =>
      cwd.startsWith(world.root) && !cwd.endsWith('elsewhere') ? world.main : null
    );
    const resolver = new CheckoutResolver(resolve);
    const found = await discoverCheckouts(
      world.dorkHome,
      [world.worktree, path.join(world.root, 'elsewhere')],
      resolver
    );
    expect(found).toEqual([world.main]);
    await discoverCheckouts(world.dorkHome, [world.worktree], resolver);
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});

describe('CheckoutResolver', () => {
  it('asks git without blocking, and finds the main checkout of a worktree', async () => {
    const resolver = new CheckoutResolver();
    expect(await resolver.of(world.worktree)).toBe(world.main);
    expect(await resolver.of(world.root)).toBeNull();
  });

  it('remembers only the most recent answers', async () => {
    const resolve = vi.fn(async (cwd: string) => `${cwd}-main`);
    const resolver = new CheckoutResolver(resolve, 2);
    await resolver.of('/a');
    await resolver.of('/b');
    await resolver.of('/a');
    await resolver.of('/c');
    expect(resolver.size).toBe(2);
    // /b was the least recently used, so it is asked again; /a is not.
    await resolver.of('/a');
    await resolver.of('/b');
    expect(resolve.mock.calls.map(([cwd]) => cwd)).toEqual(['/a', '/b', '/c', '/b']);
  });
});

describe('projectRuns', () => {
  const look = new Map([['claude-code:work', { label: 'Work', color: '#2563eb' }]]);

  it('shows active runs, then runs finished in the last day, with the account’s dot', () => {
    const store = {
      a: runRecord(world, { title: 'Out-of-usage banner', dispatchedBy: 'chat-1' }),
      b: runRecord(world, {
        issueId: 'b',
        identifier: 'ACME-2',
        status: 'complete',
        completedAt: new Date(NOW.getTime() - DONE_SHOWN_MS + 60_000).toISOString(),
      }),
      c: runRecord(world, {
        issueId: 'c',
        identifier: 'ACME-3',
        status: 'complete',
        completedAt: new Date(NOW.getTime() - DONE_SHOWN_MS - 60_000).toISOString(),
      }),
      d: runRecord(world, { issueId: 'd', identifier: 'ACME-4', status: 'failed' }),
      e: runRecord(world, { issueId: 'e', identifier: 'ACME-5', account: 'gone' }),
    };
    const rows = projectRuns({
      root: world.main,
      store,
      accounts: look,
      registry: [],
      pidAlive: () => true,
      now: NOW,
    });
    expect(rows.map((row) => [row.identifier, row.state, row.account.label])).toEqual([
      ['ACME-1', 'building', 'Work'],
      ['ACME-5', 'building', 'gone'],
      ['ACME-2', 'done', 'Work'],
    ]);
    expect(rows[0]).toMatchObject({
      title: 'Out-of-usage banner',
      sessionId: 's-old',
      dispatchedBy: 'chat-1',
      cwd: world.worktree,
      account: { key: 'claude-code:work', color: '#2563eb' },
      updatedAt: '2026-09-27T00:00:00.000Z',
    });
  });

  it("keeps two projects' runs apart", () => {
    const other = path.join(world.root, 'other');
    const a = projectRuns({
      root: world.main,
      store: { a: runRecord(world) },
      accounts: look,
      registry: [],
      pidAlive: () => true,
      now: NOW,
    });
    const b = projectRuns({
      root: other,
      store: { b: runRecord(world, { identifier: 'OTH-1', worktreePath: '' }) },
      accounts: look,
      registry: [],
      pidAlive: () => true,
      now: NOW,
    });
    expect(a.map((row) => row.identifier)).toEqual(['ACME-1']);
    expect(b.map((row) => [row.identifier, row.cwd])).toEqual([['OTH-1', other]]);
  });
});

describe('conditionsOf', () => {
  it('says paused, and a slow tracker only after 15 minutes, never escalated', () => {
    const since = new Date(NOW.getTime() - UNREACHABLE_SHOWN_AFTER_MS + 1_000).toISOString();
    expect(conditionsOf(null, read({ failure: { kind: 'unreachable', since } }), NOW)).toEqual([]);
    const older = new Date(NOW.getTime() - UNREACHABLE_SHOWN_AFTER_MS).toISOString();
    expect(
      conditionsOf(
        { since: '2026-09-28T09:00:00.000Z', until: null },
        read({ failure: { kind: 'unreachable', since: older } }),
        NOW
      )
    ).toEqual([
      { kind: 'paused', since: '2026-09-28T09:00:00.000Z', escalated: false, detail: {} },
      { kind: 'tracker-unreachable', since: older, escalated: false, detail: {} },
    ]);
  });

  it('says a sign-in that is gone and a settings problem at once', () => {
    const since = NOW.toISOString();
    expect(conditionsOf(null, read({ failure: { kind: 'auth', since } }), NOW)[0].kind).toBe(
      'sign-in'
    );
    expect(conditionsOf(null, read({ failure: { kind: 'settings', since } }), NOW)[0].kind).toBe(
      'settings-problem'
    );
  });
});

describe('buildProject', () => {
  it('builds a project from its files and its last read', () => {
    mkdirSync(path.join(world.main, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(world.main, '.agents', 'flow', 'config.json'),
      JSON.stringify({ drain: { parallel: 3 } })
    );
    writeFileSync(
      pauseFlagPath(world.main),
      JSON.stringify({ pausedAt: '2026-09-28T11:00:00.000Z', until: '2026-09-29T09:00:00+02:00' })
    );
    mkdirSync(path.join(world.main, '.dork', 'flow'), { recursive: true });
    writeFileSync(
      path.join(world.main, '.dork', 'flow', 'flow-state.json'),
      JSON.stringify({ a: runRecord(world) })
    );
    const project = buildProject({
      entry: entry(),
      read: read(),
      accounts: new Map(),
      registry: [],
      pidAlive: () => true,
      now: NOW,
      restoreSchedules: ['sched-1'],
    });
    expect(project).toMatchObject({
      name: 'main',
      setup: 'ready',
      tracker: { label: 'Linear', team: 'DOR', url: 'https://linear.app/acme/team/DOR' },
      pause: { since: '2026-09-28T11:00:00.000Z', until: '2026-09-29T09:00:00+02:00' },
      queue: { next: [{ identifier: 'DOR-9', title: 'Faster sidebar' }], more: 4 },
      upNext: 'read',
      capacity: { busy: 1, slots: 3 },
      restoreSchedules: ['sched-1'],
    });
    expect(project.runs.map((run) => run.identifier)).toEqual(['ACME-1']);
    expect(project.conditions.map((condition) => condition.kind)).toEqual(['paused']);
  });

  it('says how Up next is reached for each kind of tracker', () => {
    const tracker = entry().tracker!;
    expect(upNextOf(entry())).toBe('read');
    expect(upNextOf(entry({ tracker: { ...tracker, transport: 'mcp' } }))).toBe('agent-only');
    expect(upNextOf(entry({ tracker: { ...tracker, adapter: 'project' } }))).toBe('own-code');
    expect(upNextOf(entry({ tracker: { ...tracker, adapter: 'other' } }))).toBe('own-code');
  });
});

describe('runPauseCommand', () => {
  it("passes the end and lets DorkOS restore schedules, with flow's own script", async () => {
    const calls: string[][] = [];
    const exec: ExecFileLike = (_file, args, _opts, callback) => {
      calls.push([...args]);
      callback(null, '{"ok":true,"hostSchedules":["s-1",""]}\n', '');
      return undefined;
    };
    await runPauseCommand({
      execFile: exec,
      flowRoot: '/flow',
      command: 'pause',
      mainCheckout: '/p',
      until: '2026-09-29T09:00:00+02:00',
    });
    const resumed = await runPauseCommand({
      execFile: exec,
      flowRoot: '/flow',
      command: 'resume',
      mainCheckout: '/p',
    });
    expect(calls).toEqual([
      [
        '--experimental-strip-types',
        path.join('/flow', 'scripts', 'config-files.ts'),
        'pause',
        '--project',
        '/p',
        '--until',
        '2026-09-29T09:00:00+02:00',
        '--host-restores',
      ],
      [
        '--experimental-strip-types',
        path.join('/flow', 'scripts', 'config-files.ts'),
        'resume',
        '--project',
        '/p',
      ],
    ]);
    expect(schedulesOf(resumed)).toEqual(['s-1']);
  });

  it('says in plain words, naming the project, when flow could not do it', async () => {
    const exec: ExecFileLike = (_file, _args, _opts, callback) => {
      callback(Object.assign(new Error('boom'), { code: 1 }), '', '');
      return undefined;
    };
    await expect(
      runPauseCommand({
        execFile: exec,
        flowRoot: '/flow',
        command: 'pause',
        mainCheckout: '/p',
        name: 'dorkos',
      })
    ).rejects.toThrow("Flow couldn't pause dorkos. Try again.");
  });
});
