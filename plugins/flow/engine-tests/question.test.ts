/**
 * An agent's question with its pick and a deadline (spec `flow-multiproject`
 * §7.5, `scripts/question.ts`): the limits that let DorkOS raise it as a
 * one-click choice, and when the pick may stand in for an answer.
 */

import { describe, expect, it } from 'vitest';

import type { RunQuestion } from '../scripts/flow-run.ts';
import {
  choicesOf,
  formatWhen,
  pickComment,
  parkedAnswer,
  pickIsDue,
  questionComment,
  questionProblem,
} from '../scripts/question.ts';

const NOW = new Date('2026-09-28T12:00:00.000Z');
/** When the park the test questions belong to began: when they were asked. */
const SINCE = NOW.toISOString();

const ok = {
  text: 'Should the old API keep working?',
  labels: ['Keep it', 'Drop it'],
  pick: 1,
  why: 'It changes how sessions load; keeping it is the safer choice.',
  decideBy: null,
};

function question(overrides: Partial<RunQuestion> = {}): RunQuestion {
  return {
    text: ok.text,
    choices: choicesOf(ok.labels),
    pick: 'c1',
    why: ok.why,
    askedAt: NOW.toISOString(),
    decideBy: '2026-09-28T17:00:00.000Z',
    floor: [],
    answeredBy: 'person',
    checkAfter: null,
    ...overrides,
  };
}

describe('questionProblem', () => {
  it('accepts a question DorkOS can show as one-click choices', () => {
    expect(questionProblem(ok, NOW)).toBeNull();
  });

  // Purpose: each limit is DorkOS's, so a question flow parks can always be
  // raised in the inbox; each refusal names the fix.
  it.each([
    ['one choice', { labels: ['Keep it'] }, /2 to 5 choices/],
    ['six choices', { labels: ['a', 'b', 'c', 'd', 'e', 'f'] }, /2 to 5 choices/],
    ['a choice over 40 characters', { labels: ['x'.repeat(41), 'y'] }, /longer than 40/],
    ['a pick out of range', { pick: 3 }, /--pick/],
    ['no why', { why: ' ' }, /--why/],
    ['a why over 300 characters', { why: 'w'.repeat(301) }, /300/],
    ['the same choice twice', { labels: ['Keep it', 'keep it'] }, /same thing/],
    ['a deadline in 4 minutes', { decideBy: '2026-09-28T12:04:00.000Z' }, /5 minutes and 7 days/],
    ['a deadline in 8 days', { decideBy: '2026-10-06T12:00:00.000Z' }, /5 minutes and 7 days/],
    ['an empty question', { text: '' }, /empty/],
  ])('refuses %s', (_name, change, message) => {
    expect(questionProblem({ ...ok, ...change }, NOW)).toMatch(message);
  });
});

describe('the words', () => {
  // Purpose: the comment marks the agent's pick and says what happens without
  // an answer, so a person reading the tracker knows the stakes.
  it('marks the pick and names the deadline', () => {
    const text = questionComment(question());
    expect(text).toContain('1. Keep it (my pick)');
    expect(text).toContain('2. Drop it');
    expect(text).toContain(
      `If you don't answer by ${formatWhen('2026-09-28T17:00:00.000Z')}, I'll go with "Keep it".`
    );
    expect(questionComment(question({ decideBy: null }))).toContain(
      "I won't go ahead until you answer."
    );
  });

  it('writes times the same on every machine', () => {
    expect(formatWhen('2026-09-28T17:05:00.000Z')).toBe('Sep 28, 17:05 UTC');
  });

  it('says who settled it when the pick stands', () => {
    expect(pickComment(question(), 'agent-default')).toBe(
      'No answer by Sep 28, 17:00 UTC, so going with "Keep it" (the agent\'s pick).'
    );
    expect(pickComment(question(), 'reviewer-agent')).toContain('reviewer agent checked');
  });
});

