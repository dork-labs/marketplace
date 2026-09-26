/**
 * The drain reducer (spec `flow-handoff-dispatch` §4.4, task 3.4): one case per
 * row of the phase table asserting the next phase and the exact action list, a
 * property sweep proving no step creates a PR and `open-pr` goes out only with
 * a clean verdict at the origin head, and the messages rendering whole.
 */

import { describe, expect, it } from 'vitest';

import {
  drainStep,
  PARK_REASONS,
  type DrainAction,
  type DrainFacts,
  type DrainStepConfig,
  type PrStatusFact,
} from '../../scripts/drain/drain-step.ts';
import {
  MESSAGE_KINDS,
  render,
  type MessageContexts,
  type MessageKind,
} from '../../scripts/drain/messages.ts';
import type {
  DrainPullRequest,
  DrainReviewerHandle,
  DrainState,
  DrainWorkerHandle,
  RunLimit,
} from '../../scripts/drain/state.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { DRAIN_PHASES } from '../../scripts/drain/state.ts';

const FLOW = 'node --experimental-strip-types /opt/flow/scripts/flow.ts';
const CFG: DrainStepConfig = { maxReviewRounds: 5, startTimeoutMs: 90_000, flow: FLOW };
const NOW = new Date('2026-09-26T12:00:00.000Z');
const S = 'aaaaaaa1111111111111111111111111111111111';
const S2 = 'bbbbbbb2222222222222222222222222222222222';
const HEAD_PR = 'ccccccc3333333333333333333333333333333333';

/** A started worker written before launchers were runtime-aware (no `runtime`). */
const WORKER: DrainWorkerHandle = {
  host: 'cli',
  sessionId: 'w-1',
  account: 'claude3',
  cwd: '/work/ABC-1',
};

/** A started reviewer at `sha`. */
function reviewer(sha: string): DrainReviewerHandle {
  return {
    host: 'cli',
    runtime: 'codex',
    sessionId: 'r-1',
    account: 'claude4',
    cwd: '/work/review-ABC-1',
    sha,
    worktree: '/work/review-ABC-1',
    tokenHash: 'sha256:x',
  };
}

const PR: DrainPullRequest = {
  repo: 'acme/app',
  number: 88,
  url: 'https://github.com/acme/app/pull/88',
  armed: false,
  disarmedForReview: false,
};

/** The stop action for the worker, runtime filled in as claude-code. */
const STOP_WORKER: DrainAction = {
  kind: 'stop',
  which: 'worker',
  handle: { ...WORKER, runtime: 'claude-code' },
};

/** The stop action for a reviewer at `sha`. */
function stopReviewer(sha: string): DrainAction {
  return { kind: 'stop', which: 'reviewer', handle: { ...reviewer(sha), runtime: 'codex' } };
}

/** A drain state in `phase`, with overrides. */
function drain(phase: DrainState['phase'], over: Partial<DrainState> = {}): DrainState {
  return {
    v: 1,
    rev: 3,
    phase,
    worker: WORKER,
    reviewer: null,
    pushedSha: null,
    reviewedSha: null,
    verdict: null,
    reviewRound: 0,
    pr: null,
    rearmedFor: null,
    nudges: 0,
    wakeAfter: null,
    handoffs: [],
    parkedReason: null,
    ...over,
  };
}

/** A running run carrying `d`. */
function run(d: DrainState, over: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'i-1',
    identifier: 'ABC-1',
    sessionId: 'w-1',
    worktreePath: '/work/ABC-1',
    branch: 'ABC-1-export-csv',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: -1,
    startedAt: '2026-09-26T11:00:00.000Z',
    drain: d,
    ...over,
  };
}

/** Facts for `d`: the reports as recorded, a busy worker, the item held. */
function facts(d: DrainState, over: Partial<DrainFacts> = {}): DrainFacts {
  return {
    prForBranch: null,
    queuedAgeMs: null,
    worker: { kind: 'busy' },
    reviewer: null,
    reports: {
      pushedSha: d.pushedSha,
      verdict: d.verdict,
      reviewedSha: d.reviewedSha,
      reviewRound: d.reviewRound,
      pr: d.pr,
    },
    originHead: d.pushedSha,
    pr: null,
    ejection: null,
    item: { closed: false, claimed: true, needsInput: false, title: 'Export the report as CSV' },
    runComplete: false,
    ...over,
  };
}

/** An open PR status. */
function prStatus(over: Partial<PrStatusFact> = {}): PrStatusFact {
  return { state: 'open', failing: [], armed: true, queued: false, headSha: S, ...over };
}

/** Run one step. */
function step(d: DrainState, f: Partial<DrainFacts> = {}, r: Partial<FlowRun> = {}) {
  const out = drainStep(run(d, r), facts(d, f), CFG, NOW);
  return { drain: out.run.drain!, actions: out.actions, run: out.run };
}

