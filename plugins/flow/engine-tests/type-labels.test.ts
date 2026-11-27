/**
 * The two type vocabularies (DOR-5069): flow's `type/*` labels and the bare
 * `Bug`, `Improvement` and `Feature` labels. A bare label flow implies is
 * always optional (written only when the team has it), `type/idea` implies
 * none (it is capture's placeholder), and a bare label a person set is never
 * removed by a reclassification.
 */

import { describe, expect, it } from 'vitest';

import { resolveTypes, typeChange } from '../scripts/type-labels.ts';

describe('resolveTypes (flow create)', () => {
  it.each([
    ['a bare Bug', ['Bug', 'origin/human'], ['Bug', 'origin/human', 'type/task'], []],
    ['a bare improvement, any case', ['improvement'], ['Improvement', 'type/task'], []],
    ['a bare Feature', ['Feature'], ['Feature', 'type/idea'], []],
    [
      'type/task: Improvement only if the team has it',
      ['type/task'],
      ['type/task'],
      ['Improvement'],
    ],
    ['type/idea: capture’s placeholder implies nothing', ['type/idea'], ['type/idea'], []],
    ['type/research: no bare name', ['type/research'], ['type/research'], []],
    ['both, agreeing', ['type/task', 'Bug'], ['type/task', 'Bug'], []],
    ['the same bare label twice, in two cases', ['Bug', 'bug'], ['Bug', 'type/task'], []],
  ])('%s', (_what, given, labels, optional) => {
    expect(resolveTypes(given)).toEqual({ labels, optional, problems: [] });
  });

  it('refuses two different bare types', () => {
    expect(resolveTypes(['Bug', 'Feature']).problems).toEqual([
      '"Bug" and "Feature" are both type labels, and an item takes one type',
    ]);
  });

  it.each([
    ['type/idea', 'Bug', 'type/task'],
    ['type/task', 'Feature', 'type/idea'],
    ['type/research', 'Improvement', 'type/task'],
  ])('refuses %s with %s: they name different types', (flow, bare, implied) => {
    expect(resolveTypes([flow, bare]).problems).toEqual([
      `"${flow}" and "${bare}" name different types ("${bare}" is a ${implied}): keep one`,
    ]);
  });
});

describe('typeChange (flow triage --type)', () => {
  it('swaps the bare label flow implied for the new one, the new one optional', () => {
    expect(typeChange(['type/task', 'Improvement', 'origin/human'], 'idea')).toEqual({
      change: { typeLabel: 'type/idea', dropLabels: ['Improvement'] },
      note: null,
    });
    expect(typeChange(['type/idea', 'origin/human'], 'task')).toEqual({
      change: { typeLabel: 'type/task', optionalLabels: ['Improvement'] },
      note: null,
    });
  });

  it('reads a bare label in any case, and drops it as the tracker spells it', () => {
    expect(typeChange(['type/task', 'improvement'], 'idea')).toEqual({
      change: { typeLabel: 'type/idea', dropLabels: ['improvement'] },
      note: null,
    });
    expect(typeChange(['type/idea', 'BUG'], 'task')).toEqual({
      change: { typeLabel: 'type/task' },
      note: null,
    });
  });

  it('keeps a bare label that already agrees with the new type', () => {
    expect(typeChange(['type/idea', 'Bug'], 'task')).toEqual({
      change: { typeLabel: 'type/task' },
      note: null,
    });
  });

  it('never removes a bare label a person set that disagrees: it leaves it and says so', () => {
    expect(typeChange(['type/task', 'Bug'], 'idea')).toEqual({
      change: { typeLabel: 'type/idea' },
      note: 'left "Bug" on it: a person set it, and it names a different type than type/idea',
    });
  });
});
