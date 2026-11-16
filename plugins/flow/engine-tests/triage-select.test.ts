/**
 * What the daily triage takes up (DOR-4546): an item with a bucket and a
 * project is never triaged again (a Must excepted, until it is readied or
 * parked), so a Could's last-changed time is left alone for the groom's
 * 30-day expiry. Made-up items only.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { needsTriage } from '../scripts/triage-select.ts';
import type { FakeBacklog } from '../scripts/tracker/fake.ts';
import { EXIT } from '../scripts/errors.ts';
import { readyItem, runFlow, tempProject, type TempProject } from './cli/read-verb-harness.ts';

const PROJECT = { id: 'proj-1', name: 'Widgets', stateCategory: 'started' as const };

describe('needsTriage', () => {
  it.each([3, 4] as const)('leaves a priority-%i item with a project alone', (priority) => {
    expect(needsTriage({ labels: ['type/task'], priority, project: PROJECT })).toBe(false);
  });

  it('takes up an item with no priority, priority 0, or no project', () => {
    expect(needsTriage({ labels: ['type/idea'], project: PROJECT })).toBe(true);
    expect(needsTriage({ labels: ['type/idea'], priority: 0, project: PROJECT })).toBe(true);
    expect(needsTriage({ labels: ['type/idea'], priority: 3 })).toBe(true);
  });

  it('takes up a Must until it is readied or parked', () => {
    expect(needsTriage({ labels: ['type/task'], priority: 2, project: PROJECT })).toBe(true);
    expect(needsTriage({ labels: ['type/task'], priority: 1, project: PROJECT })).toBe(true);
    for (const label of ['agent/ready', 'agent/needs-input', 'agent/claimed']) {
      expect(needsTriage({ labels: ['type/task', label], priority: 2, project: PROJECT })).toBe(
        false
      );
    }
  });

  it("skips a person's item, and counts the agent's own as unassigned", () => {
    expect(needsTriage({ labels: [], assignee: 'a-person' }, 'flow-bot')).toBe(false);
    expect(needsTriage({ labels: [], assignee: 'flow-bot' }, 'flow-bot')).toBe(true);
  });
});

describe('flow snapshot --untriaged', () => {
  let temp: TempProject | undefined;
  afterEach(() => temp?.cleanup());

  function backlog(): FakeBacklog {
    const fresh = { labels: ['type/idea'], stateCategory: 'backlog' as const, agentDisposition: undefined };
    return {
      user: { id: 'flow-bot' },
      items: [
        readyItem('FAKE-1'),
        readyItem('FAKE-2', { ...fresh, priority: 3 }),
        readyItem('FAKE-3', { ...fresh, priority: 4, updatedAt: '2026-09-01T00:00:00.000Z' }),
        readyItem('FAKE-4', { ...fresh, priority: undefined }),
        readyItem('FAKE-5', { ...fresh, priority: 2 }),
        readyItem('FAKE-6', { ...fresh, project: undefined }),
      ],
      projects: [PROJECT],
    };
  }

  it('lists only the items still needing triage, and never a bucketed Should or Could', async () => {
    temp = tempProject({ tracker: 'fake', identity: { agent: 'flow-bot' } });
    const run = await runFlow(['snapshot', '--json', '--untriaged'], temp, backlog());
    expect(run.code).toBe(EXIT.ok);
    const ids = (JSON.parse(run.stdout).items as { identifier: string }[]).map((i) => i.identifier);
    expect(ids).toEqual(['FAKE-4', 'FAKE-5', 'FAKE-6']);
  });

  it('refuses to save a filtered pull', async () => {
    temp = tempProject({ tracker: 'fake', identity: { agent: 'flow-bot' } });
    const run = await runFlow(
      ['snapshot', '--json', '--untriaged', '--out', 'x.json'],
      temp,
      backlog()
    );
    expect(run.code).toBe(EXIT.usage);
  });
});
