/**
 * Readiness as an output of the work order (DOR-5069): each ranked item says
 * whether an agent may start it, and what is missing when it may not. The
 * reasons are fixed words the drain and `flow order` print as they are.
 */

import { describe, expect, it } from 'vitest';

import { readinessOf } from '../scripts/readiness.ts';
import type { WorkItem } from '../scripts/work-item.ts';

/** An item with everything readiness asks for. */
function item(identifier: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: 'Fix it.\n\n## Done when\n\n- The widget renders.',
    type: 'task',
    stateCategory: 'unstarted',
    stateName: 'Todo',
    priority: 2,
    size: 2,
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/task'],
    ...over,
  };
}

/** Readiness of an item against a set of open items. */
function readiness(subject: WorkItem, open: WorkItem[] = []) {
  return readinessOf(subject, {
    open: new Map([subject, ...open].map((entry) => [entry.identifier, entry])),
  });
}

describe('readinessOf', () => {
  it('is ready when it has a size, a done-when, no open question and no open blocker', () => {
    expect(readiness(item('ABC-1'))).toEqual({ ready: true, reasons: [] });
  });

  it('needs a size when it has no estimate', () => {
    expect(readiness(item('ABC-1', { size: undefined }))).toEqual({
      ready: false,
      reasons: ['needs a size'],
    });
  });

  it.each([
    ['no section at all', 'Fix it.'],
    ['an empty section', 'Fix it.\n\n## Done when\n\n## Notes\n\nMore.'],
    ['a section only inside a code fence', 'Fix it.\n\n```\n## Done when\n\n- x\n```'],
  ])('needs a done-when with %s', (_what, description) => {
    expect(readiness(item('ABC-1', { description })).reasons).toEqual(['needs a done-when']);
  });

  it.each([
    ['## Done when', 'Fix it.\n\n## Done when\n\n- It renders.'],
    ['## Validation criteria', 'Fix it.\n\n## Validation criteria\n\n- It renders.'],
  ])('reads %s as the done-when', (_what, description) => {
    expect(readiness(item('ABC-1', { description })).ready).toBe(true);
  });

  it('needs a decision when a person was asked a question on it (agent/needs-input)', () => {
    expect(readiness(item('ABC-1', { labels: ['type/task', 'agent/needs-input'] }))).toEqual({
      ready: false,
      reasons: ['needs a decision (ABC-1)'],
    });
  });

  it('is blocked by each open blocker, never by a closed one', () => {
    const subject = item('ABC-1', {
      relations: { ...item('x').relations, blockedBy: ['ABC-3', 'ABC-2', 'ABC-9'] },
    });
    expect(readiness(subject, [item('ABC-2'), item('ABC-3')]).reasons).toEqual([
      'blocked by ABC-2',
      'blocked by ABC-3',
    ]);
  });

  it('orders blockers by issue number: ABC-99 before ABC-100', () => {
    const subject = item('ABC-1', {
      relations: { ...item('x').relations, blockedBy: ['ABC-100', 'ABC-99'] },
    });
    expect(readiness(subject, [item('ABC-99'), item('ABC-100')]).reasons).toEqual([
      'blocked by ABC-99',
      'blocked by ABC-100',
    ]);
  });

  it('names every reason, in a fixed order', () => {
    const subject = item('ABC-1', {
      size: undefined,
      description: '',
      labels: ['agent/needs-input'],
      relations: { ...item('x').relations, blockedBy: ['ABC-2'] },
    });
    expect(readiness(subject, [item('ABC-2')]).reasons).toEqual([
      'needs a size',
      'needs a done-when',
      'needs a decision (ABC-1)',
      'blocked by ABC-2',
    ]);
  });

  it('degrades on bad adapter data instead of throwing', () => {
    const junk = { identifier: 'ABC-1', description: 42, labels: 'x', relations: null };
    expect(() => readiness(junk as unknown as WorkItem)).not.toThrow();
    expect(readiness(junk as unknown as WorkItem).reasons).toEqual([
      'needs a size',
      'needs a done-when',
    ]);
  });
});
