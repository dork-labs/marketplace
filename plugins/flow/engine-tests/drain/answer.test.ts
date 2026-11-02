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

/** Authors the fake tracker would not vouch for: a guest and an integration. */
const OUTSIDERS = new Set(['guest', 'integration']);

const c = (id: string, author: string, minute: number, body = `says ${id}`): ItemComment => ({
  id,
  author,
  authorIsTrusted: author !== '' && !OUTSIDERS.has(author),
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
    const noted = [c('park', 'bot', 10), c('a', 'dorian', 12), c('note', 'bot', 13)];
    expect(findAnswer(ITEM, noted, since, CTX)?.id).toBe('a');
  });

  // Purpose: parkedAt is the local clock and reply times are the tracker's. With
  // the local clock four minutes ahead, a reply made one minute after the park
  // comment still counts, because the park comment anchors the search. Fails
  // if replies are compared with parkedAt alone.
  it('anchors on the park comment when the local clock runs ahead', () => {
    const since = c('x', 'x', 10).createdAt;
    const comments = [c('park', 'bot', 6), c('reply', 'dorian', 7)];
    expect(findAnswer(ITEM, comments, since, CTX)?.id).toBe('reply');
  });

  // Purpose: a run that parks twice within minutes must wait for an answer to
  // the second question. Fails if the anchor is the first park's comment: the
  // reply to the first question would resume the run at once.
  it('anchors a second park on its own comment, not the first', () => {
    const since = c('x', 'x', 15).createdAt;
    const comments = [c('park1', 'bot', 10), c('reply1', 'dorian', 12), c('park2', 'bot', 15)];
    expect(findAnswer(ITEM, comments, since, CTX)).toBeNull();
    const answered = [...comments, c('reply2', 'dorian', 16)];
    expect(findAnswer(ITEM, answered, since, CTX)?.id).toBe('reply2');
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

  // Purpose (DOR-3669): only a team member's reply resumes a parked run. A
  // guest, an integration and a comment with no author are each left alone,
  // the run stays parked, and each one is reported so a person can see why.
  // Fails if any of them is taken as the answer.
  it.each([
    ['a guest', 'guest'],
    ['an integration', 'integration'],
    ['a comment with no author', ''],
  ])('never takes %s as the answer, and reports it', (_who, author) => {
    const since = c('x', 'x', 10).createdAt;
    const skipped: string[] = [];
    const ctx = { ...CTX, onUntrusted: (comment: ItemComment) => skipped.push(comment.id) };
    const comments = [c('park', 'bot', 10), c('outsider', author, 12, 'go with B')];
    expect(findAnswer(ITEM, comments, since, ctx)).toBeNull();
    expect(skipped).toEqual(['outsider']);
    // A member's earlier reply still counts past an outsider's later one.
    const both = [c('park', 'bot', 10), c('member', 'dorian', 11), comments[1]];
    expect(findAnswer(ITEM, both, since, ctx)?.id).toBe('member');
  });

  // Purpose: an adapter older than contract 3.0.0 sends no signal; that is untrusted.
  it('treats a comment with no authorIsTrusted as untrusted', () => {
    const since = c('x', 'x', 10).createdAt;
    const { authorIsTrusted: _drop, ...bare } = c('old', 'dorian', 12);
    expect(findAnswer(ITEM, [bare as ItemComment], since, CTX)).toBeNull();
  });
});
