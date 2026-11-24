/**
 * `flow order` (DOR-5063): the work order through the CLI, against the fake
 * tracker. The ranking itself is pinned by `engine-tests/work-order.test.ts`;
 * these cases pin the verb: its flags, its JSON, its text, and that it reads
 * the snapshot's projects when the adapter gives no project fields.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectInfo, WorkItem } from '../../scripts/work-item.ts';
import {
  readyItem,
  runFlow as runFlowIn,
  tempProject,
  type TempProject,
} from './read-verb-harness.ts';
import type { FakeBacklog } from '../../scripts/tracker/fake.ts';

let temp: TempProject | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const runFlow = (argv: readonly string[], backlog: Omit<FakeBacklog, 'team'>) => {
  temp ??= tempProject({});
  return runFlowIn(argv, temp, { team: { key: 'ABC', id: 'team-1' }, ...backlog });
};

const billing = { id: 'p-billing', name: 'Billing', stateCategory: 'started' as const };
const mobile = { id: 'p-mobile', name: 'Mobile', stateCategory: 'unstarted' as const };

const PROJECTS: ProjectInfo[] = [
  {
    id: 'p-billing',
    name: 'Billing',
    slugId: 'billing',
    statusType: 'started',
    priority: 1,
    targetDate: '2026-12-01',
    labels: [],
    blockedBy: [],
  },
  {
    id: 'p-mobile',
    name: 'Mobile',
    slugId: 'mobile',
    statusType: 'planned',
    labels: [],
    blockedBy: [],
  },
  { id: 'p-old', name: 'Old', slugId: 'old', statusType: 'paused', labels: [], blockedBy: [] },
];

/** A small backlog: a pin, an Urgent, two Musts (one blocked), a held item and one in flight. */
function items(): WorkItem[] {
  return [
    readyItem('ABC-1', { project: billing, size: 3 }),
    readyItem('ABC-2', {
      project: billing,
      size: 1,
      relations: { blocks: [], blockedBy: ['ABC-5'], children: [], relatedTo: [] },
    }),
    readyItem('ABC-3', {
      priority: 1,
      project: mobile,
      size: 2,
      labels: ['type/task', 'security'],
    }),
    readyItem('ABC-4', {
      priority: 3,
      project: billing,
      labels: ['type/task', 'pin'],
      pin: { reason: 'demo on Friday', actorName: 'Ana Fictional', at: '2026-09-25T10:00:00Z' },
    }),
    readyItem('ABC-5', {
      priority: 4,
      project: billing,
      size: 2,
      relations: { blocks: ['ABC-2'], blockedBy: [], children: [], relatedTo: [] },
    }),
    readyItem('ABC-6', { project: mobile }),
    readyItem('ABC-7', { stateCategory: 'started', stateName: 'In Review', project: billing }),
    readyItem('ABC-8', { priority: 0, project: billing }),
  ];
}