const BASE = { flow: FLOW, identifier: 'ABC-1' };

describe('drainStep: the phase table', () => {
  // working + a reported push S: the review starts at S.
  it('working + pushed S -> reviewing, start a reviewer at S', () => {
    const out = step(drain('working', { pushedSha: S }));
    expect(out.drain.phase).toBe('reviewing');
    expect(out.actions).toEqual([{ kind: 'start-reviewer', sha: S, deltaFrom: null }]);
  });

  // working + the worker idle or exited with no push: one continue per stop.
  it.each(['idle', 'exited'] as const)(
    'working + worker %s, nudges < 2 -> working, send continue, nudges + 1',
    (kind) => {
      const worker = kind === 'idle' ? { kind } : { kind, code: 0 };
      const out = step(drain('working', { nudges: 1 }), { worker });
      expect(out.drain.phase).toBe('working');
      expect(out.drain.nudges).toBe(2);
      expect(out.actions).toEqual([{ kind: 'send', message: 'continue', ctx: BASE }]);
    }
  );

  // working + a third stop: park.
  it('working + worker stopped, nudges = 2 -> parked', () => {
    const out = step(drain('working', { nudges: 2 }), { worker: { kind: 'idle' } });
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(PARK_REASONS.workerStopped);
    expect(out.actions).toEqual([
      STOP_WORKER,
      { kind: 'park', reason: PARK_REASONS.workerStopped, trackerWrite: true },
    ]);
  });

  // reviewing + clean at the origin head, no PR: tell the worker to open one.
  it('reviewing + clean at S == origin head, no PR -> pr-ready, stop reviewer, send open-pr', () => {
    const d = drain('reviewing', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 1,
      reviewer: reviewer(S),
      nudges: 1,
    });
    const out = step(d);
    expect(out.drain.phase).toBe('pr-ready');
    expect(out.drain.nudges).toBe(0);
    expect(out.drain.reviewer).toBeNull();
    expect(out.actions).toEqual([
      stopReviewer(S),
      {
        kind: 'send',
        message: 'open-pr',
        ctx: { ...BASE, sha: S, title: 'Export the report as CSV' },
      },
    ]);
  });

  // reviewing + clean at the head with a PR: back to watching, re-armed if flow disarmed it.
  it.each([
    [true, [stopReviewer(S), { kind: 'arm', pr: { repo: 'acme/app', number: 88 }, sha: S }]],
    [false, [stopReviewer(S)]],
  ] as const)(
    'reviewing + clean at S == head, PR exists (disarmedForReview %s) -> watching',
    (disarmed, actions) => {
      const d = drain('reviewing', {
        pushedSha: S,
        reviewedSha: S,
        verdict: 'clean',
        reviewRound: 2,
        reviewer: reviewer(S),
        pr: { ...PR, disarmedForReview: disarmed },
      });
      const out = step(d, { pr: prStatus({ armed: false, headSha: S }) });
      expect(out.drain.phase).toBe('watching');
      expect(out.actions).toEqual(actions);
    }
  );

  // reviewing + changes: the findings go to the worker.
  it('reviewing + changes at S -> fixing, stop reviewer, send review-findings', () => {
    const d = drain('reviewing', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'changes',
      reviewRound: 1,
      reviewer: reviewer(S),
    });
    const out = step(d);
    expect(out.drain.phase).toBe('fixing');
    expect(out.actions).toEqual([
      stopReviewer(S),
      {
        kind: 'send',
        message: 'review-findings',
        ctx: {
          ...BASE,
          sha: S,
          round: 1,
          findingsFile: '.dork/flow/drain/reviews/1-aaaaaaa.md',
        },
      },
    ]);
  });

  // reviewing + a newer push before the verdict: the old review is abandoned.
  it('reviewing + pushed S2 != reviewer.sha before a verdict -> reviewing, restart at S2', () => {
    const d = drain('reviewing', {
      pushedSha: S2,
      reviewedSha: S,
      verdict: 'changes',
      reviewRound: 1,
      reviewer: reviewer(S),
      nudges: 1,
    });
    const out = step(d);
    expect(out.drain.phase).toBe('reviewing');
    expect(out.drain.nudges).toBe(0);
    expect(out.actions).toEqual([
      stopReviewer(S),
      { kind: 'start-reviewer', sha: S2, deltaFrom: S },
    ]);
  });

  // reviewing + the reviewer stopped with no verdict: one restart, then park.
  it('reviewing + reviewer exited with no verdict -> restart once, then park', () => {
    const d = drain('reviewing', { pushedSha: S, reviewer: reviewer(S) });
    const first = step(d, { reviewer: { kind: 'exited', code: 1 } });
    expect(first.drain.phase).toBe('reviewing');
    expect(first.drain.nudges).toBe(1);
    expect(first.actions).toEqual([
      stopReviewer(S),
      { kind: 'start-reviewer', sha: S, deltaFrom: null },
    ]);

    const second = step({ ...first.drain, reviewer: reviewer(S) }, { reviewer: { kind: 'idle' } });
    expect(second.drain.phase).toBe('parked');
    expect(second.actions).toEqual([
      stopReviewer(S),
      STOP_WORKER,
      { kind: 'park', reason: PARK_REASONS.reviewerStopped, trackerWrite: true },
    ]);
  });

  // fixing + the fix pushed: review again, reading the delta first.
  it('fixing + pushed S2 -> reviewing, start reviewer at S2 with deltaFrom = reviewedSha', () => {
    const d = drain('fixing', {
      pushedSha: S2,
      reviewedSha: S,
      verdict: 'changes',
      reviewRound: 1,
    });
    const out = step(d);
    expect(out.drain.phase).toBe('reviewing');
    expect(out.actions).toEqual([{ kind: 'start-reviewer', sha: S2, deltaFrom: S }]);
  });

  // fixing + the worker stopped without a push: the working nudge rules.
  it('fixing + worker stopped without a push -> fixing, send continue', () => {
    const d = drain('fixing', { pushedSha: S, reviewedSha: S, verdict: 'changes', reviewRound: 1 });
    const out = step(d, { worker: { kind: 'idle' } });
    expect(out.drain.phase).toBe('fixing');
    expect(out.drain.nudges).toBe(1);
    expect(out.actions).toEqual([{ kind: 'send', message: 'continue', ctx: BASE }]);
  });

  // any review phase + the round limit with changes: park.
  it('reviewing + changes at reviewRound >= maxReviewRounds -> parked', () => {
    const d = drain('reviewing', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'changes',
      reviewRound: 5,
      reviewer: reviewer(S),
    });
    const out = step(d);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe('the review did not come back clean after 5 rounds');
    expect(out.actions).toEqual([
      stopReviewer(S),
      STOP_WORKER,
      { kind: 'park', reason: PARK_REASONS.rounds(5), trackerWrite: true },
    ]);
  });

  // pr-ready + flow pr recorded the PR: watch it.
  it('pr-ready + drain.pr recorded -> watching, no action', () => {
    const d = drain('pr-ready', { pushedSha: S, reviewedSha: S, verdict: 'clean', pr: PR });
    const out = step(d);
    expect(out.drain.phase).toBe('watching');
    expect(out.actions).toEqual([]);
  });

  /** A watching drain with PR #88 at a clean S. */
  const watchingDrain = (over: Partial<DrainState> = {}) =>
    drain('watching', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 1,
      pr: { ...PR, armed: true },
      ...over,
    });

  // watching + merged: tell the worker to run DONE.
  it('watching + merged -> closing, send merged', () => {
    const out = step(watchingDrain(), { pr: prStatus({ state: 'merged' }) });
    expect(out.drain.phase).toBe('closing');
    expect(out.actions).toEqual([
      { kind: 'send', message: 'merged', ctx: { ...BASE, prUrl: PR.url } },
    ]);
  });

  // watching + failing checks: send them to the worker.
  it('watching + failing -> fixing-ci, send ci-red with names and urls', () => {
    const failing = [{ name: 'test', url: 'https://ci/1' }];
    const out = step(watchingDrain(), { pr: prStatus({ failing }) });
    expect(out.drain.phase).toBe('fixing-ci');
    expect(out.actions).toEqual([
      { kind: 'send', message: 'ci-red', ctx: { ...BASE, prUrl: PR.url, failing } },
    ]);
  });

  // watching + an innocent ejection not yet re-armed at this head: arm once.
  it('watching + ejected, innocent, rearmedFor != head -> watching, arm, rearmedFor = head', () => {
    const failing = [{ name: 'e2e', url: 'https://ci/2' }];
    const out = step(watchingDrain(), {
      pr: prStatus({ armed: false, queued: false, failing }),
      ejection: 'innocent',
    });
    expect(out.drain.phase).toBe('watching');
    expect(out.drain.rearmedFor).toBe(S);
    expect(out.actions).toEqual([{ kind: 'arm', pr: { repo: 'acme/app', number: 88 }, sha: S }]);
  });

  // watching + any other ejection (suspect, unknown, or innocent twice at one head): ci-red.
  it.each([
    ['suspect', null],
    ['unknown', null],
    ['innocent', S],
  ] as const)(
    'watching + ejected, %s (rearmedFor %s) -> fixing-ci, send ci-red',
    (ejection, rearmedFor) => {
      const failing = [{ name: 'e2e', url: 'https://ci/2' }];
      const out = step(watchingDrain({ rearmedFor }), {
        pr: prStatus({ armed: false, queued: false, failing }),
        ejection,
      });
      expect(out.drain.phase).toBe('fixing-ci');
      expect(out.actions).toEqual([
        {
          kind: 'send',
          message: 'ci-red',
          ctx: { ...BASE, prUrl: PR.url, failing, ejected: true },
        },
      ]);
    }
  );

  // watching + a PR that was never armed and not ejected: just wait (armAutoMerge defaults off).
  it('watching + neither armed nor queued with no ejection -> watching, no action', () => {
    const out = step(watchingDrain(), { pr: prStatus({ armed: false }) });
    expect(out.drain.phase).toBe('watching');
    expect(out.actions).toEqual([]);
  });

  // watching + closed unmerged: park.
  it('watching + closed, not merged -> parked', () => {
    const out = step(watchingDrain(), { pr: prStatus({ state: 'closed' }) });
    expect(out.drain.phase).toBe('parked');
    expect(out.actions).toEqual([
      STOP_WORKER,
      { kind: 'park', reason: PARK_REASONS.prClosed, trackerWrite: true },
    ]);
  });

  // fixing-ci + the fix pushed: it is reviewed before it can merge.
  it('fixing-ci + pushed S3 -> reviewing, start reviewer with deltaFrom = reviewedSha', () => {
    const out = step(watchingDrain({ phase: 'fixing-ci', pushedSha: S2 }));
    expect(out.drain.phase).toBe('reviewing');
    // The PR is armed, so it is disarmed before the review starts.
    expect(out.actions).toEqual([
      { kind: 'disarm', pr: { repo: 'acme/app', number: 88 } },
      { kind: 'start-reviewer', sha: S2, deltaFrom: S },
    ]);
  });

  // closing + flow done ran: stop what is still live.
  it('closing + runComplete -> stop any live session', () => {
    const out = step(watchingDrain({ phase: 'closing' }), {
      runComplete: true,
      item: { closed: true, claimed: false, needsInput: false, title: 't' },
    });
    expect(out.drain.phase).toBe('closing');
    expect(out.drain.worker).toBeNull();
    expect(out.actions).toEqual([STOP_WORKER]);
  });

  // closing + the worker closed the item itself: that is not "taken away".
  it('closing + item closed before runComplete -> no park, no action', () => {
    const out = step(watchingDrain({ phase: 'closing' }), {
      item: { closed: true, claimed: false, needsInput: false, title: 't' },
    });
    expect(out.drain.phase).toBe('closing');
    expect(out.actions).toEqual([]);
  });

  // reviewing + clean at S, origin moved past S, no push reported: ask for the report.
  it('reviewing + clean at S, origin head moved, pushedSha = S -> send continue (unreported push)', () => {
    const d = drain('reviewing', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 1,
      reviewer: reviewer(S),
    });
    const out = step(d, { originHead: S2, worker: { kind: 'idle' } });
    expect(out.drain.phase).toBe('reviewing');
    expect(out.actions).toEqual([
      stopReviewer(S),
      { kind: 'send', message: 'continue', ctx: { ...BASE, unreportedPush: true } },
    ]);
  });

  // reviewing + clean at S, origin moved and the push was reported: review the head.
  it('reviewing + clean at S, pushedSha = origin head != S -> start a reviewer at the head', () => {
    const d = drain('reviewing', {
      pushedSha: S2,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 1,
      reviewer: reviewer(S),
    });
    const out = step(d, { originHead: S2 });
    expect(out.drain.phase).toBe('reviewing');
    expect(out.actions).toEqual([
      stopReviewer(S),
      { kind: 'start-reviewer', sha: S2, deltaFrom: S },
    ]);
  });

  // pr-ready or watching + a new push: back to review before anything merges.
  it.each(['pr-ready', 'watching'] as const)(
    '%s + pushed S != reviewedSha -> reviewing',
    (phase) => {
      const d = watchingDrain({ phase, pushedSha: S2 });
      const out = step(d, { pr: prStatus() });
      expect(out.drain.phase).toBe('reviewing');
      expect(out.actions).toEqual([
        { kind: 'disarm', pr: { repo: 'acme/app', number: 88 } },
        { kind: 'start-reviewer', sha: S2, deltaFrom: S },
      ]);
    }
  );

  // working, reviewing or fixing + a PR on the branch before a clean review: disarm and park.
  it.each(['working', 'reviewing', 'fixing', 'pr-ready'] as const)(
    '%s + a PR on the branch while drain.pr is null -> parked, disarm',
    (phase) => {
      const d = drain(phase, {
        pushedSha: S,
        reviewer: phase === 'reviewing' ? reviewer(S) : null,
      });
      const out = step(d, {
        prForBranch: { repo: 'acme/app', number: 90, url: 'u', headSha: S },
      });
      expect(out.drain.phase).toBe('parked');
      expect(out.drain.parkedReason).toBe(PARK_REASONS.earlyPr);
      expect(out.actions).toEqual([
        { kind: 'disarm', pr: { repo: 'acme/app', number: 90 } },
        ...(phase === 'reviewing' ? [stopReviewer(S)] : []),
        STOP_WORKER,
        { kind: 'park', reason: PARK_REASONS.earlyPr, trackerWrite: true },
      ]);
    }
  );

  // flow pr opens the PR, then records it: a pass in between sees a PR on the
  // branch with drain.pr still null. At the clean reviewed head that is flow
  // pr's own PR, not an early one.
  it('pr-ready + a PR at the clean reviewed head, not yet recorded -> no park, no action', () => {
    const d = drain('pr-ready', { pushedSha: S, reviewedSha: S, verdict: 'clean', reviewRound: 1 });
    const legit = step(d, { prForBranch: { repo: 'acme/app', number: 90, url: 'u', headSha: S } });
    expect(legit.drain.phase).toBe('pr-ready');
    expect(legit.actions).toEqual([]);
    // With no head from the forge, origin's head stands in for it.
    const unknown = step(d, {
      prForBranch: { repo: 'acme/app', number: 90, url: 'u', headSha: null },
    });
    expect(unknown.actions).toEqual([]);
    // At any other head it is early: disarm and park.
    const early = step(d, {
      prForBranch: { repo: 'acme/app', number: 90, url: 'u', headSha: S2 },
    });
    expect(early.drain.phase).toBe('parked');
    expect(early.actions[0]).toEqual({ kind: 'disarm', pr: { repo: 'acme/app', number: 90 } });
  });

  // a queued run with no worker, or a pending one, past the start timeout: adopt or release.
  it.each([
    ['queued, no worker', { worker: null }, 'queued'],
    ['pending worker', { worker: { ...WORKER, pending: true } }, 'running'],
  ] as const)('%s older than the start timeout -> adopt-or-release', (_name, over, status) => {
    const d = drain('working', over);
    const old = step(d, { queuedAgeMs: 90_001, worker: null }, { status });
    expect(old.drain.phase).toBe('working');
    expect(old.actions).toEqual([{ kind: 'adopt-or-release' }]);
    const young = step(d, { queuedAgeMs: 90_000, worker: null }, { status });
    expect(young.actions).toEqual([]);
  });

  // any phase + the item taken away: stop everything, park, write nothing to the tracker.
  it.each([
    ['closed', { closed: true, claimed: true }],
    ['claim lost', { closed: false, claimed: false }],
  ] as const)('item %s by someone else -> parked, stop sessions, no tracker write', (_n, item) => {
    const d = drain('reviewing', { pushedSha: S, reviewer: reviewer(S) });
    const out = step(d, { item: { ...item, needsInput: false, title: 't' } });
    expect(out.drain.phase).toBe('parked');
    expect(out.actions).toEqual([
      stopReviewer(S),
      STOP_WORKER,
      { kind: 'park', reason: PARK_REASONS.itemTaken, trackerWrite: false },
    ]);
  });

  // any + report blocked: the verb parked it already; the reducer leaves it alone.
  it('a run the blocked report parked -> unchanged, no action', () => {
    const d = drain('parked', { parkedReason: 'blocked' });
    const r = run(d);
    const f = facts(d, { worker: { kind: 'idle' } });
    const out = drainStep(r, { ...f, item: { ...f.item, needsInput: true } }, CFG, NOW);
    expect(out.run).toBe(r);
    expect(out.actions).toEqual([]);
  });
});

