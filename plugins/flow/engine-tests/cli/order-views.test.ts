/**
 * `flow order --write-order` and `--check-order` (DOR-5068): the work order
 * written into two saved views' manual order, against the fake tracker. The
 * planner itself is pinned by `engine-tests/view-order.test.ts`; these cases
 * pin the verb: which views it reads, that it writes only changed positions,
 * that a second run writes none, that the check names the first item out of
 * place and prints the view description, and what it says when it cannot run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WRITE_BATCH, WRITE_PAUSE_MS, writeInBatches } from '../../scripts/cli/order-views.ts';
import { FlowConfigSchema } from '../../scripts/config-schema.ts';
import { TrackerError } from '../../scripts/errors.ts';
import type { FakeBacklog } from '../../scripts/tracker/fake.ts';
import { ALL_CAPABILITIES, type PositionWrite } from '../../scripts/tracker/types.ts';
import { orderViewsDriftLine, readOrderViewsStatus } from '../../scripts/order-views-status.ts';
import { VIEW_DESCRIPTION } from '../../scripts/view-order.ts';
import type { ProjectInfo } from '../../scripts/work-item.ts';
import {
  readyItem,
  runFlow as runFlowIn,
  tempProject,
  type TempProject,
} from './read-verb-harness.ts';

let temp: TempProject | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const VIEWS = { issues: 'view-next', projects: 'view-projects' };

const run = (
  argv: readonly string[],
  backlog: FakeBacklog,
  config: Record<string, unknown> = { order: { views: VIEWS } }
) => {
  temp ??= tempProject(config);
  return runFlowIn(argv, temp, backlog);
};

const billing = { id: 'p-billing', name: 'Billing', stateCategory: 'started' as const };

const PROJECTS: ProjectInfo[] = [
  {
    id: 'p-billing',
    name: 'Billing',
    slugId: 'billing',
    statusType: 'started',
    priority: 1,
    labels: [],
    blockedBy: [],
  },
  {
    id: 'p-mobile',
    name: 'Mobile',
    slugId: 'mobile',
    statusType: 'planned',
    priority: 2,
    labels: [],
    blockedBy: [],
  },
  {
    id: 'p-web',
    name: 'Web',
    slugId: 'web',
    statusType: 'started',
    priority: 3,
    labels: [],
    blockedBy: [],
  },
];

/** Three ranked Musts (ABC-2 first: it unblocks ABC-4), one blocked, and the two views. */
function backlog(): FakeBacklog {
  return {
    team: { key: 'ABC', id: 'team-1' },
    items: [
      readyItem('ABC-1', { project: billing, size: 1 }),
      readyItem('ABC-2', {
        project: billing,
        size: 2,
        relations: { blocks: ['ABC-4'], blockedBy: [], children: [], relatedTo: [] },
      }),
      readyItem('ABC-3', { project: billing, size: 3 }),
      readyItem('ABC-4', {
        project: billing,
        relations: { blocks: [], blockedBy: ['ABC-2'], children: [], relatedTo: [] },
      }),
    ],
    projectInfo: PROJECTS,
    views: {
      // Dragged: ABC-3 on top. ABC-4 is blocked, so the order does not rank it.
      'view-next': { kind: 'issues', members: ['ABC-3', 'ABC-2', 'ABC-1', 'ABC-4'] },
      // Order: Billing, Web (Started), then Mobile (Planned).
      'view-projects': { kind: 'projects', members: ['p-billing', 'p-web', 'p-mobile'] },
    },
  };
}