describe('pickIsDue', () => {
  // Purpose: the pick stands only after the deadline, only once, and never for
  // a floor question.
  it('is due at the deadline and not before', () => {
    expect(pickIsDue(question(), new Date('2026-09-28T16:59:59.000Z'))).toBe(false);
    expect(pickIsDue(question(), new Date('2026-09-28T17:00:00.000Z'))).toBe(true);
  });

  it('is never due without a deadline, once answered, or on the floor', () => {
    const later = new Date('2026-09-29T00:00:00.000Z');
    expect(pickIsDue(question({ decideBy: null }), later)).toBe(false);
    expect(
      pickIsDue(
        question({ answer: { text: 'Drop it', at: later.toISOString(), by: 'person' } }),
        later
      )
    ).toBe(false);
    expect(pickIsDue(question({ floor: ['outward-facing'] }), later)).toBe(false);
  });
});

describe('parkedAnswer', () => {
  // Purpose: the drain resumes a parked run on an answer `flow answer`
  // recorded (a person's from DorkOS, which reads as the agent's own comment
  // when flow posts through the agent's own account), and takes a due pick.
  it('resumes on a recorded answer, takes a due pick, and otherwise waits', () => {
    const later = new Date('2026-09-28T18:00:00.000Z');
    expect(parkedAnswer(undefined, later, SINCE)).toBeNull();
    expect(parkedAnswer(question(), NOW, SINCE)).toBeNull();
    expect(parkedAnswer(question(), later, SINCE)).toBe('take-pick');
    expect(parkedAnswer(question({ floor: ['scope-change'] }), later, SINCE)).toBeNull();
    expect(
      parkedAnswer(
        question({ answer: { text: 'Drop it', at: NOW.toISOString(), by: 'person' } }),
        NOW,
        SINCE
      )
    ).toBe('recorded');
  });
});

describe('review fixes (DOR-2528 FIX-FIRST)', () => {
  const answered = (at: string) => question({ answer: { text: 'Drop it', at, by: 'person' } });

  // Finding 1: an old question's answer must never release a later park. The
  // question belongs to the park only when it was asked at or after the park
  // began; a later park (review rounds, failing checks) is nobody's answer.
  it('releases only the park the question was asked for', () => {
    const later = '2026-09-28T13:00:00.000Z';
    expect(parkedAnswer(answered('2026-09-28T12:30:00.000Z'), NOW, later)).toBeNull();
    expect(parkedAnswer(question(), new Date('2026-09-29T00:00:00.000Z'), later)).toBeNull();
    expect(parkedAnswer(answered('2026-09-28T12:30:00.000Z'), NOW, NOW.toISOString())).toBe(
      'recorded'
    );
    // An answer recorded before the question was asked answers something else.
    expect(parkedAnswer(answered('2026-09-28T11:00:00.000Z'), NOW, NOW.toISOString())).toBeNull();
  });

  // Finding 9: at Tell me after a floor question is checked by the reviewer
  // agent after the wait; the comment must say so, not "until you answer".
  it('tells a floor question at Tell me after that the reviewer agent checks it after the wait', () => {
    const text = questionComment(
      question({
        decideBy: null,
        floor: ['outward-facing'],
        answeredBy: 'person',
        checkAfter: '2026-09-28T16:00:00.000Z',
      })
    );
    expect(text).toContain('the reviewer agent checks my pick after Sep 28, 16:00 UTC');
    expect(text).not.toContain('until you answer');
  });

  // Finding 7: the drain hands a due floor question to the reviewer agent, once,
  // and never one about secrets or spending.
  it('hands a due floor question to the reviewer agent, never a spend', () => {
    const floorQ = question({
      decideBy: null,
      floor: ['outward-facing'],
      checkAfter: '2026-09-28T13:00:00.000Z',
    });
    const at = new Date('2026-09-28T14:00:00.000Z');
    expect(parkedAnswer(floorQ, at, NOW.toISOString())).toBe('check-pick');
    expect(parkedAnswer(floorQ, NOW, NOW.toISOString())).toBeNull();
    expect(parkedAnswer({ ...floorQ, checkTokenHash: 'h' }, at, NOW.toISOString())).toBeNull();
    expect(
      parkedAnswer(
        { ...floorQ, floor: ['outward-facing', 'secrets-or-spend'] },
        at,
        NOW.toISOString()
      )
    ).toBeNull();
  });
});
