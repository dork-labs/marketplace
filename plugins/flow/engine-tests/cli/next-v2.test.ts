/**
 * `flow next` under `dispatch.ladder: "v2"` (DOR-5063): the picks come from the
 * work order, the same function `flow order` prints. The PR cap, the WIP cap,
 * readiness and the agent/ready claim gate hold *starting*, never ranking: a
 * held item stays in the order and is listed in `held` with why. An unready
 * top item is never stepped over (DOR-5069): `makeReady` names it, and nothing
 * below it is picked until it is readied or parked for a person.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CliDeps } from '../../scripts/cli/context.ts';
import type { OpenPr } from '../../scripts/forge/open-prs.ts';
import type { Forge } from '../../scripts/forge/types.ts';
import type { WorkItem } from '../../scripts/work-item.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

const AGENT = 'flow-bot';

let temp: TempProject | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

/** `git remote get-url origin` answers a GitHub address; nothing else runs. */
const github: CliDeps['runProcess'] = async (cmd, args) =>
  cmd === 'git' && args.join(' ') === 'remote get-url origin'
    ? { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    : { code: 0, stdout: '', stderr: '' };

/** A forge with these open PRs. */
function forgeWith(prs: OpenPr[]): CliDeps['createForge'] {
  return () => ({ repo: 'acme/app', openPrs: async () => prs }) as unknown as Forge;
}

/** One open PR on a branch. */
function pr(number: number, headRefName: string): OpenPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    createdAt: '2026-09-20T00:00:00Z',
    author: 'someone',
    headRefName,
    headSha: String(number).repeat(40).slice(0, 40),
    baseRefName: 'main',
    isDraft: false,
    labels: [],
    armed: false,
  };
}

/** Run `flow next --json` with the v2 ladder. */
async function next(
  items: WorkItem[],
  options: { prs?: OpenPr[]; ladder?: 'v1' | 'v2'; maxOpen?: number; argv?: string[] } = {}
) {
  temp = tempProject({
    tracker: 'fake',
    identity: { agent: AGENT, reviewer: 'a-person' },
    autonomy: { wipCap: { global: 2, perProject: 2 } },
    dispatch: { ladder: options.ladder ?? 'v2' },
    pr: { maxOpen: options.maxOpen ?? 8 },
  });
  const result = await runFlow(
    ['next', '-n', '10', '--no-account', ...(options.argv ?? ['--json'])],
    temp,
    { team: { key: 'ABC', id: 'team-1' }, user: { id: AGENT }, items },
    { runProcess: github, createForge: forgeWith(options.prs ?? []) }
  );
  expect(result.code, result.stderr).toBe(0);
  return options.argv === undefined ? JSON.parse(result.stdout) : result.stdout;
}

const ids = (list: { identifier: string }[]) => list.map((entry) => entry.identifier);