describe('drainStep: while run.limit is set', () => {
  const LIMIT: RunLimit = {
    level: 'warning',
    account: 'claude3',
    window: 'weekly',
    resetsAt: null,
    cause: 'limit',
    since: '2026-09-26T11:30:00.000Z',
    state: 'winding-down',
    handoffToken: null,
    handingOffAt: null,
    handoffSessionId: null,
    notifiedAt: null,
  };

  // The handoff reducer owns the worker: no nudge, and no park for a wound-down worker.
  it.each([0, 2])('a stopped worker (nudges %i) gets no message and does not park', (nudges) => {
    const out = step(drain('working', { nudges }), { worker: { kind: 'idle' } }, { limit: LIMIT });
    expect(out.drain.phase).toBe('working');
    expect(out.actions).toEqual([]);
  });

  // A step that would message the worker is dropped whole, but the reports are recorded.
  it('drops review-findings, records the verdict', () => {
    const d = drain('reviewing', { pushedSha: S, reviewer: reviewer(S) });
    const out = drainStep(
      run(d, { limit: LIMIT }),
      facts(d, {
        reports: { pushedSha: S, verdict: 'changes', reviewedSha: S, reviewRound: 1, pr: null },
      }),
      CFG,
      NOW
    );
    expect(out.actions).toEqual([]);
    expect(out.run.drain!.phase).toBe('reviewing');
    expect(out.run.drain!.verdict).toBe('changes');
    expect(out.run.drain!.reviewRound).toBe(1);
  });

  // A step that does not message the worker still happens.
  it('still starts the reviewer for a reported push', () => {
    const out = step(drain('working', { pushedSha: S }), {}, { limit: LIMIT });
    expect(out.actions).toEqual([{ kind: 'start-reviewer', sha: S, deltaFrom: null }]);
  });
});