describe('flow order --write-order', () => {
  it('writes only the positions that changed, says how many, and a second run writes none', async () => {
    const state = backlog();
    const first = await run(['order', '--write-order', '--json'], state);
    expect(first.code).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.wrote).toBe(1);
    expect(out.views.issues).toMatchObject({ viewId: 'view-next', wrote: 1, unranked: ['ABC-4'] });
    expect(out.views.projects).toMatchObject({ viewId: 'view-projects', wrote: 0 });
    // ABC-3 moved below ABC-1; ABC-4 (unranked) already sat after the ranked ones.
    expect(Object.keys(state.positions ?? {})).toEqual(['ABC-3']);

    const second = await run(['order', '--write-order'], state);
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/^Wrote 0 positions/);
    expect(Object.keys(state.positions ?? {})).toEqual(['ABC-3']);
  });

  it('moves an unranked member above the order to a block after it', async () => {
    const state = backlog();
    // ABC-4 is blocked, so unranked; it sits on top, as a new issue would.
    state.views!['view-next'].members = ['ABC-4', 'ABC-2', 'ABC-1', 'ABC-3'];
    const check = await run(['order', '--check-order', '--json'], state);
    expect(JSON.parse(check.stdout).views.issues.drift).toEqual({
      place: 1,
      expected: 'ABC-2',
      found: 'ABC-4',
    });
    const write = await run(['order', '--write-order', '--json'], state);
    expect(JSON.parse(write.stdout).views.issues.wrote).toBe(1);
    expect(Object.keys(state.positions ?? {})).toEqual(['ABC-4']);
    expect((await run(['order', '--check-order'], state)).code).toBe(0);
  });

  it('prints the count in words', async () => {
    const result = await run(['order', '--write-order'], backlog());
    expect(result.stdout).toContain(
      'Wrote 1 position: 1 in the issue view, 0 in the project view.'
    );
  });

  it('puts the project view in order: Started, then Planned', async () => {
    const state = backlog();
    state.views!['view-projects'].members = ['p-mobile', 'p-web', 'p-billing'];
    const result = await run(['order', '--write-order', '--json'], state);
    expect(JSON.parse(result.stdout).views.projects.wrote).toBe(2);
    const check = await run(['order', '--check-order', '--json'], state);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout).views.projects.drift).toBeNull();
  });

  it('refuses a saved snapshot: a write never comes from a stale pull', async () => {
    const result = await run(['order', '--write-order', '--snapshot', 'x.json'], backlog());
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--snapshot/);
  });

  it('exits 7 while flow is paused, unless --manual', async () => {
    temp = tempProject({ order: { views: VIEWS } });
    writeFileSync(
      path.join(temp.project, '.agents', 'flow', 'paused.json'),
      JSON.stringify({ pausedAt: '2026-09-26T00:00:00.000Z' })
    );
    const paused = await run(['order', '--write-order'], backlog());
    expect([paused.code, paused.stderr]).toEqual([7, expect.stringMatching(/paused/)]);
    expect((await run(['order', '--write-order', '--manual'], backlog())).code).toBe(0);
    // The check only reads, so it runs while paused.
    expect((await run(['order', '--check-order'], backlog())).code).toBe(1);
  });
});

