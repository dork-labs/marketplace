import { describe, expect, it } from 'vitest';
import { diffBoards } from '../lib/changes.ts';
import { parseRoadmap, type Board } from '../lib/roadmap.ts';
import { itemsOf, sampleText } from './fixtures/roadmap.ts';

function board(edit?: (doc: Record<string, unknown>) => void): Board {
  const result = parseRoadmap(sampleText(edit));
  if (!result.ok) throw new Error('fixture does not parse');
  return result.board;
}

describe('diffBoards', () => {
  it('finds nothing when nothing changed', () => {
    expect(diffBoards(board(), board())).toEqual([]);
  });

  it('says the file was created when there was no earlier version', () => {
    expect(diffBoards(null, board())).toEqual([{ kind: 'created' }]);
  });

  it('says the version could not be read when it does not parse', () => {
    expect(diffBoards(board(), null)).toEqual([{ kind: 'unreadable' }]);
  });

  it('names a move between horizons', () => {
    const next = board((doc) => {
      itemsOf(doc)[2]!.horizon = 'now';
    });
    expect(diffBoards(board(), next)).toEqual([
      {
        kind: 'moved',
        id: '01HZZZZZZZZZZZZZZZZZZZZZA3',
        title: 'Fridge inventory by smell',
        from: 'next',
        to: 'now',
      },
    ]);
  });

  it('names a MoSCoW change, a status change, an added and a removed bet', () => {
    const next = board((doc) => {
      const items = itemsOf(doc);
      items[0]!.moscow = 'could';
      items[1]!.status = 'blocked';
      items.splice(3, 1);
      items.push({
        id: '01HZZZZZZZZZZZZZZZZZZZZZA9',
        kind: 'project',
        title: 'A new bet',
        horizon: 'later',
        moscow: 'could',
        owner: 'chef',
        status: 'exploring',
        why: 'Because.',
      });
    });
    expect(diffBoards(board(), next).map((c) => c.kind)).toEqual([
      'moscow',
      'status',
      'removed',
      'added',
    ]);
  });

  it('names an ask added and an ask removed, and never calls a removal an answer', () => {
    const next = board((doc) => {
      const items = itemsOf(doc);
      delete items[1]!.needs;
      items[2]!.needs = [
        {
          id: '01HZZZZZZZZZZZZZZZZZZZZZN7',
          kind: 'decision',
          ask: 'Which cheese counts as smelly?',
          askedBy: 'nose',
          thread: 'room:R1#E1',
        },
      ];
    });
    const changes = diffBoards(board(), next);
    expect(changes).toEqual([
      {
        kind: 'ask-removed',
        id: '01HZZZZZZZZZZZZZZZZZZZZZA2',
        title: 'Toaster that tells you the weather',
        ask: 'Let the toaster read the forecast',
      },
      {
        kind: 'asked',
        id: '01HZZZZZZZZZZZZZZZZZZZZZA3',
        title: 'Fridge inventory by smell',
        ask: 'Which cheese counts as smelly?',
      },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/approv|answer|yes/i);
  });

  it('notices a reorder within a column', () => {
    const next = board((doc) => {
      const items = itemsOf(doc);
      [items[0], items[1]] = [items[1]!, items[0]!];
    });
    expect(diffBoards(board(), next)).toEqual([{ kind: 'reordered', horizon: 'now' }]);
  });

  it('lists the other fields that changed as an edit', () => {
    const next = board((doc) => {
      const item = itemsOf(doc)[0]!;
      item.why = 'A sharper reason.';
      item.owner = 'chef';
    });
    expect(diffBoards(board(), next)).toEqual([
      {
        kind: 'edited',
        id: '01HZZZZZZZZZZZZZZZZZZZZZA1',
        title: 'Teach the kettle to whistle in tune',
        fields: ['owner', 'why'],
      },
    ]);
  });

  it('notices milestone changes', () => {
    const next = board((doc) => {
      (doc.milestones as Record<string, unknown>[])[0]!.date = '2030-03-09';
    });
    expect(diffBoards(board(), next)).toEqual([{ kind: 'milestones' }]);
  });
});