describe('flow order', () => {
  it('prints the order as JSON: banners, projects, issues with why, and every unranked list', async () => {
    const result = await runFlow(['order', '--json'], { items: items(), projectInfo: PROJECTS });
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.banners).toEqual(['Urgent below pins: ABC-3 (security)']);
    expect(out.issues.map((i: { identifier: string }) => i.identifier)).toEqual([
      'ABC-4',
      'ABC-3',
      'ABC-5',
      'ABC-1',
    ]);
    expect(out.issues[2]).toMatchObject({
      identifier: 'ABC-5',
      band: 'must',
      inheritsFrom: 'ABC-2',
    });
    expect(out.held).toEqual([
      { identifier: 'ABC-2', title: 'Title of ABC-2', reason: 'held by ABC-5' },
      { identifier: 'ABC-6', title: 'Title of ABC-6', reason: 'waits for project Mobile' },
    ]);
    expect(out.inFlight).toEqual([
      { identifier: 'ABC-7', title: 'Title of ABC-7', stateName: 'In Review' },
    ]);
    expect(out.needsTriage).toEqual([
      { identifier: 'ABC-8', title: 'Title of ABC-8', missing: ['priority'] },
    ]);
    expect(out.projects.now.map((p: { name: string }) => p.name)).toEqual(['Billing']);
    expect(out.projects.next.map((p: { name: string }) => p.name)).toEqual(['Mobile']);
    expect(out.projects.later).toBeUndefined();
    expect(out.generatedAt).toBe('2026-09-26T12:00:00.000Z');
  });

  it('-n keeps the first N issues; --all adds Paused and Backlog projects', async () => {
    const out = JSON.parse(
      (
        await runFlow(['order', '-n', '2', '--all', '--json'], {
          items: items(),
          projectInfo: PROJECTS,
        })
      ).stdout
    );
    expect(out.issues.map((i: { identifier: string }) => i.identifier)).toEqual(['ABC-4', 'ABC-3']);
    expect(out.projects.later.map((p: { name: string }) => p.name)).toEqual(['Old']);
  });

  it('--projects prints only the project order', async () => {
    const result = await runFlow(['order', '--projects'], {
      items: items(),
      projectInfo: PROJECTS,
    });
    expect(result.stdout).toContain('Projects now (Started: 1, cap 6)');
    expect(result.stdout).toContain('Billing');
    expect(result.stdout).not.toContain('ABC-1');
  });

  it("--projects shows flags, the cap and Dorian's projects; dates in words, ISO in JSON", async () => {
    const projects: ProjectInfo[] = [
      ...PROJECTS,
      {
        id: 'p-search',
        name: 'Search',
        slugId: 'search',
        statusType: 'started',
        priority: 2,
        labels: [],
        blockedBy: [],
      },
      {
        id: 'p-desk',
        name: 'Desk',
        slugId: 'desk',
        statusType: 'started',
        priority: 1,
        labels: ['owner/dorian'],
        blockedBy: [],
      },
    ];
    temp = tempProject({ projects: { startedCap: 1 } });
    const text = await runFlow(['order', '--projects'], { items: items(), projectInfo: projects });
    expect(text.stdout).toContain('Projects now (Started: 2, cap 1)');
    expect(text.stdout).toMatch(/1 +Billing +priority Urgent, /);
    expect(text.stdout).toMatch(/2 +Search +.*  over cap/);
    expect(text.stdout).not.toMatch(/target Dec 1|needs a target date/);
    expect(text.stdout).toContain('Project flags: over cap: 2 Started, cap 1; lowest: Search');
    expect(text.stdout).toContain("Dorian's projects, out of the agent order: Desk");
    const json = JSON.parse(
      (await runFlow(['order', '--projects', '--json'], { items: items(), projectInfo: projects }))
        .stdout
    );
    expect(json.projects.now[0]).toMatchObject({ id: 'p-billing', targetDate: '2026-12-01' });
    expect(json.projects.dorian).toEqual([{ id: 'p-desk', name: 'Desk' }]);
    expect(json.projects.flags).toEqual(['over cap: 2 Started, cap 1; lowest: Search']);
  });

  it('--rank-of prints the place, or unranked with the reason', async () => {
    const ranked = await runFlow(['order', '--rank-of', 'ABC-1'], {
      items: items(),
      projectInfo: PROJECTS,
    });
    expect(ranked.stdout.trim()).toBe('4');
    const held = await runFlow(['order', '--rank-of', 'ABC-2', '--json'], {
      items: items(),
      projectInfo: PROJECTS,
    });
    expect(JSON.parse(held.stdout)).toMatchObject({
      identifier: 'ABC-2',
      place: null,
      unranked: 'held by ABC-5',
    });
  });

  it('--why gives the reasons and what would move it up', async () => {
    const result = await runFlow(['order', '--why', 'ABC-1'], {
      items: items(),
      projectInfo: PROJECTS,
    });
    expect(result.stdout).toContain('ABC-1 is #4: Title of ABC-1');
    expect(result.stdout).toContain('Must (High, Todo)');
    expect(result.stdout).toContain('Above it: ABC-5.');
  });

  it('refuses --why with --rank-of, and a bad -n', async () => {
    expect(
      (await runFlow(['order', '--why', 'ABC-1', '--rank-of', 'ABC-1'], { items: [] })).code
    ).toBe(2);
    expect((await runFlow(['order', '-n', '0'], { items: [] })).code).toBe(2);
  });

  it('prints plain text a person can scan: banner first, a why per issue, then the unranked lists', async () => {
    const { stdout } = await runFlow(['order'], { items: items(), projectInfo: PROJECTS });
    const lines = stdout.split('\n');
    expect(lines[0]).toBe('Urgent below pins: ABC-3 (security)');
    expect(stdout).toMatch(
      /1 +ABC-4 +Title of ABC-4 +pinned: demo on Friday \(by Ana Fictional, Sep 25\)/
    );
    expect(stdout).toContain("inherits ABC-2's place");
    for (const heading of ['In flight (1)', 'Held (2)', 'Needs triage (1)']) {
      expect(stdout).toContain(heading);
    }
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  });

  it('lists items with order.personLabel apart, under that label, in JSON and text', async () => {
    temp = tempProject({ order: { personLabel: 'owner/someone' } });
    const backlog = {
      items: [...items(), readyItem('ABC-9', { project: billing, labels: ['owner/someone'] })],
      projectInfo: PROJECTS,
    };
    const out = JSON.parse((await runFlow(['order', '--json'], backlog)).stdout);
    expect(out.personal).toEqual([{ identifier: 'ABC-9', title: 'Title of ABC-9' }]);
    const { stdout } = await runFlow(['order'], backlog);
    expect(stdout).toContain('Out of the agent order (label owner/someone) (1)');
    expect((await runFlow(['order', '--rank-of', 'ABC-9'], backlog)).stdout.trim()).toBe(
      'unranked: out of the agent order (label owner/someone)'
    );
  });

  it('with no order.personLabel, the same item ranks like any other', async () => {
    const out = JSON.parse(
      (
        await runFlow(['order', '--json'], {
          items: [...items(), readyItem('ABC-9', { project: billing, labels: ['owner/someone'] })],
          projectInfo: PROJECTS,
        })
      ).stdout
    );
    expect(out.personal).toEqual([]);
    expect(out.issues.map((i: { identifier: string }) => i.identifier)).toContain('ABC-9');
  });

  it('ranks from the snapshot projects when the adapter reads no project fields', async () => {
    const out = JSON.parse(
      (await runFlow(['order', '--json'], { items: items(), projects: [billing, mobile] })).stdout
    );
    expect(out.projects.now.map((p: { id: string }) => p.id)).toEqual(['p-billing']);
    expect(out.issues.map((i: { identifier: string }) => i.identifier)).toContain('ABC-1');
  });
});
