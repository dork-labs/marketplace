/**
 * `flow next` (spec `flow-cli-core` §6, task 3.2): the dispatch pick with no
 * hand-built input. The parity cases are the contract: for the same backlog,
 * `flow next --json` must pick exactly what `dispatch.ts` picks when an agent
 * hand-builds its input (ownership per item, WIP counts) the way the old prose
 * told it to.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { findConfigRoots } from '../../scripts/config-files.ts';
import { loadConfig } from '../../scripts/config-load.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import type { OwnershipClass } from '../../scripts/work-item.ts';
import type { FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DISPATCH_SCRIPT = path.resolve(here, '..', '..', 'scripts', 'dispatch.ts');

const AGENT = 'flow-bot';
const HUMAN = 'dorian';

let temp: TempProject | undefined;

afterEach(() => temp?.cleanup());

const widgets = { id: 'proj-1', name: 'Widgets', stateCategory: 'started' as const };
const gadgets = { id: 'proj-2', name: 'Gadgets', stateCategory: 'started' as const };
const shelved = { id: 'proj-3', name: 'Shelved', stateCategory: 'canceled' as const };

/** A started item an agent is working on: counts toward the WIP load. */
function inFlight(identifier: string, project = widgets): WorkItem {
  return readyItem(identifier, {
    stateCategory: 'started',
    labels: ['type/task', 'agent/claimed'],
    agentDisposition: 'claimed',
    project,
  });
}

/**
 * One parity fixture: the backlog, plus the dispatch input an agent would have
 * built by hand from it (ownership per item and the WIP counts), written out
 * literally so the test does not reuse the code under test to build it.
 */
interface ParityCase {
  name: string;
  items: WorkItem[];
  ownershipOf: Record<string, OwnershipClass>;
  inProgressByProject: Record<string, number>;
  inProgressTotal: number;
}

