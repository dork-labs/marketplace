/**
 * The words on every ask (spec `flow-multiproject` §7.3, V8): a headline that
 * is an outcome or a question (never a command, a stage name or an item id),
 * a why line of 1-300 characters, the right buttons; the "While you were
 * away" rows (§7.10); and the offers (§7.8).
 */

import { describe, expect, it } from 'vitest';
import {
  FIX_IT_ANSWER,
  MAX_WHY,
  OFFER_TEXT,
  askKey,
  askProblem,
  safeAsk,
  ideasAsk,
  questionAsk,
  retryAsk,
  retryRecord,
  reviewAsk,
  shipRecord,
  signInAsk,
  sortRecord,
  type Ask,
  type AskProject,
} from '../lib/asks.ts';
import { clip, startRefusal, startWords } from '../lib/start-words.ts';

const PROJECT: AskProject = {
  name: 'dorkos',
  root: '/work/dorkos',
  id: '3f2a00000000',
  label: 'Linear DOR',
  tracker: 'Linear',
  link: '/x/flow/p/dorkos',
};

/** A structured question from `flow ask`. */
function question(extra: Partial<Parameters<typeof questionAsk>[1]['question'] & object> = {}) {
  return {
    text: 'Should the old API keep working?',
    choices: [
      { id: 'c1', label: 'Keep it' },
      { id: 'c2', label: 'Remove it' },
    ],
    pick: 'c1',
    why: "It's changing how sessions load.",
    askedAt: '2026-09-28T09:00:00.000Z',
    decideBy: '2026-09-28T17:00:00.000Z' as string | null,
    floor: [] as string[],
    answeredBy: 'person' as string | null,
    checkAfter: null as string | null,
    ...extra,
  };
}

/** Every ask a project can raise, in each shape. */
function everyAsk(): Ask[] {
  return [
    reviewAsk(PROJECT, {
      identifier: 'DOR-2387',
      title: 'The new out-of-usage banner',
      head: 'abcdef1234',
      pr: 2303,
      review: { verdict: 'clean', rounds: 1 },
      checks: 'passed',
      actionable: true,
    }),
    reviewAsk(PROJECT, {
      identifier: 'DOR-2387',
      title: null,
      head: null,
      pr: null,
      review: null,
      checks: null,
      actionable: false,
    }),
    questionAsk(PROJECT, {
      identifier: 'DOR-2401',
      title: 'Session loading',
      question: question(),
      parkedAt: null,
      actionable: true,
    }),
    questionAsk(PROJECT, {
      identifier: 'DOR-2401',
      title: 'Session loading',
      question: null,
      parkedAt: '2026-09-28T09:00:00.000Z',
      actionable: true,
    }),
    signInAsk(PROJECT, '2026-09-28T09:14:00.000Z', true),
    ideasAsk(PROJECT, 12, '2026-09-27T09:00:00.000Z', true),
    retryAsk(PROJECT, {
      identifier: 'DOR-2410',
      title: 'Faster sidebar',
      parkedAt: '2026-09-28T09:00:00.000Z',
      actionable: true,
    }),
  ];
}

