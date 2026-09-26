/**
 * One behavioral contract suite for code adapters (adapter contract 1.4.0),
 * run against the fake tracker AND the real Linear adapter over a stateful,
 * Linear-shaped simulator built from recorded answers.
 *
 * The point is fidelity: the fake tracker is what flow's self-test scenarios
 * and live evals run against, so wherever flow depends on a tracker's behavior
 * the fake must behave as the Linear adapter does. Hand-built fixtures hid a
 * data-loss bug once (a state-only write that stripped labels); a case here
 * that passes on one and fails on the other is exactly the drift this file
 * exists to catch.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FlowConfigSchema } from '../scripts/config-schema.ts';
import { PreconditionError, TrackerError } from '../scripts/errors.ts';
import { FakeTracker } from '../scripts/tracker/fake.ts';
import type { CodeAdapter, WorkItem } from '../scripts/tracker/types.ts';
import { verifyWrite } from '../scripts/tracker/verify-write.ts';
import { validate } from '../scripts/validate-adapter.ts';
import * as linear from '../skills/linear-adapter/adapter.ts';
import { seedStateId, simulateLinear, TEAM } from './fixtures/linear-adapter/simulator.ts';

/** One seeded item: a number (the harness picks the team key) and its tracker-side state. */
interface Seed {
  n: number;
  title: string;
  /** The state's category and display name, for example `['started', 'In Review']`. */
  state: [WorkItem['stateCategory'] | 'triage', string];
  labels: string[];
}

/** What each tracker under test provides. */
interface Harness {
  adapter: CodeAdapter;
  /** How many writes the tracker has accepted. */
  writes(): number;
  /** The identifier of seed `n`. */
  id(n: number): string;
  /** An identifier of an item that exists but belongs to another team. */
  foreign: string;
}

const SEEDS: Seed[] = [
  {
    n: 1,
    title: 'Ready task',
    state: ['unstarted', 'Todo'],
    labels: ['type/task', 'origin/from-agent', 'agent/ready', 'stage/execute'],
  },
  {
    n: 2,
    title: 'Task in review',
    state: ['started', 'In Review'],
    labels: ['type/task', 'agent/claimed'],
  },
  {
    n: 3,
    title: 'Shipped task',
    state: ['completed', 'Done'],
    labels: ['type/task', 'agent/completed'],
  },
  {
    n: 4,
    title: 'Untriaged idea',
    state: ['triage', 'Triage'],
    labels: ['type/idea', 'origin/human'],
  },
  // A bare, ungrouped label the recorded Linear team has and the fake's generic list does not.
  {
    n: 5,
    title: 'Task with a bare label',
    state: ['unstarted', 'Todo'],
    labels: ['type/task', 'Bug'],
  },
];

/** The fake tracker, seeded. */
function fakeHarness(): Harness {
  const tracker = new FakeTracker({
    team: { key: 'FAKE', id: 'team-fake' },
    items: [
      ...SEEDS.map((seed) => ({
        id: `fake-${seed.n}`,
        identifier: `FAKE-${seed.n}`,
        title: seed.title,
        description: '',
        type: seed.labels.includes('type/idea') ? ('idea' as const) : ('task' as const),
        stateCategory: seed.state[0] === 'triage' ? ('backlog' as const) : seed.state[0],
        stateName: seed.state[1],
        parent: null,
        relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
        labels: [...seed.labels],
      })),
      {
        id: 'other-7',
        identifier: 'OTHER-7',
        title: 'Another team',
        description: '',
        type: 'task',
        stateCategory: 'unstarted',
        stateName: 'Todo',
        parent: null,
        relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
        // A label the team does not have: it must not become writable elsewhere.
        labels: ['type/task', 'agent/bogus'],
      },
    ],
  });
  return {
    adapter: tracker.adapter,
    writes: () => tracker.writes.length,
    id: (n) => `FAKE-${n}`,
    foreign: 'OTHER-7',
  };
}