describe('drainStep: arming only the reviewed commit', () => {
  /** A watching drain with PR #88 at a clean S. */
  const clean = (over: Partial<DrainState> = {}) =>
    drain('watching', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 1,
      pr: { ...PR, armed: true },
      ...over,
    });

  // A clean re-review re-arms only when the PR's head is the reviewed commit;
  // otherwise it waits in watching with disarmedForReview still set.
  it('re-arms at the reviewed SHA only when the PR head is that SHA', () => {
    const d = drain('reviewing', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 2,
      reviewer: reviewer(S),
      pr: { ...PR, armed: false, disarmedForReview: true },
    });
    const lagging = step(d, { pr: prStatus({ armed: false, headSha: S2 }) });
    expect(lagging.drain.phase).toBe('watching');
    expect(lagging.drain.pr?.disarmedForReview).toBe(true);
    expect(lagging.actions.some((a) => a.kind === 'arm')).toBe(false);

    // Next pass in watching: the forge caught up, so it arms at S.
    const caught = step(lagging.drain, { pr: prStatus({ armed: false, headSha: S }) });
    expect(caught.actions).toEqual([{ kind: 'arm', pr: { repo: 'acme/app', number: 88 }, sha: S }]);
  });

  // Any restart of review while the PR is armed disarms it first.
  it.each(['pr-ready', 'watching', 'fixing-ci'] as const)(
    '%s + a reported push while armed -> disarm, then review',
    (phase) => {
      const out = step(clean({ phase, pushedSha: S2 }), {
        originHead: S2,
        pr: prStatus({ headSha: S2 }),
      });
      expect(out.drain.phase).toBe('reviewing');
      expect(out.actions).toEqual([
        { kind: 'disarm', pr: { repo: 'acme/app', number: 88 } },
        { kind: 'start-reviewer', sha: S2, deltaFrom: S },
      ]);
    }
  );

  // An innocent ejection re-arms only a clean review of the head (a head that
  // moved is caught before this, as an unreported push).
  it('an innocent ejection does not re-arm without a clean review at the head', () => {
    const out = step(clean({ verdict: 'changes' }), {
      originHead: S,
      pr: prStatus({
        armed: false,
        queued: false,
        headSha: S,
        failing: [{ name: 'e2e', url: 'u' }],
      }),
      ejection: 'innocent',
    });
    expect(out.actions.some((a) => a.kind === 'arm')).toBe(false);
  });

  // A push nobody reported, seen on origin or on the PR: disarm, and ask for
  // the report once the worker has stopped. Never left armed.
  it.each([
    ['pr-ready', { originHead: S2, pr: null }],
    ['watching', { originHead: S2, pr: prStatus({ headSha: S }) }],
    ['watching', { originHead: S, pr: prStatus({ headSha: S2 }) }],
    ['fixing-ci', { originHead: S2, pr: prStatus({ headSha: S2 }) }],
  ] as const)('%s + an unreported push -> disarm, continue', (phase, seen) => {
    const d = clean({ phase, pr: phase === 'pr-ready' ? null : { ...PR, armed: true } });
    const busy = step(d, { ...seen, worker: { kind: 'busy' } });
    expect(busy.drain.phase).toBe(phase);
    expect(busy.actions).toEqual(
      phase === 'pr-ready' ? [] : [{ kind: 'disarm', pr: { repo: 'acme/app', number: 88 } }]
    );
    const idle = step(d, { ...seen, worker: { kind: 'idle' } });
    expect(idle.actions.at(-1)).toEqual({
      kind: 'send',
      message: 'continue',
      ctx: { ...BASE, unreportedPush: true },
    });
    expect(idle.actions.some((a) => a.kind === 'arm')).toBe(false);
  });
});