describe('what limits a write', () => {
  it("never writes, or counts as drift, a project that is not this team's", async () => {
    const state = backlog();
    // Project positions are shared by the whole workspace, so another team's
    // project in the view (here on top) is left alone.
    state.views!['view-projects'].members = ['p-other', 'p-billing', 'p-web', 'p-mobile'];
    const check = await run(['order', '--check-order', '--json'], state);
    expect(JSON.parse(check.stdout).views.projects).toMatchObject({ drift: null, unranked: [] });
    expect((await run(['order', '--write-order'], state)).code).toBe(0);
    expect(state.positions?.['p-other']).toBeUndefined();
  });

  it('stops at order.maxWrites, says so, exits 1, and the next run carries on', async () => {
    const state = backlog();
    // One issue write and two project writes: three, over a cap of two.
    state.views!['view-projects'].members = ['p-mobile', 'p-web', 'p-billing'];
    const config = { order: { views: VIEWS, maxWrites: 2 } };
    const first = await run(['order', '--write-order'], state, config);
    expect(first.code).toBe(1);
    expect(first.stdout).toBe(
      'Wrote 2 of 3 positions, the most one run writes (order.maxWrites): 1 in the issue view, 1 in the project view. Run it again to write the rest; the hourly run does.\n'
    );
    expect(Object.keys(state.positions ?? {})).toHaveLength(2);
    const status = readOrderViewsStatus(temp!.project)!;
    expect(status).toMatchObject({ mode: 'write', inOrder: false, drift: null, wrote: 2 });
    expect(status.needed).toBe(3);
    expect(orderViewsDriftLine(status)).toBe(
      'The last write to the work order views stopped at its cap after 2 of 3 positions; the next run writes the rest.'
    );
    const second = await run(['order', '--write-order', '--json'], state, config);
    expect([second.code, JSON.parse(second.stdout).capped]).toEqual([0, false]);
    expect((await run(['order', '--check-order'], state, config)).code).toBe(0);
    expect(readOrderViewsStatus(temp!.project)?.needed).toBeNull();
  });

  it('defaults the cap to 300 and refuses one below 1', () => {
    expect(FlowConfigSchema.parse({}).order.maxWrites).toBe(300);
    expect(FlowConfigSchema.safeParse({ order: { maxWrites: 0 } }).success).toBe(false);
  });

  it('pauses between batches of writes, never before the first or after the last', async () => {
    const writes: PositionWrite[] = Array.from({ length: WRITE_BATCH * 2 + 1 }, (_, i) => ({
      kind: 'issues',
      id: `i${i}`,
      key: `ABC-${i + 1}`,
      position: i + 1,
    }));
    const events: string[] = [];
    await writeInBatches(
      async (batch) => {
        events.push(`write ${batch.length}`);
      },
      writes,
      async (ms) => {
        events.push(`pause ${ms}`);
      }
    );
    expect(events).toEqual([
      `write ${WRITE_BATCH}`,
      `pause ${WRITE_PAUSE_MS}`,
      `write ${WRITE_BATCH}`,
      `pause ${WRITE_PAUSE_MS}`,
      'write 1',
    ]);
  });

  it("paces a run's writes with the host's sleep", async () => {
    const count = WRITE_BATCH + 2;
    const keys = Array.from({ length: count }, (_, i) => `ABC-${i + 1}`);
    const state: FakeBacklog = {
      team: { key: 'ABC', id: 'team-1' },
      items: keys.map((key) => readyItem(key, { project: billing, size: 1 })),
      projectInfo: PROJECTS,
      views: {
        // Upside down: every issue but one moves.
        'view-next': { kind: 'issues', members: [...keys].reverse() },
        'view-projects': { kind: 'projects', members: ['p-billing', 'p-web', 'p-mobile'] },
      },
    };
    temp = tempProject({ order: { views: VIEWS } });
    const pauses: number[] = [];
    const result = await runFlowIn(['order', '--write-order', '--json'], temp, state, {
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).wrote).toBe(count - 1);
    expect(pauses).toEqual([WRITE_PAUSE_MS]);
  });
});

describe('flow order --check-order', () => {
  it('exits 1 on drift, names the first item out of place, and prints the view description', async () => {
    const result = await run(['order', '--check-order'], backlog());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'Issue view: out of order at place 1: the order has ABC-2 (Title of ABC-2), the view has ABC-3 (Title of ABC-3).'
    );
    expect(result.stdout).toContain('Project view: in order (3 ranked).');
    expect(result.stdout).toContain(VIEW_DESCRIPTION);
  });

  it('writes nothing, and passes once the order is written', async () => {
    const state = backlog();
    const json = await run(['order', '--check-order', '--json'], state);
    expect(JSON.parse(json.stdout).views.issues.drift).toEqual({
      place: 1,
      expected: 'ABC-2',
      found: 'ABC-3',
    });
    expect(state.positions).toBeUndefined();
    await run(['order', '--write-order'], state);
    const after = await run(['order', '--check-order'], state);
    expect(after.code).toBe(0);
    expect(after.stdout).not.toContain(VIEW_DESCRIPTION);
  });
});

describe('what the two flags need', () => {
  it('say what to set when the view ids are missing', async () => {
    for (const flag of ['--write-order', '--check-order']) {
      temp?.cleanup();
      temp = undefined;
      const result = await run(['order', flag], backlog(), { order: { views: { issues: 'v' } } });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('order.views.projects');
    }
  });

  it('refuse an adapter without the view capabilities', async () => {
    const state = backlog();
    state.capabilities = ALL_CAPABILITIES.filter((c) => c !== 'setPositions');
    const result = await run(['order', '--write-order'], state);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('setPositions');
    // The check needs only the read.
    expect((await run(['order', '--check-order'], state)).code).toBe(1);
  });

  it('take one at a time, and no other question', async () => {
    expect((await run(['order', '--write-order', '--check-order'], backlog())).code).toBe(2);
    expect((await run(['order', '--check-order', '--why', 'ABC-1'], backlog())).code).toBe(2);
  });

  it('say so when a view lists the other kind', async () => {
    const state = backlog();
    state.views!['view-next'].kind = 'projects';
    const result = await run(['order', '--check-order'], state);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('view-next');
  });
});