const PARITY: ParityCase[] = [
  {
    name: 'a mixed queue: priorities, sizes, owners, a blocker and a dead project',
    items: [
      readyItem('P-1', { priority: 3, size: 5, project: widgets }),
      readyItem('P-2', { priority: 1, size: 8, project: gadgets }),
      readyItem('P-3', { priority: 2, size: 1, assignee: AGENT, project: widgets }),
      readyItem('P-4', { priority: 1, assignee: HUMAN, project: gadgets }),
      readyItem('P-5', { priority: 2, assignee: 'someone-else', project: widgets }),
      readyItem('P-6', {
        priority: 1,
        project: gadgets,
        relations: { blocks: [], blockedBy: ['P-7'], children: [], relatedTo: [] },
      }),
      readyItem('P-7', { stateCategory: 'backlog', labels: ['type/task'], project: gadgets }),
      readyItem('P-8', { priority: 1, project: shelved }),
      readyItem('P-9', {
        priority: 4,
        size: 2,
        project: gadgets,
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ],
    ownershipOf: {
      'P-1': 'unassigned',
      'P-2': 'unassigned',
      'P-3': 'mine',
      'P-4': 'reviewer',
      'P-5': 'other',
      'P-6': 'unassigned',
      'P-7': 'unassigned',
      'P-8': 'unassigned',
      'P-9': 'unassigned',
    },
    inProgressByProject: {},
    inProgressTotal: 0,
  },
  {
    name: 'a WIP-capped queue: Widgets already has claimed work in flight',
    items: [
      inFlight('W-1', widgets),
      readyItem('W-2', { priority: 1, project: widgets }),
      readyItem('W-3', { priority: 2, project: gadgets }),
      readyItem('W-4', { priority: 3, project: gadgets }),
      // Started but not claimed: not part of the WIP load.
      readyItem('W-5', { stateCategory: 'started', labels: ['type/task'], project: gadgets }),
    ],
    ownershipOf: {
      'W-1': 'unassigned',
      'W-2': 'unassigned',
      'W-3': 'unassigned',
      'W-4': 'unassigned',
      'W-5': 'unassigned',
    },
    inProgressByProject: { 'proj-1': 1 },
    inProgressTotal: 1,
  },
  {
    name: 'a starved queue: nothing ready, shapeable work waiting',
    items: [
      readyItem('S-1', { stateCategory: 'backlog', labels: ['type/idea'] }),
      readyItem('S-2', { stateCategory: 'unstarted', labels: ['type/task'] }),
      inFlight('S-3', gadgets),
    ],
    ownershipOf: { 'S-1': 'unassigned', 'S-2': 'unassigned', 'S-3': 'unassigned' },
    inProgressByProject: { 'proj-2': 1 },
    inProgressTotal: 1,
  },
];

/** Run the real dispatch.ts on a hand-built input, as the old prose did. */
function dispatchByHand(input: unknown): {
  picked: WorkItem[];
  eligibleCount: number;
  starved: boolean;
  shapeableCount: number;
} {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', DISPATCH_SCRIPT], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`dispatch.ts failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function config(extra: Record<string, unknown> = {}) {
  return { tracker: 'fake', identity: { agent: AGENT, reviewer: HUMAN }, ...extra };
}

describe('flow next: parity with dispatch.ts', () => {
  for (const parity of PARITY) {
    it(`picks what dispatch.ts picks for ${parity.name}`, async () => {
      // Purpose: `flow next` replaces the hand-built dispatch input; if its
      // ownership or WIP counts differ from what the prose built, it would
      // quietly pick different work.
      temp = tempProject(config());
      const resolved = loadConfig(findConfigRoots(temp.project, temp.plugin), {}).config;
      const expected = dispatchByHand({
        items: parity.items,
        config: {
          dispatch: resolved.dispatch,
          ownership: resolved.ownership,
          wipCap: resolved.autonomy.wipCap,
        },
        opts: {
          ownershipOf: parity.ownershipOf,
          inProgressByProject: parity.inProgressByProject,
          inProgressTotal: parity.inProgressTotal,
        },
      });

      const result = await runFlow(['next', '--json', '-n', '100'], temp, { items: parity.items });
      expect(result.code).toBe(EXIT.ok);
      const next = JSON.parse(result.stdout);
      expect(next.picked.map((item: WorkItem) => item.identifier)).toEqual(
        expected.picked.map((item) => item.identifier)
      );
      expect(next).toMatchObject({
        eligibleCount: expected.eligibleCount,
        starved: expected.starved,
        shapeableCount: expected.shapeableCount,
        wip: { total: parity.inProgressTotal, byProject: parity.inProgressByProject },
      });
    });
  }

  it('the parity fixtures are not trivial', () => {
    // Purpose: parity over empty picks would prove nothing; each fixture must
    // exercise a different outcome (several picks, a WIP cut, starvation).
    const outcomes = PARITY.map((parity) =>
      dispatchByHand({
        items: parity.items,
        config: {
          dispatch: loadDefaults().dispatch,
          ownership: loadDefaults().ownership,
          wipCap: loadDefaults().autonomy.wipCap,
        },
        opts: {
          ownershipOf: parity.ownershipOf,
          inProgressByProject: parity.inProgressByProject,
          inProgressTotal: parity.inProgressTotal,
        },
      })
    );
    expect(outcomes[0].eligibleCount).toBeGreaterThan(1);
    expect(outcomes[1].picked.map((item) => item.identifier)).not.toContain('W-2');
    expect(outcomes[2]).toMatchObject({ eligibleCount: 0, starved: true });
  });
});

function loadDefaults() {
  const project = tempProject(config());
  try {
    return loadConfig(findConfigRoots(project.project, project.plugin), {}).config;
  } finally {
    project.cleanup();
  }
}

describe('flow next', () => {
  function backlog(): FakeBacklog {
    return { user: { id: AGENT }, items: PARITY[0].items };
  }

  it('shows one pick by default and N with -n', async () => {
    // Purpose: -n bounds how many picks come back; the default is the one
    // item a drain tick claims.
    temp = tempProject(config());
    const one = JSON.parse((await runFlow(['next', '--json'], temp, backlog())).stdout);
    expect(one.picked).toHaveLength(1);
    expect(one.eligibleCount).toBeGreaterThan(1);
    const two = JSON.parse((await runFlow(['next', '--json', '-n', '2'], temp, backlog())).stdout);
    expect(two.picked).toHaveLength(2);
    expect(two.picked[0].identifier).toBe(one.picked[0].identifier);
  });

  it('rejects an -n that is not a positive whole number', async () => {
    // Purpose: "-n 0" or "-n x" is a typo, never "no picks".
    temp = tempProject(config());
    expect((await runFlow(['next', '-n', '0'], temp, backlog())).code).toBe(EXIT.usage);
    expect((await runFlow(['next', '-n', 'x'], temp, backlog())).code).toBe(EXIT.usage);
  });

  it('narrows to one project with --for-project, by id or by name in any case', async () => {
    // Purpose: project-scoped dispatch (`/flow <project>`) needs only that
    // project's work, however the operator typed its name.
    temp = tempProject(config());
    for (const wanted of ['proj-2', 'gadgets', 'GADGETS']) {
      const result = await runFlow(
        ['next', '--json', '-n', '100', '--for-project', wanted],
        temp,
        backlog()
      );
      const picked = JSON.parse(result.stdout).picked as WorkItem[];
      expect(picked.length, wanted).toBeGreaterThan(0);
      expect(
        picked.every((item) => item.project?.id === 'proj-2'),
        wanted
      ).toBe(true);
    }
  });

  it('exits 5 when --for-project matches no project', async () => {
    // Purpose: a mistyped project must not read as "nothing to do".
    temp = tempProject(config());
    const result = await runFlow(['next', '--json', '--for-project', 'nope'], temp, backlog());
    expect(result.code).toBe(EXIT.precondition);
    expect(JSON.parse(result.stdout).error.message).toMatch(/"nope"/);
  });

  it('keeps the common --project flag meaning the checkout', async () => {
    // Purpose: the project filter has its own flag so --project <dir> still
    // picks the checkout whose config is read.
    temp = tempProject(config());
    const elsewhere = path.dirname(temp.project);
    const result = await runFlow(
      ['next', '--json', '--project', temp.project],
      { ...temp, project: elsewhere },
      backlog()
    );
    expect(result.code).toBe(EXIT.ok);
  });

  it('exits 7 while paused, and runs with --manual', async () => {
    // Purpose: a pause stops the loop, never the operator; the tracker is not
    // read before the pause is checked.
    temp = tempProject(config());
    writeFileSync(
      path.join(temp.project, '.agents', 'flow', 'paused.json'),
      JSON.stringify({ pausedAt: '2026-09-26T10:00:00.000Z' })
    );
    const paused = await runFlow(['next', '--json'], temp, backlog());
    expect(paused.code).toBe(EXIT.paused);
    expect(paused.adapterBuilds).toBe(0);
    expect(JSON.parse(paused.stdout).error.message).toMatch(/since 2026-09-26T10:00:00.000Z/);

    const manual = await runFlow(['next', '--json', '--manual'], temp, backlog());
    expect(manual.code).toBe(EXIT.ok);
  });

  it('resolves identity.agent "auto" to the current user for ownership', async () => {
    // Purpose: an item assigned to the agent is claimable as "mine"; with
    // "auto" that account must come from getCurrentUser, or the item would
    // read as someone else's and never be picked.
    temp = tempProject({ tracker: 'fake' });
    const items = [readyItem('A-1', { assignee: AGENT })];
    const mine = await runFlow(['next', '--json'], temp, { user: { id: AGENT }, items });
    expect(JSON.parse(mine.stdout).eligibleCount).toBe(1);
    const theirs = await runFlow(['next', '--json'], temp, { user: { id: 'x' }, items });
    expect(JSON.parse(theirs.stdout).eligibleCount).toBe(0);
  });

  it('reads a --snapshot file without calling the adapter', async () => {
    // Purpose: one pull serves a whole tick; --snapshot must not touch the tracker.
    temp = tempProject(config());
    const saved = path.join(temp.project, 'snap.json');
    writeFileSync(saved, (await runFlow(['snapshot', '--json'], temp, backlog())).stdout);
    const result = await runFlow(['next', '--json', '--snapshot', saved], temp, {
      items: [],
      failReads: 'the tracker must not be read',
    });
    expect(result.adapterBuilds).toBe(0);
    expect(JSON.parse(result.stdout).picked).toHaveLength(1);
  });

  it('prints picks as KEY - Title with priority and size, or why nothing is eligible', async () => {
    // Purpose: a person reads the human text; it must name the item the way
    // the tracker shows it, and say "starved" versus "drained" plainly.
    temp = tempProject(config());
    const picks = await runFlow(['next', '-n', '2'], temp, backlog());
    expect(picks.stdout).toMatch(/^Next \(2 of \d+ eligible\):/);
    expect(picks.stdout).toMatch(/P-\d - Title of P-\d\s+priority \d\s+(size \d|no size)/);

    const starved = await runFlow(['next'], temp, { user: { id: AGENT }, items: PARITY[2].items });
    expect(starved.code).toBe(EXIT.ok);
    expect(starved.stdout).toContain('3 item(s) wait behind the agent/ready gate');

    const drained = await runFlow(['next'], temp, { user: { id: AGENT }, items: [] });
    expect(drained.stdout).toContain('the queue is drained');
  });
});