describe('drainStep: parked runs', () => {
  // Parking stops the worker but keeps its handle, so an answer can resume it.
  it('parking stops the worker, keeps its handle, and records where it parked from', () => {
    const out = step(drain('working', { nudges: 2 }), { worker: { kind: 'idle' } });
    expect(out.drain).toMatchObject({ phase: 'parked', parkedFrom: 'working', worker: WORKER });
    expect(out.actions).toContainEqual(STOP_WORKER);
  });

  // Answered (needs-input gone, still claimed and open): back to its phase with a continue.
  it('an answered parked run goes back to its phase and gets a continue', () => {
    const d = drain('parked', { parkedReason: 'q', parkedFrom: 'fixing', nudges: 2 });
    const answer = 'the comment by dorian at 2026-09-26T12:05:00.000Z';
    const out = step(d, {
      worker: { kind: 'exited', code: 0 },
      item: { closed: false, claimed: true, needsInput: false, title: 't', answer },
    });
    expect(out.drain).toMatchObject({
      phase: 'fixing',
      parkedReason: null,
      parkedFrom: null,
      nudges: 0,
    });
    expect(out.actions).toEqual([
      { kind: 'send', message: 'continue', ctx: { ...BASE, answered: true, answer } },
    ]);
    expect(render('continue', { ...BASE, answered: true, answer })).toContain(answer);
    // With no recorded phase it resumes as working.
    const bare = step(drain('parked', { parkedReason: 'q' }));
    expect(bare.drain.phase).toBe('working');
  });

  // Still waiting on a person, or taken away: left alone.
  it.each([
    ['still needs input', { closed: false, claimed: true, needsInput: true }],
    ['claim removed', { closed: false, claimed: false, needsInput: false }],
    ['closed', { closed: true, claimed: true, needsInput: false }],
  ] as const)('a parked run whose item is %s stays parked', (_n, item) => {
    const d = drain('parked', { parkedReason: 'q', parkedFrom: 'working' });
    const out = step(d, { item: { ...item, title: 't' } });
    expect(out.drain.phase).toBe('parked');
    expect(out.actions).toEqual([]);
  });
});