describe('the saved result (shown by flow status and the Flow page)', () => {
  it('a write saves its count; a check saves the first drift, with its view', async () => {
    const state = backlog();
    await run(['order', '--check-order'], state);
    expect(readOrderViewsStatus(temp!.project)).toEqual({
      v: 1,
      at: '2026-09-26T12:00:00.000Z',
      mode: 'check',
      inOrder: false,
      drift: { view: 'issues', place: 1, expected: 'ABC-2', found: 'ABC-3' },
      wrote: null,
      needed: null,
      driftSince: '2026-09-26T12:00:00.000Z',
    });
    await run(['order', '--write-order'], state);
    expect(readOrderViewsStatus(temp!.project)).toMatchObject({
      mode: 'write',
      inOrder: true,
      drift: null,
      wrote: 1,
    });
    // Written whole, through the atomic helper: no temp file or lock left behind.
    const file = path.join(temp!.project, '.dork', 'flow', 'order-views.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(1);
  });

  it('a write waits for another writing run and then stops, writing nothing', async () => {
    const state = backlog();
    temp = tempProject({ order: { views: VIEWS } });
    mkdirSync(path.join(temp.project, '.dork', 'flow'), { recursive: true });
    writeFileSync(path.join(temp.project, '.dork', 'flow', 'order-views.lock'), 'another:run');
    const result = await run(['order', '--write-order'], state);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('another flow order --write-order is writing the views');
    expect(state.positions).toBeUndefined();
  }, 15_000);

  it('a write that fails part way saves "the last write failed", with what it wrote', async () => {
    const state = backlog();
    // The issue view's one write lands; the tracker then fails the project
    // view's first write.
    state.views!['view-projects'].members = ['p-mobile', 'p-web', 'p-billing'];
    state.positions = new Proxy({} as Record<string, number>, {
      set(target, key, value) {
        if (String(key).startsWith('p-')) throw new TrackerError('Linear went away');
        target[String(key)] = value as number;
        return true;
      },
    });
    const result = await run(['order', '--write-order'], state);
    expect([result.code, result.stderr]).toEqual([4, expect.stringContaining('Linear went away')]);
    expect(readOrderViewsStatus(temp!.project)).toMatchObject({
      mode: 'write',
      inOrder: false,
      drift: null,
      wrote: 1,
      driftSince: '2026-09-26T12:00:00.000Z',
    });
  });

  it('keeps the time a drift began while the same first drift persists', async () => {
    const state = backlog();
    await run(['order', '--check-order'], state);
    const file = path.join(temp!.project, '.dork', 'flow', 'order-views.json');
    const first = JSON.parse(readFileSync(file, 'utf8'));
    expect(first.driftSince).toBe('2026-09-26T12:00:00.000Z');
    // Pretend the drift was first seen a day earlier: a second check keeps it.
    writeFileSync(file, JSON.stringify({ ...first, driftSince: '2026-09-25T12:00:00.000Z' }));
    await run(['order', '--check-order'], state);
    expect(readOrderViewsStatus(temp!.project)?.driftSince).toBe('2026-09-25T12:00:00.000Z');
    // Another first drift starts its own clock; in order clears it.
    state.views!['view-next'].members = ['ABC-1', 'ABC-2', 'ABC-3', 'ABC-4'];
    await run(['order', '--check-order'], state);
    expect(readOrderViewsStatus(temp!.project)?.driftSince).toBe('2026-09-26T12:00:00.000Z');
    await run(['order', '--write-order'], state);
    expect(readOrderViewsStatus(temp!.project)?.driftSince).toBeNull();
  });
});