/** The real Linear adapter over the simulator, seeded identically. */
function linearHarness(): Harness {
  const sim = simulateLinear([
    ...SEEDS.map((seed) => ({
      identifier: `${TEAM.key}-${seed.n}`,
      title: seed.title,
      team: TEAM,
      stateId: seedStateId(seed.state[0], seed.state[1]),
      labels: [...seed.labels],
      comments: [],
    })),
    {
      identifier: 'FB-7',
      title: 'Another team',
      team: { id: 'other-team', key: 'FB' },
      stateId: seedStateId('unstarted'),
      labels: ['type/task'],
      comments: [],
    },
  ]);
  const adapter = linear.createAdapter({
    config: FlowConfigSchema.parse({ connection: { team: TEAM } }),
    secrets: { trackerAccount: 'flow-bot' },
    transport: sim.transport,
    warn: () => undefined,
  });
  return { adapter, writes: sim.writes, id: (n) => `${TEAM.key}-${n}`, foreign: 'FB-7' };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const sorted = (labels: readonly string[]) => [...labels].sort();

describe.each([
  ['the fake tracker', fakeHarness],
  ['the Linear adapter (simulated Linear)', linearHarness],
])('code adapter contract: %s', (_name, make) => {
  it('a claim replaces only the agent and stage families, keeps every other label, and verifies', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(1));
    const change = {
      stateCategory: 'started' as const,
      agentLabel: 'agent/claimed',
      stageLabel: null,
    };
    await h.adapter.applyWorkState(item, change);
    const after = await verifyWrite(h.adapter, item, change);
    expect(after.stateCategory).toBe('started');
    expect(after.stateName).toBe('In Progress');
    expect(sorted(after.labels)).toEqual(
      sorted(['type/task', 'origin/from-agent', 'agent/claimed'])
    );
    expect(after.agentDisposition).toBe('claimed');
  });

  it('a state-only change keeps every label (the label-stripping bug)', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(1));
    await h.adapter.applyWorkState(item, { stateCategory: 'backlog' });
    const after = await h.adapter.getItem(h.id(1));
    expect(after.stateCategory).toBe('backlog');
    expect(sorted(after.labels)).toEqual(sorted(SEEDS[0].labels));
  });

  it('computes labels from the tracker, never from a stale copy of the item', async () => {
    const h = make();
    const stale = { ...(await h.adapter.getItem(h.id(1))), labels: [] };
    await h.adapter.applyWorkState(stale, { agentLabel: 'agent/claimed' });
    const after = await h.adapter.getItem(h.id(1));
    expect(sorted(after.labels)).toEqual(
      sorted(['type/task', 'origin/from-agent', 'stage/execute', 'agent/claimed'])
    );
  });

  it('a write within the same category keeps the state (In Review stays In Review)', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(2));
    const before = h.writes();
    await h.adapter.applyWorkState(item, {
      stateCategory: 'started',
      agentLabel: 'agent/needs-input',
    });
    expect(h.writes()).toBe(before + 1);
    const after = await h.adapter.getItem(h.id(2));
    expect(after.stateName).toBe('In Review');
    expect(after.labels).toContain('agent/needs-input');
  });

  it('a change the tracker already matches writes nothing', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(2));
    const before = h.writes();
    await h.adapter.applyWorkState(item, { stateCategory: 'started', agentLabel: 'agent/claimed' });
    expect(h.writes()).toBe(before);
  });

  it('refuses a label the team does not have, and writes nothing', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(1));
    const before = h.writes();
    const error = await rejection(h.adapter.applyWorkState(item, { agentLabel: 'agent/bogus' }));
    expect(error).toBeInstanceOf(TrackerError);
    expect((error as Error).message).toMatch(/agent\/bogus/);
    expect(h.writes()).toBe(before);
    expect(sorted((await h.adapter.getItem(h.id(1))).labels)).toEqual(sorted(SEEDS[0].labels));
  });

  it("reports a missing item and another team's item as precondition failures", async () => {
    const h = make();
    expect(await rejection(h.adapter.getItem(h.id(999)))).toBeInstanceOf(PreconditionError);
    expect(await rejection(h.adapter.getItem(h.foreign))).toBeInstanceOf(PreconditionError);
  });

  it("refuses to write to another team's item (precondition) and reports a missing one as a tracker failure", async () => {
    const h = make();
    const template = await h.adapter.getItem(h.id(1));
    const foreign = { ...template, id: '', identifier: h.foreign };
    const missing = { ...template, id: '', identifier: h.id(999) };
    const before = h.writes();
    expect(
      await rejection(h.adapter.applyWorkState(foreign, { agentLabel: 'agent/claimed' }))
    ).toBeInstanceOf(PreconditionError);
    expect(await rejection(h.adapter.comment(foreign, 'x'))).toBeInstanceOf(PreconditionError);
    expect(
      await rejection(h.adapter.applyWorkState(missing, { agentLabel: 'agent/claimed' }))
    ).toBeInstanceOf(TrackerError);
    expect(await rejection(h.adapter.comment(missing, 'x'))).toBeInstanceOf(TrackerError);
    expect(h.writes()).toBe(before);
  });

  it('keeps a label the item already carries, even one outside the generic families', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(5));
    await h.adapter.applyWorkState(item, { stateCategory: 'started', agentLabel: 'agent/claimed' });
    expect(sorted((await h.adapter.getItem(h.id(5))).labels)).toEqual(
      sorted(['type/task', 'Bug', 'agent/claimed'])
    );
  });

  it("never writes a label that exists only on another team's item", async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(1));
    expect(
      await rejection(h.adapter.applyWorkState(item, { agentLabel: 'agent/bogus' }))
    ).toBeInstanceOf(TrackerError);
  });

  it('stores comments as the acting account and returns the latest ones oldest first', async () => {
    const h = make();
    const item = await h.adapter.getItem(h.id(1));
    await h.adapter.comment(item, 'first');
    await h.adapter.comment(item, 'second');
    await h.adapter.comment(item, 'third');
    const read = await h.adapter.getItem(h.id(1), { comments: 2 });
    expect(read.comments?.map((c) => c.body)).toEqual(['second', 'third']);
    const me = await h.adapter.getCurrentUser();
    expect(read.comments?.every((c) => c.author === me.id)).toBe(true);
  });

  it('snapshots open items only, lists closed ones on request, and moves a closed item across', async () => {
    const h = make();
    const first = await h.adapter.getBacklogSnapshot();
    // Only this team's open items: never the foreign item the tracker also holds.
    expect(first.items.map((i) => i.identifier).sort()).toEqual(
      [h.id(1), h.id(2), h.id(4), h.id(5)].sort()
    );
    expect(first.closed).toEqual([]);
    expect(first.items.find((i) => i.identifier === h.id(4))?.stateCategory).toBe('backlog');
    // Seed 5 carries a bare label on purpose; INV-4 rejects bare labels on both
    // trackers alike (the groom reports them), so it is left out of this check.
    expect(validate(first.items.filter((i) => i.identifier !== h.id(5))).ok).toBe(true);
    expect(validate(first.items).failures.map((f) => f.invariant)).toEqual(['INV-4']);

    const item = await h.adapter.getItem(h.id(1));
    await h.adapter.applyWorkState(item, {
      stateCategory: 'completed',
      agentLabel: 'agent/completed',
    });
    const second = await h.adapter.getBacklogSnapshot({ includeClosed: true });
    expect(second.items.map((i) => i.identifier)).not.toContain(h.id(1));
    expect(second.closed.map((c) => [c.identifier, c.stateCategory]).sort()).toEqual(
      [
        [h.id(1), 'completed'],
        [h.id(3), 'completed'],
      ].sort()
    );
  });
});