/** A seeded PRNG (mulberry32), so the property sweep is reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('drainStep: properties over every row', () => {
  const ALLOWED = new Set([
    'start-reviewer',
    'stop',
    'send',
    'arm',
    'disarm',
    'adopt-or-release',
    'park',
  ]);

  // Across random states in every phase: no action creates a PR, and open-pr
  // goes out only with a clean verdict at the pushed SHA that is the origin head,
  // on a run with no PR yet.
  it('never creates a PR; open-pr and arm only with a clean verdict at the head; a moved head is disarmed', () => {
    const rand = prng(20260926);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const shas = [null, S, S2, HEAD_PR] as const;
    let openPrs = 0;
    let arms = 0;
    let disarmChecks = 0;
    for (let i = 0; i < 20_000; i++) {
      const pushedSha = pick(shas);
      const d = drain(pick(DRAIN_PHASES), {
        worker: pick([null, WORKER, { ...WORKER, pending: true }]),
        reviewer: pick([null, reviewer(S), reviewer(S2)]),
        pushedSha,
        reviewedSha: pick(shas),
        verdict: pick([null, 'clean', 'changes'] as const),
        reviewRound: pick([0, 1, 4, 5, 6]),
        pr: pick([null, PR, { ...PR, disarmedForReview: true }, { ...PR, armed: true }]),
        rearmedFor: pick([null, HEAD_PR]),
        nudges: pick([0, 1, 2]),
      });
      const f = facts(d, {
        prForBranch: pick([
          null,
          { repo: 'acme/app', number: 90, url: 'u', headSha: pick([S, S2, null]) },
        ]),
        queuedAgeMs: pick([null, 1, 100_000]),
        worker: pick([
          null,
          { kind: 'busy' },
          { kind: 'idle' },
          { kind: 'exited', code: 0 },
        ] as const),
        reviewer: pick([null, { kind: 'busy' }, { kind: 'idle' }] as const),
        originHead: pick(shas),
        pr: pick([
          null,
          prStatus({ headSha: pick(shas.filter((x) => x !== null)) as string }),
          prStatus({ armed: false, headSha: pick([S, S2]) }),
          prStatus({ state: 'merged' }),
          prStatus({ armed: false, failing: [{ name: 'x', url: 'y' }], headSha: pick([S, S2]) }),
        ]),
        ejection: pick([null, 'innocent', 'suspect', 'unknown'] as const),
        item: { closed: rand() < 0.1, claimed: rand() > 0.1, needsInput: rand() < 0.5, title: 'T' },
        runComplete: rand() < 0.2,
      });
      const r = run(d, {
        status: pick(['queued', 'running'] as const),
        ...(rand() < 0.2 ? { limit: {} as RunLimit } : {}),
      });
      const out = drainStep(r, f, CFG, NOW);
      // A head that moved past the reviewed commit on an armed PR is disarmed.
      const moved =
        (f.originHead !== null && f.originHead !== d.reviewedSha) ||
        (f.pr !== null && f.pr.state === 'open' && f.pr.headSha !== d.reviewedSha);
      const armed = d.pr?.armed === true || (f.pr?.state === 'open' && f.pr.armed);
      if (
        moved &&
        armed &&
        d.pr !== null &&
        ['pr-ready', 'watching', 'fixing-ci'].includes(d.phase) &&
        !f.item.closed &&
        f.item.claimed &&
        f.pr?.state !== 'merged' &&
        f.pr?.state !== 'closed' &&
        // (A start that never confirmed is resolved first, before any phase step.)
        !(
          f.queuedAgeMs !== null &&
          f.queuedAgeMs > CFG.startTimeoutMs &&
          ((r.status === 'queued' && d.worker === null) || d.worker?.pending === true)
        )
      ) {
        disarmChecks++;
        expect(out.actions.some((a) => a.kind === 'disarm')).toBe(true);
      }
      for (const a of out.actions) {
        expect(ALLOWED.has(a.kind)).toBe(true);
        expect(JSON.stringify(a)).not.toMatch(/create/i);
        if (a.kind === 'arm') {
          arms++;
          expect(a.sha).toBe(f.reports.reviewedSha);
          expect(f.reports.verdict).toBe('clean');
          expect(f.reports.pushedSha).toBe(a.sha);
          expect(f.originHead).toBe(a.sha);
          expect(f.pr?.headSha).toBe(a.sha);
        }
        if (a.kind === 'send' && a.message === 'open-pr') {
          openPrs++;
          expect(f.reports.verdict).toBe('clean');
          expect(f.reports.reviewedSha).toBe(f.originHead);
          expect(f.reports.pushedSha).toBe(f.originHead);
          expect(f.reports.pr).toBeNull();
          expect(f.prForBranch).toBeNull();
        }
      }
    }
    // The sweep must actually reach the open-pr, arm and moved-head rows, or it proves nothing.
    expect(openPrs).toBeGreaterThan(0);
    expect(arms).toBeGreaterThan(0);
    expect(disarmChecks).toBeGreaterThan(0);
  });
});

/** A full context for each message kind. */
const CONTEXTS: { [K in MessageKind]: MessageContexts[K] } = {
  continue: BASE,
  'open-pr': { ...BASE, sha: S, title: "Export the report's CSV" },
  'review-findings': {
    ...BASE,
    sha: S,
    round: 2,
    findingsFile: '.dork/flow/drain/reviews/2-aaaaaaa.md',
  },
  'ci-red': { ...BASE, prUrl: PR.url, failing: [{ name: 'test', url: 'https://ci/1' }] },
  merged: { ...BASE, prUrl: PR.url },
  'wind-down': { ...BASE, accountLabel: 'claude3', windowLabel: 'weekly' },
  'resume-from-handoff': { ...BASE, worktree: '/work/ABC-1', branch: 'ABC-1-export-csv' },
  'limit-cleared': { ...BASE, accountLabel: 'claude3' },
};