describe('every ask', () => {
  it('has a headline with no item id, stage name or command, and a why line within 300', () => {
    for (const ask of everyAsk()) {
      const { title, why } = ask.input;
      expect(askProblem(ask.input)).toBeNull();
      expect(title).not.toMatch(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/);
      expect(title).not.toMatch(/\b(TRIAGE|EXECUTE|VERIFY|REVIEW|DONE|SPECIFY)\b/);
      expect(title.startsWith('/')).toBe(false);
      expect(why.length).toBeGreaterThan(0);
      expect(why.length).toBeLessThanOrEqual(MAX_WHY);
      // Every link is an in-app path: core refuses anything else.
      expect(ask.input.link).toBe('/x/flow/p/dorkos');
      const actions = ask.input.actions;
      if (actions.kind === 'word' && actions.href !== undefined) {
        expect(actions.href.startsWith('/x/flow/')).toBe(true);
      }
      expect(ask.input.project).toBe('/work/dorkos');
      expect(ask.input.projectLabel).toBe('Linear DOR');
    }
  });

  it('never drops an ask whose words break a rule: plain words stand in, the rest goes behind ⓘ', () => {
    const spend = questionAsk(PROJECT, {
      identifier: 'DOR-9',
      title: null,
      parkedAt: null,
      actionable: true,
      question: question({
        text: 'Should I pay for the Review plan?',
        floor: ['secrets-or-spend'],
      }),
    });
    expect(askProblem(spend.input)).toBe('the headline names a stage');
    const safe = safeAsk(spend);
    expect(askProblem(safe.input)).toBeNull();
    expect(safe.input.title).toBe('A question needs you in dorkos');
    expect(safe.input.detail).toContain('Should I pay for the Review plan?');
    expect(safe.input.actions).toEqual(spend.input.actions);
    expect(safe.key).toBe(spend.key);
    const noWhy = safeAsk({ ...spend, input: { ...spend.input, why: '' } });
    expect(askProblem(noWhy.input)).toBeNull();
  });

  it('refuses an ask with no why line, or a headline that is an id or a command', () => {
    expect(askProblem({ title: 'Ship it?', why: '' })).toBe('the ask has no why line');
    expect(askProblem({ title: 'Ship it?', why: '   ' })).toBe('the ask has no why line');
    expect(askProblem({ title: 'Ship DOR-12?', why: 'x' })).toBe('the headline carries an item id');
    expect(askProblem({ title: '/flow:triage', why: 'x' })).toBe('the headline is a command');
    expect(askProblem({ title: 'Move to EXECUTE?', why: 'x' })).toBe('the headline names a stage');
    expect(askProblem({ title: 'Move it to execute?', why: 'x' })).toBe(
      'the headline names a stage'
    );
    expect(askProblem({ title: 'x'.repeat(121), why: 'x' })).toMatch(/longer than 120/);
    expect(askProblem({ title: 'Ship it?', why: 'x'.repeat(301) })).toMatch(/longer than 300/);
  });

  it('keys each ask by project and item, never by a path', () => {
    expect(askKey('review', '3f2a00000000', 'DOR-2387')).toBe('review:3f2a00000000:DOR-2387');
    expect(askKey('sign-in', '3f2a00000000')).toBe('tracker:3f2a00000000');
    expect(askKey('ideas', '3f2a00000000')).toBe('idle:3f2a00000000');
    for (const ask of everyAsk()) {
      expect(ask.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
      expect(ask.key).not.toContain('/');
    }
  });
});

describe('the review gate', () => {
  it('asks "Ship <title>?" with Ship it / Send it back, a note, and the commit it showed', () => {
    const [ask] = everyAsk();
    expect(ask.input.title).toBe('Ship The new out-of-usage banner?');
    expect(ask.input.why).toBe(
      "It's built, tests pass, and the reviewer agent found nothing. Shipping merges it into the app."
    );
    expect(ask.input.detail).toBe('DOR-2387 · PR #2303 · at abcdef1');
    expect(ask.input.actions).toEqual({
      kind: 'yes-no',
      approveLabel: 'Ship it',
      rejectLabel: 'Send it back',
      rejectAsksForNote: true,
    });
    expect(ask.head).toBe('abcdef1234');
    expect(ask.answerIn).toBe('activity');
  });

  it('says "Ship this change?" without a title, and opens the project page when flow cannot act', () => {
    const ask = everyAsk()[1];
    expect(ask.input.title).toBe('Ship this change?');
    expect(ask.input.detail).toBe('DOR-2387');
    expect(ask.input.actions).toEqual({ kind: 'word', label: 'Open', href: '/x/flow/p/dorkos' });
  });

  it('words fixed findings and running checks from the facts, and takes an id out of a title', () => {
    const facts = {
      identifier: 'DOR-1',
      title: 'DOR-1 Faster sidebar',
      head: null,
      pr: null,
      checks: null,
      actionable: true,
    } as const;
    expect(
      reviewAsk(PROJECT, { ...facts, review: { verdict: 'clean', rounds: 3 } }).input.why
    ).toBe(
      "It's built. The reviewer agent raised points and they were fixed. Shipping merges it into the app."
    );
    expect(reviewAsk(PROJECT, { ...facts, review: null, checks: 'running' }).input.why).toBe(
      "It's built; tests are still running. Shipping merges it once they pass."
    );
    expect(reviewAsk(PROJECT, { ...facts, review: null }).input.title).toBe('Ship Faster sidebar?');
  });
});

describe("an agent's question", () => {
  it("offers the chips with the agent's pick and the deadline flow ask stored", () => {
    const tell = everyAsk()[2];
    expect(tell.input.title).toBe('Should the old API keep working?');
    expect(tell.input.why).toBe(
      `It's changing how sessions load. If you don't answer by the deadline, it goes with "Keep it".`
    );
    expect(tell.input.actions).toEqual({
      kind: 'choice',
      choices: [
        { id: 'c1', label: 'Keep it' },
        { id: 'c2', label: 'Remove it' },
      ],
      allowReply: true,
      defaultChoice: 'c1',
      decideBy: '2026-09-28T17:00:00.000Z',
    });
    expect(tell.answerIn).toBe('flow');
  });

  it('names no deadline for a floor question, or at Ask me first, and sends a floor question to Activity', () => {
    const base = {
      identifier: 'DOR-2401',
      title: null,
      parkedAt: null,
      actionable: true,
    };
    const floor = questionAsk(PROJECT, {
      ...base,
      question: question({ floor: ['outward-facing'], decideBy: null }),
    });
    expect(floor.input.why).toMatch(/It won't go ahead until someone checks\.$/);
    expect(floor.input.actions).not.toHaveProperty('decideBy');
    expect(floor.input.actions).not.toHaveProperty('defaultChoice');
    expect(floor.answerIn).toBe('activity');
    expect(floor.floor).toBe(true);
    const ask = questionAsk(PROJECT, { ...base, question: question({ decideBy: null }) });
    expect(ask.input.why).toMatch(/It won't go ahead until you answer\.$/);
    expect(ask.input.actions).not.toHaveProperty('decideBy');
  });

  it('words who answers from what flow ask stored, not from the dial now', () => {
    const base = { identifier: 'DOR-2401', title: null, parkedAt: null, actionable: true };
    // Asked at Ask me first: no deadline stored, so it waits for you whatever the dial says now.
    const waits = questionAsk(PROJECT, { ...base, question: question({ decideBy: null }) });
    expect(waits.deadline).toBeNull();
    expect(waits.input.why).toMatch(/until you answer\.$/);
    // Asked at Tell me after: the stored deadline stands, and says so.
    const timed = questionAsk(PROJECT, { ...base, question: question() });
    expect(timed.deadline).toBe('2026-09-28T17:00:00.000Z');
    expect(timed.input.why).toMatch(/by the deadline, it goes with "Keep it"\.$/);
    expect(timed.input.why).not.toMatch(/\d:\d\d/);
    // A floor question at Tell me after: the reviewer agent checks, not the agent's pick.
    const checked = questionAsk(PROJECT, {
      ...base,
      question: question({
        floor: ['outward-facing'],
        decideBy: null,
        checkAfter: '2026-09-28T13:00:00.000Z',
      }),
    });
    expect(checked.input.why).toMatch(/the reviewer agent checks the agent's pick\.$/);
    expect(checked.input.why).not.toMatch(/goes with/);
    expect(checked.deadline).toBeNull();
    // A spend: only you, ever.
    const spend = questionAsk(PROJECT, {
      ...base,
      question: question({ floor: ['secrets-or-spend'], decideBy: '2026-09-28T17:00:00.000Z' }),
    });
    expect(spend.personOnly).toBe(true);
    expect(spend.deadline).toBeNull();
    expect(spend.input.why).toMatch(/Only you can answer this one\.$/);
    expect(spend.input.actions).not.toHaveProperty('decideBy');
  });

  it('takes every item id out of a question, not just the first', () => {
    const ask = questionAsk(PROJECT, {
      identifier: 'DOR-1',
      title: null,
      parkedAt: null,
      actionable: true,
      question: question({ text: 'Merge DOR-1 before DOR-2?' }),
    });
    expect(ask.input.title).toBe('Merge this before this?');
    expect(askProblem(ask.input)).toBeNull();
  });

  it('reads an older engine’s question as "An agent needs an answer on <title>" with Reply', () => {
    const older = everyAsk()[3];
    expect(older.input.title).toBe('An agent needs an answer on Session loading');
    expect(older.input.actions).toEqual({
      kind: 'word',
      label: 'Reply',
      input: { placeholder: 'Your answer', maxLength: 2000 },
    });
  });

  it('keeps the why within 300 even when the agent wrote a long one', () => {
    const long = questionAsk(PROJECT, {
      identifier: 'DOR-1',
      title: null,
      question: question({ why: 'w'.repeat(400) }),
      parkedAt: null,
      actionable: true,
    });
    expect(long.input.why.length).toBeLessThanOrEqual(300);
    expect(long.input.why).toMatch(/goes with "Keep it"\.$/);
  });
});

describe('the other asks', () => {
  it('words sign-in, ideas waiting and retry as the spec does', () => {
    const [, , , , signIn, ideas, retry] = everyAsk();
    expect(signIn.input.title).toBe('Sign in to Linear again');
    expect(signIn.input.why).toBe(
      "Flow can't read or update dorkos's work in Linear until you do. Nothing is lost; it's waiting."
    );
    expect(signIn.input.actions).toEqual({ kind: 'word', label: 'Sign in' });
    expect(signIn.input.since).toBe('2026-09-28T09:14:00.000Z');
    expect(ideas.input.title).toBe("12 new ideas haven't been sorted");
    expect(ideas.input.why).toBe(
      'Flow has had nothing ready to work on in dorkos for a day. Sorting them lets it pick up the good ones.'
    );
    expect(ideas.input.actions).toEqual({ kind: 'word', label: 'Sort them' });
    expect(retry.input.title).toBe('Try fixing the failing checks on Faster sidebar?');
    expect(retry.input.actions).toEqual({
      kind: 'yes-no',
      approveLabel: 'Fix it',
      rejectLabel: 'Leave it',
    });
    expect(FIX_IT_ANSWER).toMatch(/fix/);
  });

  it('opens the project page where DorkOS cannot start work, keeping the outcome word', () => {
    expect(signInAsk(PROJECT, '2026-09-28T09:14:00.000Z', false).input.actions).toEqual({
      kind: 'word',
      label: 'Sign in',
      href: '/x/flow/p/dorkos',
    });
    expect(ideasAsk(PROJECT, 1, '2026-09-27T09:00:00.000Z', false).input.title).toBe(
      "1 new idea hasn't been sorted"
    );
  });
});

describe('"While you were away" and the offers', () => {
  it('says who decided and what was chosen, unread at Tell me after and quiet at Just do it', () => {
    const shipped = shipRecord(PROJECT, {
      identifier: 'DOR-9',
      title: 'New sidebar',
      stop: 'tell',
    });
    expect(shipped).toMatchObject({
      title: 'Ship New sidebar?',
      outcome: 'approved',
      by: { kind: 'agent', label: 'the reviewer agent' },
      choiceLabel: 'Shipped',
      tell: true,
      link: '/x/flow/p/dorkos',
    });
    expect(shipped.why.length).toBeGreaterThan(0);
    expect(sortRecord(PROJECT, 'auto', 12)).toMatchObject({
      title: "12 new ideas haven't been sorted",
      by: { kind: 'rule', label: "your 'Just do it' setting" },
      tell: false,
    });
    expect(retryRecord(PROJECT, { identifier: 'DOR-3', title: null, stop: 'tell' }).by).toEqual({
      kind: 'rule',
      label: "your 'Tell me after' setting",
    });
  });

  it('offers each kind in the spec’s words, within 160 characters', () => {
    expect(OFFER_TEXT.ship).toBe(
      'Shipped. Next time, ship on its own when the reviewer agent approves?'
    );
    for (const text of Object.values(OFFER_TEXT)) expect(text.length).toBeLessThanOrEqual(160);
  });
});

describe('the words that start work', () => {
  it('gives each button a plain title, a reason and a prompt, within DorkOS’s limits', () => {
    for (const kind of ['set-up', 'connect', 'sort', 'sign-in', 'daily-sort'] as const) {
      const words = startWords(kind, { name: 'dorkos', tracker: 'Linear', count: 12 });
      expect(words.title.length).toBeGreaterThan(0);
      expect(words.title.length).toBeLessThanOrEqual(80);
      expect(words.reason.length).toBeLessThanOrEqual(200);
      expect(words.watch.length).toBeLessThanOrEqual(40);
      expect(words.title.startsWith('/')).toBe(false);
      expect(words.prompt.length).toBeLessThanOrEqual(20_000);
    }
    expect(startWords('sort', { name: 'dorkos', count: 12 })).toMatchObject({
      title: 'Sorting 12 new ideas in dorkos',
      reason: '12 new ideas were waiting to be sorted',
      prompt: '/flow:triage',
      watch: 'Sorting 12 ideas…',
    });
    expect(startWords('sign-in', { name: 'dorkos', tracker: 'Linear' })).toMatchObject({
      title: 'Signing in to Linear for dorkos',
      reason: "Linear stopped accepting flow's sign-in",
    });
    expect(startWords('daily-sort', { name: 'dorkos' }).reason).toBe(
      'Your settings sort new ideas every morning'
    );
    expect(clip('x'.repeat(100), 80)).toHaveLength(80);
  });

  it('says why a start was refused, pointing at the project’s settings for accounts', () => {
    expect(
      startRefusal('account_not_allowed_here', 'No account may work in dorkos.', 'dorkos')
    ).toBe("No account may work in dorkos. Choose accounts in dorkos's Flow settings.");
    expect(startRefusal('start_limit', '', 'dorkos')).toMatch(/Try again/);
    expect(startRefusal('weird', 'x', 'dorkos')).toBe("Flow couldn't start that. Try again.");
  });
});