describe('fake tracker extras (no Linear counterpart)', () => {
  it('a merged PR closes the items it names and leaves their labels alone', () => {
    const tracker = new FakeTracker({
      team: { key: 'FAKE', id: 'team-fake' },
      items: [
        {
          id: 'fake-1',
          identifier: 'FAKE-1',
          title: 'x',
          description: '',
          type: 'task',
          stateCategory: 'started',
          stateName: 'In Progress',
          parent: null,
          relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
          labels: ['type/task', 'agent/claimed'],
        },
      ],
    });
    expect(
      tracker.mergePr({ body: 'Fix the thing.\n\nCloses FAKE-1, and mentions FAKE-2.' })
    ).toEqual(['FAKE-1']);
    expect(tracker.backlog.items[0]).toMatchObject({
      stateCategory: 'completed',
      stateName: 'Done',
      labels: ['type/task', 'agent/claimed'],
    });
  });

  it('an unreachable tracker throws on read, and a dropped write is caught by the read-back', async () => {
    const down = new FakeTracker({ items: [], failReads: 'connection refused' });
    await expect(down.adapter.getBacklogSnapshot()).rejects.toThrow(/connection refused/);

    const dropping = new FakeTracker({
      dropWrites: true,
      items: [
        {
          id: 'fake-1',
          identifier: 'FAKE-1',
          title: 'x',
          description: '',
          type: 'task',
          stateCategory: 'unstarted',
          stateName: 'Todo',
          parent: null,
          relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
          labels: ['type/task', 'agent/ready'],
        },
      ],
    });
    const item = await dropping.adapter.getItem('FAKE-1');
    const change = { agentLabel: 'agent/claimed' };
    await dropping.adapter.applyWorkState(item, change);
    await expect(verifyWrite(dropping.adapter, item, change)).rejects.toBeInstanceOf(TrackerError);
  });
});

describe('the Linear simulator follows the recordings', () => {
  // The simulator must never be kinder than Linear: where it answers from a
  // belief (how Linear orders and limits comments), that belief is checked
  // against a real, read-only recording here.
  const recorded = JSON.parse(
    readFileSync(
      new URL('./fixtures/linear-adapter/comments.recorded.json', import.meta.url),
      'utf8'
    )
  ) as {
    query: string;
    answers: { variables: { comments: number }; comments: { id: string; createdAt: string }[] }[];
  };

  it('answers the query the adapter sends today', () => {
    expect(linear.ITEM_WITH_COMMENTS_QUERY).toBe(recorded.query);
  });

  it('orders and limits comments as the recording shows: the latest N, newest first', async () => {
    const sim = simulateLinear([
      {
        identifier: `${TEAM.key}-1`,
        title: 'x',
        team: TEAM,
        stateId: seedStateId('unstarted'),
        labels: ['type/task'],
        comments: [...recorded.answers[0].comments]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((c) => ({ id: c.id, body: '', createdAt: c.createdAt, userId: 'user-agent' })),
      },
    ]);
    for (const answer of recorded.answers) {
      const result = await sim.transport.run('composio', [
        'execute',
        'LINEAR_RUN_QUERY_OR_MUTATION',
        '-d',
        JSON.stringify({
          query_or_mutation: linear.ITEM_WITH_COMMENTS_QUERY,
          variables: { id: `${TEAM.key}-1`, comments: answer.variables.comments },
        }),
      ]);
      const nodes = JSON.parse(result.stdout).data.data.issue.comments.nodes as { id: string }[];
      expect(nodes.map((n) => n.id)).toEqual(answer.comments.map((c) => c.id));
    }
  });
});