describe('messages', () => {
  // Every kind renders whole: no template hole, and it ends with a full flow command.
  it.each(MESSAGE_KINDS)('%s renders with no placeholder and ends with a flow command', (kind) => {
    const text = render(kind, CONTEXTS[kind] as never);
    expect(text).not.toMatch(/\{\{|\}\}|undefined|null|NaN|\[object |<[a-z][a-z -]*>/);
    const last = text.trimEnd().split('\n').at(-1)!;
    expect(last).toMatch(new RegExp(`^\`${FLOW.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\S.*\`$`));
    expect(last).toContain(' ABC-1');
  });

  // The variants render whole too: an unreported push, an ejection with no checks, no window label.
  it('renders the variants whole', () => {
    for (const text of [
      render('continue', { ...BASE, unreportedPush: true }),
      render('ci-red', { ...BASE, prUrl: PR.url, failing: [], ejected: true }),
      render('wind-down', { ...BASE, accountLabel: 'claude3' }),
    ]) {
      expect(text).not.toMatch(/\{\{|undefined|null|NaN/);
      expect(text.trimEnd().split('\n').at(-1)).toMatch(/^`node .* ABC-1.*`$/);
    }
  });

  // The exact next command for the commands a worker must run verbatim.
  it('spells the next command exactly', () => {
    const last = (t: string) => t.trimEnd().split('\n').at(-1);
    expect(last(render('open-pr', CONTEXTS['open-pr']))).toBe(
      `\`${FLOW} pr ABC-1 --title 'Export the report'\\''s CSV' --body-file .dork/flow/drain/pr-body.md\``
    );
    expect(last(render('merged', CONTEXTS.merged))).toBe(
      `\`${FLOW} done ABC-1 --summary-file .dork/flow/drain/summary.md --pr ${PR.url}\``
    );
    expect(last(render('continue', BASE))).toBe(`\`${FLOW} report ABC-1 pushed\``);
    expect(last(render('wind-down', CONTEXTS['wind-down']))).toBe(
      `\`${FLOW} checkpoint ABC-1 --trigger limit-warning --body-file .dork/flow/drain/checkpoint-body.md\``
    );
  });

  // A missing required field refuses to render rather than leaving a hole.
  it('refuses a context with a missing field', () => {
    expect(() => render('merged', { ...BASE, prUrl: '' })).toThrow(/prUrl/);
    expect(() => render('continue', { ...BASE, flow: ' ' })).toThrow(/flow/);
  });
});
