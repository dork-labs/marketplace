/**
 * `flow next` and open pull requests (DOR-3341): an item with an open PR counts
 * toward the WIP cap whatever its state or claim; the open-PR cap reports the
 * PRs holding its slots, lets only urgent work start, and fails closed when
 * the count cannot be read; `land` names the agent's oldest open PR.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CliDeps } from '../../scripts/cli/context.ts';
import type { OpenPr } from '../../scripts/forge/open-prs.ts';
import type { Forge } from '../../scripts/forge/types.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './read-verb-harness.ts';

const AGENT = 'flow-bot';

let temp: TempProject | undefined;
afterEach(() => temp?.cleanup());

/** `git remote get-url origin` answers a GitHub address; nothing else runs. */
const github: CliDeps['runProcess'] = async (cmd, args) =>
  cmd === 'git' && args.join(' ') === 'remote get-url origin'
    ? { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    : { code: 0, stdout: '', stderr: '' };

/** One open PR. */
function pr(number: number, headRefName: string, overrides: Partial<OpenPr> = {}): OpenPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    createdAt: `2026-09-${String(10 + number).padStart(2, '0')}T00:00:00Z`,
    author: AGENT,
    headRefName,
    headSha: String(number).repeat(40).slice(0, 40),
    baseRefName: 'main',
    isDraft: false,
    labels: [],
    armed: false,
    ...overrides,
  };
}

/** A forge whose only answer is its open PRs (or an error). */
function forgeWith(prs: OpenPr[] | Error): CliDeps['createForge'] {
  return () =>
    ({
      repo: 'acme/app',
      async openPrs() {
        if (prs instanceof Error) throw prs;
        return prs;
      },
    }) as unknown as Forge;
}

function config(extra: Record<string, unknown> = {}) {
  return {
    tracker: 'fake',
    identity: { agent: AGENT, reviewer: 'dorian' },
    autonomy: { wipCap: { global: 2, perProject: 2 } },
    ...extra,
  };
}

async function next(items: ReturnType<typeof readyItem>[], prs: OpenPr[] | Error, extra = {}) {
  temp = tempProject(config(extra));
  const result = await runFlow(
    ['next', '--json', '-n', '10', '--no-account'],
    temp,
    { user: { id: AGENT }, items },
    { runProcess: github, createForge: forgeWith(prs) }
  );
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('flow next: an open PR is work in progress', () => {
  it('a review-state item whose claim dropped still counts while its PR is open', async () => {
    const items = [
      // In review, not claimed: before DOR-3341 this counted for nothing.
      readyItem('A-1', { stateCategory: 'started', stateName: 'In Review', labels: ['type/task'] }),
      readyItem('A-2', { stateCategory: 'started', stateName: 'In Review', labels: ['type/task'] }),
      readyItem('A-3', { priority: 2 }),
    ];
    const out = await next(items, [pr(1, 'a-1-fix'), pr(2, 'work', { title: 'Do it (A-2)' })]);
    expect(out.wip).toMatchObject({ total: 2, fromOpenPrs: 2 });
    // The WIP cap of 2 is full, so the ready item waits.
    expect(out.picked).toEqual([]);
    expect(out.atWipCap).toBe(true);
  });

  it('the same items with no open PRs leave the cap free', async () => {
    const items = [
      readyItem('A-1', { stateCategory: 'started', labels: ['type/task'] }),
      readyItem('A-3', { priority: 2 }),
    ];
    const out = await next(items, []);
    expect(out.wip).toMatchObject({ total: 0, fromOpenPrs: 0 });
    expect(out.picked.map((i: { identifier: string }) => i.identifier)).toEqual(['A-3']);
  });

  it('a ready item that already has an open PR is never picked again', async () => {
    const items = [readyItem('A-4', { priority: 1 }), readyItem('A-5', { priority: 3 })];
    const out = await next(items, [pr(1, 'a-4-fix')]);
    expect(out.picked.map((i: { identifier: string }) => i.identifier)).toEqual(['A-5']);
  });

  it('matches the identifier as a whole token, never a prefix', async () => {
    const items = [
      readyItem('A-1', { stateCategory: 'started', labels: ['type/task'] }),
      readyItem('A-3'),
    ];
    const out = await next(items, [pr(1, 'a-12-other')]);
    expect(out.wip.total).toBe(0);
  });
});

describe('flow next: the open-PR cap', () => {
  const ready = [readyItem('B-1', { priority: 2 }), readyItem('B-2', { priority: 1 })];

  it('at the cap: atPrCap, the PRs holding the slots, and only urgent work', async () => {
    const out = await next(ready, [pr(4, 'x-4'), pr(3, 'x-3'), pr(5, 'x-5')], {
      pr: { maxOpen: 3 },
      autonomy: { wipCap: { global: 10, perProject: 10 } },
    });
    expect(out.atPrCap).toBe(true);
    expect(out.prCap).toEqual({ readable: true, open: 3, max: 3, atCap: true, holding: [4, 3, 5] });
    expect(out.picked.map((i: { identifier: string }) => i.identifier)).toEqual(['B-2']);
  });

  it('under the cap: not at the cap, and every ready item is eligible', async () => {
    const out = await next(ready, [pr(3, 'x-3')], { pr: { maxOpen: 3 } });
    expect(out.atPrCap).toBe(false);
    expect(out.picked).toHaveLength(2);
  });

  it('an unreadable count is the cap: fails closed, P0 still exempt', async () => {
    const out = await next(ready, new Error('gh: not signed in'));
    expect(out.atPrCap).toBe(true);
    expect(out.prCap).toMatchObject({ readable: false, atCap: true, error: 'gh: not signed in' });
    expect(out.picked.map((i: { identifier: string }) => i.identifier)).toEqual(['B-2']);
  });

  it('a checkout with no forge has no cap', async () => {
    temp = tempProject(config());
    const result = await runFlow(['next', '--json', '--no-account'], temp, {
      user: { id: AGENT },
      items: ready,
    });
    const out = JSON.parse(result.stdout);
    expect(out.prCap).toBeNull();
    expect(out.atPrCap).toBe(false);
  });
});

describe('flow next: land first', () => {
  it("names the agent's oldest unarmed open PR, skipping others' and armed ones", async () => {
    const items = [
      readyItem('C-1', { stateCategory: 'started', labels: ['type/task'], assignee: AGENT }),
      readyItem('C-2', { stateCategory: 'started', labels: ['type/task'], assignee: AGENT }),
      readyItem('C-3', { stateCategory: 'started', labels: ['type/task'], assignee: 'someone' }),
    ];
    const out = await next(items, [
      pr(1, 'c-3-theirs'),
      pr(2, 'c-1-armed', { armed: true }),
      pr(3, 'c-2-mine'),
    ]);
    expect(out.land).toMatchObject({ number: 3, identifier: 'C-2' });
  });

  it('is null when the agent owns no open PR', async () => {
    const out = await next([readyItem('C-4')], [pr(1, 'z-1')]);
    expect(out.land).toBeNull();
  });
});
