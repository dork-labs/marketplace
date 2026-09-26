/**
 * `findAnswer` (spec `flow-handoff-dispatch` §4.4 "Park"): which reply answers
 * a parked drain run, by the shared comment-response rules.
 */

import { describe, expect, it } from 'vitest';

import { answerPointer, findAnswer, type AnswerContext } from '../../scripts/drain/answer.ts';
import type { ItemComment, WorkItem } from '../../scripts/tracker/types.ts';

const ITEM = {
  id: 'id-A-1',
  identifier: 'A-1',
  title: 't',
  description: '',
  type: 'task',
  stateCategory: 'started',
  stateName: 'In Progress',
  parent: null,
  relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
  labels: ['agent/needs-input'],
  agentDisposition: 'needs-input',
} as unknown as WorkItem;

const CTX: AnswerContext = {
  identity: { agent: 'bot', marker: '— 🤖 /flow' },
  ownership: 'mine',
  comments: { respondWhen: 'addressed', ambiguousBias: 'quiet' } as AnswerContext['comments'],
};

const c = (id: string, author: string, minute: number, body = `says ${id}`): ItemComment => ({
  id,
  author,
  body,
  createdAt: new Date(Date.UTC(2026, 8, 26, 12, minute)).toISOString(),
});

describe('findAnswer', () => {
  // Purpose: only a person's reply after the park counts, newest first.
  it('takes the newest non-agent reply after the park', () => {
    const since = c('x', 'x', 10).createdAt;
    const comments = [
      c('old', 'dorian', 5),
      c('own', 'bot', 11),
      c('a', 'dorian', 12),
      c('b', 'kai', 13),
    ];
    expect(findAnswer(ITEM, comments, since, CTX)?.id).toBe('b');
    expect(findAnswer(ITEM, comments.slice(0, 2), since, CTX)).toBeNull();
    // An answer stays an answer after the agent's own follow-up note.
    const noted = [c('a', 'dorian', 12), c('note', 'bot', 13)];
    expect(findAnswer(ITEM, noted, since, CTX)?.id).toBe('a');
  });

  // Purpose: the agent's own comment is never an answer, by author or by its marker.
  it('ignores the agent, by account or by marker', () => {
    const since = c('x', 'x', 0).createdAt;
    const marked = c('m', 'shared', 3, 'Waiting on you.\n\n— 🤖 /flow');
    expect(findAnswer(ITEM, [c('own', 'bot', 2), marked], since, CTX)).toBeNull();
  });

  // Purpose: a park from before parks were timed reads replies after the agent's question.
  it('with no park time, counts only replies after the agent’s latest comment', () => {
    const comments = [c('early', 'dorian', 1), c('q', 'bot', 2), c('late', 'dorian', 3)];
    expect(findAnswer(ITEM, comments, null, CTX)?.id).toBe('late');
    expect(findAnswer(ITEM, comments.slice(0, 2), null, CTX)).toBeNull();
    expect(answerPointer(comments[2], 'A-1')).toBe(
      `the comment by dorian on A-1 at ${comments[2].createdAt}`
    );
  });
});
