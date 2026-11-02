/**
 * The lane supervisor (DOR-3263): `drainStep` with `stallAfterMs` set notices a
 * lane that has gone quiet. A session that went away restarts once, then the
 * run parks; a quiet or unreachable session parks with a plain reason; a
 * session waiting on a person is never restarted or parked, only listed as
 * waiting. Every row is pinned against a clock moved past the stall time.
 */

import { describe, expect, it } from 'vitest';

import {
  drainStep,
  PARK_REASONS,
  type DrainFacts,
  type DrainStepConfig,
} from '../../scripts/drain/drain-step.ts';
import type {
  DrainReviewerHandle,
  DrainState,
  DrainWorkerHandle,
} from '../../scripts/drain/state.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import type { SessionState } from '../../scripts/launchers/types.ts';

const FLOW = 'node --experimental-strip-types /opt/flow/scripts/flow.ts';
const MINUTE = 60_000;
const STALL = 60 * MINUTE;
const CFG: DrainStepConfig = {
  maxReviewRounds: 5,
  startTimeoutMs: 90_000,
  flow: FLOW,
  stallAfterMs: STALL,
};
const T0 = new Date('2026-09-26T12:00:00.000Z');
const S = 'aaaaaaa1111111111111111111111111111111111';

/** `minutes` after {@link T0}. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE);
}

const WORKER: DrainWorkerHandle = {
  host: 'dorkos',
  runtime: 'claude-code',
  sessionId: 'w-1',
  account: 'claude3',
  cwd: '/work/ABC-1',
};

const REVIEWER: DrainReviewerHandle = {
  host: 'dorkos',
  runtime: 'claude-code',
  sessionId: 'r-1',
  account: 'claude4',
  cwd: '/work/review-ABC-1',
  sha: S,
  worktree: '/work/review-ABC-1',
  tokenHash: 'sha256:x',
};

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

/** Facts for `d`: the worker and reviewer in the given states, with their activity. */
function facts(
  d: DrainState,
  worker: SessionState | null,
  over: Partial<DrainFacts> = {}
): DrainFacts {
  return {
    prForBranch: null,
    queuedAgeMs: null,
    worker,
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

/** A busy worker that last wrote at `activityAt`. */
function busy(activityAt: string): SessionState {
  return { kind: 'busy', activityAt };
}

const GONE: SessionState = {
  kind: 'unknown',
  reason: 'DorkOS no longer knows this session',
  gone: true,
};

/**
 * Step `d` once at {@link T0} and again at `minutes` with the same facts: what
 * a lane that showed nothing new in between gets.
 */
function quietFor(
  d: DrainState,
  f: (d: DrainState) => DrainFacts,
  minutes: number,
  r: Partial<FlowRun> = {}
) {
  const first = drainStep(run(d, r), f(d), CFG, T0);
  const seen = first.run.drain!;
  const out = drainStep(run(seen, r), f(seen), CFG, at(minutes));
  return { first, seen, drain: out.run.drain!, actions: out.actions };
}

describe('lane supervisor: progress', () => {
  it('first look records when the lane was seen and changes nothing else', () => {
    const d = drain('working');
    const out = drainStep(run(d), facts(d, busy('2026-09-26T11:59:00.000Z')), CFG, T0);
    expect(out.actions).toEqual([]);
    expect(out.run.drain?.progressAt).toBe(T0.toISOString());
    expect(typeof out.run.drain?.progressMark).toBe('string');
  });

  it('a lane that keeps writing is never stalled', () => {
    const d = drain('working');
    const first = drainStep(run(d), facts(d, busy('2026-09-26T11:59:00.000Z')), CFG, T0);
    const mid = drainStep(
      run(first.run.drain!),
      facts(first.run.drain!, busy('2026-09-26T12:30:00.000Z')),
      CFG,
      at(30)
    );
    expect(mid.run.drain?.progressAt).toBe(at(30).toISOString());
    const late = drainStep(
      run(mid.run.drain!),
      facts(mid.run.drain!, busy('2026-09-26T12:30:00.000Z')),
      CFG,
      at(61)
    );
    expect(late.actions).toEqual([]);
    expect(late.run.drain?.phase).toBe('working');
  });

  it('progress seen within a minute of the last record is not written again', () => {
    const d = drain('working');
    const first = drainStep(run(d), facts(d, busy('2026-09-26T11:59:00.000Z')), CFG, T0);
    const soon = drainStep(
      run(first.run.drain!),
      facts(first.run.drain!, busy('2026-09-26T12:00:20.000Z')),
      CFG,
      new Date(T0.getTime() + 30_000)
    );
    expect(soon.run.drain).toEqual(first.run.drain);
  });

  it('without a stall time nothing is tracked (the rule is off)', () => {
    const d = drain('working');
    const { stallAfterMs: _off, ...cfg } = CFG;
    const out = drainStep(run(d), facts(d, busy('2026-09-26T11:59:00.000Z')), cfg, T0);
    expect(out.run.drain).toEqual(d);
  });
});

describe('lane supervisor: a quiet lane', () => {
  it('a busy worker that wrote nothing for the stall time parks, and says so', () => {
    const out = quietFor(drain('working'), (d) => facts(d, busy('2026-09-26T11:59:00.000Z')), 61);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(PARK_REASONS.workerQuiet(60));
    expect(out.actions).toContainEqual({
      kind: 'park',
      reason: PARK_REASONS.workerQuiet(60),
      trackerWrite: true,
    });
  });

  it('not before the stall time', () => {
    const out = quietFor(drain('working'), (d) => facts(d, busy('2026-09-26T11:59:00.000Z')), 59);
    expect(out.actions).toEqual([]);
    expect(out.drain.phase).toBe('working');
  });

  it('a busy worker whose host reports no activity is never judged quiet', () => {
    const out = quietFor(drain('working'), (d) => facts(d, { kind: 'busy' }), 600);
    expect(out.actions).toEqual([]);
  });

  it('a worker the host cannot reach parks: it may still be running, so it is not restarted', () => {
    const unreachable: SessionState = { kind: 'unknown', reason: 'connect ECONNREFUSED' };
    const out = quietFor(drain('fixing'), (d) => facts(d, unreachable), 61);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(
      PARK_REASONS.unreachable('worker', 60, 'connect ECONNREFUSED')
    );
    expect(out.actions.some((a) => a.kind === 'restart-worker')).toBe(false);
  });

  it('a session the host can never describe (no status reported) is never judged', () => {
    const blind: SessionState = {
      kind: 'unknown',
      reason: 'this DorkOS does not report session status',
      cannotTell: true,
    };
    expect(quietFor(drain('working'), (d) => facts(d, blind), 600).actions).toEqual([]);
    const reviewing = drain('reviewing', { pushedSha: S, reviewer: REVIEWER });
    expect(
      quietFor(reviewing, (d) => facts(d, { kind: 'idle' }, { reviewer: blind }), 600).actions
    ).toEqual([]);
  });

  it('a lane whose run is limited belongs to the handoff machine', () => {
    const limit = {
      level: 'exhausted' as const,
      account: 'claude3',
      window: 'five_hour',
      resetsAt: null,
      cause: 'limit' as const,
      since: T0.toISOString(),
      state: 'awaiting-handoff' as const,
      handoffToken: null,
      handingOffAt: null,
      handoffSessionId: null,
      notifiedAt: null,
    };
    const out = quietFor(drain('working'), (d) => facts(d, GONE), 600, { limit });
    expect(out.actions).toEqual([]);
  });

  it('a worker waiting on CI in watching is not a quiet lane', () => {
    const d = drain('watching', {
      pushedSha: S,
      reviewedSha: S,
      verdict: 'clean',
      reviewRound: 1,
      pr: { repo: 'acme/app', number: 8, url: 'u', armed: true, disarmedForReview: false },
    });
    const out = quietFor(
      d,
      (x) =>
        facts(x, busy('2026-09-26T11:59:00.000Z'), {
          pr: { state: 'open', failing: [], armed: true, queued: false, headSha: S },
        }),
      600
    );
    expect(out.actions).toEqual([]);
  });
});

describe('lane supervisor: a session that went away', () => {
  it('restarts once after the stall time, through the account ranking', () => {
    const out = quietFor(drain('working'), (d) => facts(d, GONE), 61);
    expect(out.drain.phase).toBe('working');
    expect(out.drain.restarts).toBe(1);
    expect(out.actions).toEqual([{ kind: 'restart-worker', reason: PARK_REASONS.workerGone }]);
  });

  it('the second time it goes away, the run parks', () => {
    const out = quietFor(drain('working', { restarts: 1 }), (d) => facts(d, GONE), 61);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(PARK_REASONS.workerGoneAgain);
    expect(out.actions.some((a) => a.kind === 'restart-worker')).toBe(false);
  });
});

describe('lane supervisor: waiting on a person', () => {
  const blocked: SessionState = {
    kind: 'busy',
    waiting: 'person',
    activityAt: '2026-09-26T11:59:00.000Z',
  };

  it('is never restarted or parked, only listed as waiting since it stopped', () => {
    const out = quietFor(drain('working'), (d) => facts(d, blocked), 300);
    expect(out.actions).toEqual([]);
    expect(out.drain.phase).toBe('working');
    expect(out.drain.waitingSince).toBe(T0.toISOString());
  });

  it('is not listed before the stall time', () => {
    const out = quietFor(drain('working'), (d) => facts(d, blocked), 30);
    expect(out.drain.waitingSince ?? null).toBeNull();
  });

  it('stops being listed once the session moves again', () => {
    const waiting = quietFor(drain('working'), (d) => facts(d, blocked), 300).drain;
    const out = drainStep(
      run(waiting),
      facts(waiting, busy('2026-09-26T17:00:00.000Z')),
      CFG,
      at(301)
    );
    expect(out.run.drain?.waitingSince).toBeNull();
    expect(out.run.drain?.progressAt).toBe(at(301).toISOString());
  });
});

describe('lane supervisor: the reviewer', () => {
  const reviewing = drain('reviewing', { pushedSha: S, reviewer: REVIEWER });
  const reviewerFacts = (state: SessionState) => (d: DrainState) =>
    facts(d, { kind: 'idle' }, { reviewer: state });

  // A host may not stop a busy reviewer (DorkOS leaves it running), so a
  // second one would share its worktree: the run parks, holding the slot.
  it('a quiet reviewer parks rather than starting a second one, and keeps its slot', () => {
    const out = quietFor(reviewing, reviewerFacts(busy('2026-09-26T11:59:00.000Z')), 61);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(PARK_REASONS.reviewerQuiet(60));
    expect(out.drain.heldSlot).toBe('claude-code:claude4');
    expect(out.actions.some((a) => a.kind === 'start-reviewer')).toBe(false);
    // Kept, worktree and all: a reviewer stop would remove the worktree under it.
    expect(out.drain.reviewer).toEqual(REVIEWER);
    expect(out.actions).not.toContainEqual({ kind: 'stop', which: 'reviewer', handle: REVIEWER });
  });

  it('after an answer, flow watches the same reviewer again rather than starting another', () => {
    const quiet = reviewerFacts(busy('2026-09-26T11:59:00.000Z'));
    const parked = quietFor(reviewing, quiet, 61).drain;
    const out = drainStep(run(parked), quiet(parked), CFG, at(120));
    expect(out.run.drain?.phase).toBe('reviewing');
    expect(out.run.drain?.reviewer).toEqual(REVIEWER);
    expect(out.actions.some((a) => a.kind === 'start-reviewer')).toBe(false);
  });

  it('a reviewer that went away is restarted at the same commit, once', () => {
    const out = quietFor(reviewing, reviewerFacts(GONE), 61);
    expect(out.drain.phase).toBe('reviewing');
    expect(out.drain.nudges).toBe(1);
    expect(out.actions).toEqual([
      { kind: 'stop', which: 'reviewer', handle: REVIEWER },
      { kind: 'start-reviewer', sha: S, deltaFrom: null },
    ]);
  });

  it('a reviewer that went away after a restart parks the run', () => {
    const out = quietFor({ ...reviewing, nudges: 1 }, reviewerFacts(GONE), 61);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(PARK_REASONS.reviewerStopped);
  });

  it('an idle worker during a review is expected, not a stall', () => {
    const out = quietFor(reviewing, reviewerFacts(busy('2026-09-26T11:59:00.000Z')), 30);
    expect(out.actions).toEqual([]);
  });

  it('a busy reviewer whose host reports no activity is never judged', () => {
    const out = quietFor(reviewing, reviewerFacts({ kind: 'busy' }), 600);
    expect(out.actions).toEqual([]);
  });

  it('a reviewer the host cannot reach parks rather than starting a second one', () => {
    const unreachable: SessionState = { kind: 'unknown', reason: 'connect ECONNREFUSED' };
    const out = quietFor(reviewing, reviewerFacts(unreachable), 61);
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.parkedReason).toBe(
      PARK_REASONS.unreachable('reviewer', 60, 'connect ECONNREFUSED')
    );
    expect(out.actions.some((a) => a.kind === 'start-reviewer')).toBe(false);
  });
});

describe('lane supervisor: after a person answers', () => {
  it('a lane parked for going away twice gets its one restart back', () => {
    const parked = quietFor(drain('working', { restarts: 1 }), (d) => facts(d, GONE), 61).drain;
    const out = drainStep(run(parked), facts(parked, GONE), CFG, at(62));
    expect(out.run.drain?.phase).toBe('working');
    expect(out.run.drain?.restarts).toBe(0);
  });

  // The stall clock starts over from the answer: a session that is still
  // busy with the answer queued behind its turn is not parked again at once.
  it('the stall clock starts over, so the next pass does not park it again', () => {
    const quiet = (d: DrainState) => facts(d, busy('2026-09-26T11:59:00.000Z'));
    const parked = quietFor(drain('working'), quiet, 61).drain;
    const readopted = drainStep(run(parked), quiet(parked), CFG, at(120)).run.drain!;
    expect(readopted.phase).toBe('working');
    expect(readopted.progressAt).toBeNull();
    expect(readopted.heldSlot).toBeNull();
    const next = drainStep(run(readopted), quiet(readopted), CFG, at(121));
    expect(next.run.drain?.phase).toBe('working');
    expect(next.actions.some((a) => a.kind === 'park')).toBe(false);
  });
});

describe('lane supervisor: the slot a parked session holds', () => {
  const quiet = (d: DrainState) => facts(d, busy('2026-09-26T11:59:00.000Z'));

  it('a quiet DorkOS worker it parks keeps its account slot, since DorkOS does not stop it', () => {
    const out = quietFor(drain('working'), quiet, 61, { account: 'claude3' });
    expect(out.drain.heldSlot).toBe('claude-code:claude3');
  });

  it('frees the slot once the parked session stops, before anyone answers', () => {
    const parked = quietFor(drain('working'), quiet, 61, { account: 'claude3' }).drain;
    const closed = (d: DrainState) => ({
      ...facts(d, { kind: 'idle' }),
      item: { closed: false, claimed: true, needsInput: true, title: 'Export the report as CSV' },
    });
    const still = drainStep(
      run(parked),
      { ...closed(parked), worker: quiet(parked).worker },
      CFG,
      at(70)
    );
    expect(still.run.drain?.heldSlot).toBe('claude-code:claude3');
    const out = drainStep(run(parked), closed(parked), CFG, at(70));
    expect(out.run.drain?.phase).toBe('parked');
    expect(out.run.drain?.heldSlot).toBeNull();
  });

  it('a cli worker it parks holds nothing: its stop ends the process', () => {
    const cli = drain('working', { worker: { ...WORKER, host: 'cli' } });
    const out = quietFor(cli, quiet, 61, { account: 'claude3' });
    expect(out.drain.phase).toBe('parked');
    expect(out.drain.heldSlot ?? null).toBeNull();
  });

  it('a limit pauses the supervisor and clears its clock, so it starts over after', () => {
    const seen = drainStep(run(drain('working')), quiet(drain('working')), CFG, T0).run.drain!;
    expect(seen.progressAt).toBe(T0.toISOString());
    const limit = {
      state: 'waiting',
      window: 'five_hour',
      resetsAt: null,
      since: T0.toISOString(),
    } as unknown as FlowRun['limit'];
    const out = drainStep(run(seen, { limit }), quiet(seen), CFG, at(30));
    expect(out.run.drain?.progressAt ?? null).toBeNull();
  });
});