describe('flow next with dispatch.ladder v2', () => {
  it('picks in work-order order and carries each pick’s place, band and why', async () => {
    const out = await next([
      readyItem('ABC-1', { priority: 3 }),
      readyItem('ABC-2', { priority: 1 }),
      readyItem('ABC-3', { priority: 2, dueDate: '2026-10-01' }),
    ]);
    expect(out.ladder).toBe('v2');
    expect(ids(out.picked)).toEqual(['ABC-2', 'ABC-3']);
    expect(out.picked[0]).toMatchObject({ place: 1, band: 'urgent', readiness: { ready: true } });
    expect(out.picked[1].why.map((r: { text: string }) => r.text)).toContain('due Oct 1');
    // The third fits no WIP slot: it stays in the order, held by the cap.
    expect(out.held).toEqual([{ identifier: 'ABC-1', title: 'Title of ABC-1', reason: 'WIP cap' }]);
  });

  it('never takes an item below an unready top item: it names the top item to make ready', async () => {
    const out = await next([
      readyItem('ABC-1', { priority: 1, size: undefined }),
      readyItem('ABC-2', { priority: 2, labels: ['type/task', 'stage/execute'] }),
      readyItem('ABC-3', { priority: 3 }),
    ]);
    // ABC-1 has no estimate: it still ranks first (DOR-5069), and nothing below it starts.
    expect(ids(out.picked)).toEqual([]);
    expect(out.makeReady).toEqual({
      identifier: 'ABC-1',
      title: 'Title of ABC-1',
      reasons: ['needs a size'],
      outside: false,
    });
    expect(out.held).toEqual([
      { identifier: 'ABC-1', title: 'Title of ABC-1', reason: 'not ready: needs a size' },
      {
        identifier: 'ABC-2',
        title: 'Title of ABC-2',
        reason: 'waits behind ABC-1, which is made ready first',
      },
      {
        identifier: 'ABC-3',
        title: 'Title of ABC-3',
        reason: 'waits behind ABC-1, which is made ready first',
      },
    ]);
    expect(out.starved).toBe(true);
    expect(out.shapeableCount).toBe(1);
  });

  it('treats a ready item with no agent/ready label as one to make ready, not one to skip', async () => {
    const out = await next([
      readyItem('ABC-1', { priority: 1, labels: ['type/task', 'stage/execute'] }),
      readyItem('ABC-2', { priority: 3 }),
    ]);
    expect(ids(out.picked)).toEqual([]);
    expect(out.makeReady).toEqual({
      identifier: 'ABC-1',
      title: 'Title of ABC-1',
      reasons: ['not agent/ready yet'],
      outside: false,
    });
  });

  it('marks an unready top item from outside the team (a capture tag in its title) to be parked, not written', async () => {
    // Security (DOR-5069): the label was cleared by a person, but the words
    // came from outside, so the drain asks rather than writing its done-when.
    const out = await next([
      readyItem('ABC-1', {
        priority: 1,
        title: 'Export as CSV [acme/app#7]',
        description: 'Export it.',
      }),
      readyItem('ABC-2', { priority: 3 }),
    ]);
    expect(out.makeReady).toEqual({
      identifier: 'ABC-1',
      title: 'Export as CSV [acme/app#7]',
      reasons: ['needs a done-when'],
      outside: true,
    });
    const text = await next(
      [readyItem('ABC-1', { title: 'Export as CSV [acme/app#7]', description: 'Export it.' })],
      { argv: [] }
    );
    expect(text).toContain(
      'ABC-1 tops the work order but is not ready (needs a done-when), and its words came from outside the team: park it with a question; nothing below it starts first.'
    );
  });

  it('still picks the items ranked above the unready one', async () => {
    const out = await next([
      readyItem('ABC-1', { priority: 1 }),
      readyItem('ABC-2', { priority: 2, description: 'No done-when here.' }),
      readyItem('ABC-3', { priority: 3 }),
    ]);
    expect(ids(out.picked)).toEqual(['ABC-1']);
    expect(out.makeReady).toMatchObject({ identifier: 'ABC-2', reasons: ['needs a done-when'] });
    expect(out.held.map((h: { identifier: string }) => h.identifier)).toEqual(['ABC-2', 'ABC-3']);
  });

  it('passes an item parked for a person (agent/needs-input) visibly, and takes the next', async () => {
    const out = await next([
      readyItem('ABC-1', { priority: 1, labels: ['type/task', 'agent/needs-input'] }),
      readyItem('ABC-2', { priority: 3 }),
    ]);
    expect(ids(out.picked)).toEqual(['ABC-2']);
    expect(out.makeReady).toBeNull();
    expect(out.held).toEqual([
      {
        identifier: 'ABC-1',
        title: 'Title of ABC-1',
        reason: 'waits for a person (agent/needs-input)',
      },
    ]);
  });

  it('passes an unready item from outside the team visibly: only a person or the PM readies it', async () => {
    const out = await next([
      readyItem('ABC-1', {
        priority: 1,
        size: undefined,
        labels: ['type/idea', 'agent/from-outside'],
      }),
      readyItem('ABC-2', { priority: 3 }),
    ]);
    expect(ids(out.picked)).toEqual(['ABC-2']);
    expect(out.makeReady).toBeNull();
    expect(out.held).toEqual([
      {
        identifier: 'ABC-1',
        title: 'Title of ABC-1',
        reason: 'from outside the team: a person or the PM readies it',
      },
    ]);
  });

  it('says in the text which item to make ready, and that nothing below it starts', async () => {
    const text = await next([readyItem('ABC-1', { size: undefined }), readyItem('ABC-2')], {
      argv: [],
    });
    expect(text).toContain(
      'ABC-1 tops the work order but is not ready (needs a size): triage it or park it with a question; nothing below it starts first.'
    );
  });

  it('at the open-PR cap, only Urgent starts; the rest stay in the order as held: PR cap', async () => {
    const out = await next(
      [readyItem('ABC-1', { priority: 2 }), readyItem('ABC-2', { priority: 1 })],
      { prs: [pr(1, 'feat/x'), pr(2, 'feat/y')], maxOpen: 2 }
    );
    expect(out.atPrCap).toBe(true);
    expect(ids(out.picked)).toEqual(['ABC-2']);
    expect(out.held).toEqual([{ identifier: 'ABC-1', title: 'Title of ABC-1', reason: 'PR cap' }]);
  });

  it('an item with an open PR is held, not picked again', async () => {
    const out = await next([readyItem('ABC-1'), readyItem('ABC-2')], {
      prs: [pr(1, 'abc-1-the-fix')],
    });
    expect(ids(out.picked)).toEqual(['ABC-2']);
    expect(out.held).toEqual([
      { identifier: 'ABC-1', title: 'Title of ABC-1', reason: 'has an open PR' },
    ]);
  });

  it('opens the text with the work order’s banner and shows each pick’s place and why', async () => {
    const text = await next(
      [
        readyItem('ABC-1', { priority: 1 }),
        readyItem('ABC-2', {
          priority: 3,
          labels: ['type/task', 'agent/ready', 'stage/execute', 'pin'],
          pin: { reason: 'demo first' },
        }),
      ],
      { argv: [] }
    );
    const lines = (text as string).split('\n');
    expect(lines[0]).toBe('Urgent below pins: ABC-1');
    expect(text).toMatch(/#1 ABC-2 - Title of ABC-2 +pinned: demo first/);
    expect(text).toMatch(/#2 ABC-1 - Title of ABC-1 +Urgent/);
  });

  it('v1 stays the default and carries no work-order fields', async () => {
    temp = tempProject({ tracker: 'fake', identity: { agent: AGENT, reviewer: 'a-person' } });
    const result = await runFlow(
      ['next', '--json', '--no-account'],
      temp,
      { team: { key: 'ABC', id: 'team-1' }, user: { id: AGENT }, items: [readyItem('ABC-1')] },
      { runProcess: github, createForge: forgeWith([]) }
    );
    const out = JSON.parse(result.stdout);
    expect(ids(out.picked)).toEqual(['ABC-1']);
    expect(out.ladder).toBeUndefined();
    expect(out.makeReady).toBeUndefined();
    expect(out.picked[0].why).toBeUndefined();
  });
});
