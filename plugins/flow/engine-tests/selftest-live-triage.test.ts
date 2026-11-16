/**
 * The live tier's triage outcome rule (`notTriaged`, DOR-4546): a Must is
 * readied or parked, a Should or Could may stay in the backlog unreadied in a
 * project, and nothing else passes. Made-up items only.
 */

import { describe, expect, it } from 'vitest';

import { notTriaged } from '../scripts/selftest/live/cases.ts';
import type { FakeBacklog } from '../scripts/tracker/fake.ts';
import type { WorkItem } from '../scripts/tracker/types.ts';

const PROJECT = { id: 'p1', name: 'Made-up project', stateCategory: 'started' as const };

/** A store holding one item, ABC-1, with the given fields. */
function store(over: Partial<WorkItem>, comments = 0): FakeBacklog {
  return {
    items: [
      {
        id: 'id-1',
        identifier: 'ABC-1',
        title: 'A made-up item',
        description: '',
        type: 'task',
        stateCategory: 'backlog',
        stateName: 'Triage',
        parent: null,
        relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
        labels: ['type/task'],
        ...over,
      },
    ],
    comments: {
      'ABC-1': Array.from({ length: comments }, (_, i) => ({
        id: `c${i}`,
        author: 'flow',
        body: 'Which one?',
        createdAt: '2026-11-16T00:00:00.000Z',
      })),
    },
  } as FakeBacklog;
}

const BEFORE = store({});
const judge = (after: FakeBacklog) => notTriaged(BEFORE, after, 'ABC-1');

describe('notTriaged', () => {
  it.each([3, 4] as const)('passes a priority-%i item left in the backlog in a project', (p) => {
    expect(judge(store({ priority: p, project: PROJECT }))).toBeUndefined();
  });

  it.each([1, 2] as const)('fails a priority-%i Must left unreadied', (p) => {
    expect(judge(store({ priority: p, project: PROJECT }))).toMatch(
      /is a Must .* neither readied nor parked/
    );
  });

  it('passes a readied Must, and a parked Must with one question', () => {
    const ready = { labels: ['type/task', 'agent/ready', 'stage/execute'] };
    expect(judge(store({ priority: 2, project: PROJECT, stateCategory: 'unstarted', ...ready })))
      .toBeUndefined();
    const parked = store({ priority: 2, project: PROJECT, labels: ['type/task', 'agent/needs-input'] }, 1);
    expect(judge(parked)).toBeUndefined();
  });

  it('fails a readied Should', () => {
    expect(
      judge(
        store({
          priority: 3,
          project: PROJECT,
          stateCategory: 'unstarted',
          labels: ['type/task', 'agent/ready', 'stage/execute'],
        })
      )
    ).toMatch(/was readied, but only a Must is \(priority 3\)/);
  });

  it('fails a readied item with no priority: only a Must is readied', () => {
    expect(
      judge(
        store({
          project: PROJECT,
          stateCategory: 'unstarted',
          labels: ['type/task', 'agent/ready', 'stage/execute'],
        })
      )
    ).toMatch(/only a Must is \(priority none\)/);
  });

  it('fails a Should or Could with no project, outside the backlog, or with no priority', () => {
    expect(judge(store({ priority: 3 }))).toMatch(/neither readied, parked, nor left/);
    expect(judge(store({ priority: 4, project: PROJECT, stateCategory: 'unstarted' }))).toMatch(
      /neither readied, parked, nor left/
    );
    expect(judge(store({ project: PROJECT }))).toMatch(/neither readied, parked, nor left/);
  });
});
