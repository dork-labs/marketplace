/**
 * The handoff state machine (spec `flow-handoff-dispatch` §5.2, §5.2a, task
 * 4.1): one case per row of the table, in both `auto` and `ask` mode where the
 * mode matters, plus the signal combination, the model-fallback pick and the
 * waiting-reset wake time. Every case is pure: `now` is fixed and no file is
 * read.
 */

import { describe, expect, it } from 'vitest';

import type { LimitSignal } from '../../scripts/drain/account-rank.ts';
import {
  combineSignal,
  nextHandoffAction,
  pickFallbackModel,
  UNKNOWN_RESET_WAIT_MS,
  type HandoffAction,
  type HandoffInput,
} from '../../scripts/drain/handoff.ts';
import { render } from '../../scripts/drain/messages.ts';
import type { DrainState, RunLimit } from '../../scripts/drain/state.ts';
import type { ResolvedAccountPolicy } from '../../scripts/fleet/accounts.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import type { SessionState } from '../../scripts/launchers/types.ts';

const FLOW = 'node --experimental-strip-types /opt/flow/scripts/flow.ts';
const NOW = new Date('2026-09-26T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const SINCE = at(-5);
const PICK = { runtime: 'claude-code' as const, id: 'claude4' };
const MODES = ['auto', 'ask'] as const;

const OK: LimitSignal = { level: 'ok', window: null, resetsAt: null, cause: null };
const WARN: LimitSignal = { level: 'warning', window: 'seven_day', resetsAt: at(600), cause: null };
const OUT: LimitSignal = {
  level: 'exhausted',
  window: 'five_hour',
  resetsAt: at(180),
  cause: 'limit',
};
const IDLE: SessionState = { kind: 'idle' };
const BUSY: SessionState = { kind: 'busy' };

/** A drain in `working` with a started worker on claude3. */
function drain(overrides: Partial<DrainState> = {}): DrainState {
  return {
    v: 1,
    rev: 3,
    phase: 'working',
    worker: {
      host: 'cli',
      runtime: 'claude-code',
      sessionId: 'w-1',
      account: 'claude3',
      cwd: '/wt',
    },
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
    ...overrides,
  };
}

/** A run on claude3 (claude-code, cli). */
function run(limit?: Partial<RunLimit>, drainOverrides: Partial<DrainState> = {}): FlowRun {
  const base: FlowRun = {
    issueId: 'i-1',
    identifier: 'ACME-1',
    sessionId: 'w-1',
    worktreePath: '/wt',
    branch: 'ACME-1-x',
    stage: 'execute',
    status: 'running',
    attemptCount: 1,
    workerPid: 10,
    startedAt: at(-60),
    account: 'claude3',
    host: 'cli',
    runtime: 'claude-code',
    drain: drain(drainOverrides),
  };
  if (limit !== undefined) base.limit = episode(limit);
  return base;
}

/** An episode on claude3, with overrides. */
function episode(overrides: Partial<RunLimit> = {}): RunLimit {
  return {
    level: 'exhausted',
    account: 'claude3',
    window: 'five_hour',
    resetsAt: at(180),
    cause: 'limit',
    since: SINCE,
    state: 'awaiting-handoff',
    handoffToken: null,
    handingOffAt: null,
    handoffSessionId: null,
    notifiedAt: null,
    ...overrides,
  };
}

/** The input, with the defaults every case shares. */
function input(overrides: Partial<HandoffInput> & { mode?: 'auto' | 'ask' } = {}): HandoffInput {
  const { mode = 'auto', ...rest } = overrides;
  return {
    run: run(),
    signal: OK,
    session: IDLE,
    reviewer: null,
    checkpoint: null,
    policy: { handoff: mode, crossRuntimeFallback: 'off' },
    candidates: { pick: PICK, resets: [] },
    modelFallback: null,
    accountLabel: 'Claude 3',
    now: NOW,
    cfg: {
      windDownGraceMinutes: 20,
      waitIfResetWithinMinutes: 60,
      startTimeoutMs: 90_000,
      flow: FLOW,
    },
    ...rest,
  };
}

/** The action kinds, in order. */
const kinds = (actions: HandoffAction[]) =>
  actions.map((a) => (a.kind === 'send' ? `send:${a.message}` : a.kind));

/** A fresh limit-warning checkpoint. */
const WARNED = { trigger: 'limit-warning', writtenAt: at(-1) };

describe('no episode yet', () => {
  it.each(MODES)('(%s) a warning starts winding down and sends wind-down', (mode) => {
    // Purpose: the §5.2 first row; the worker is told to finish, checkpoint and stop.
    const out = nextHandoffAction(input({ mode, signal: WARN, session: BUSY }));
    expect(out.run.limit).toMatchObject({
      level: 'warning',
      state: 'winding-down',
      account: 'claude3',
      window: 'seven_day',
      since: NOW.toISOString(),
      notifiedAt: null,
    });
    expect(kinds(out.actions)).toEqual(['send:wind-down']);
    const send = out.actions[0] as Extract<HandoffAction, { kind: 'send' }>;
    expect(render(send.message, send.ctx as never)).toContain('--trigger limit-warning');
  });

  it('an ok or unknown signal changes nothing', () => {
    // Purpose: a healthy account is no episode.
    for (const level of ['ok', 'unknown'] as const) {
      const out = nextHandoffAction(input({ signal: { ...OK, level } }));
      expect(out.run.limit).toBeUndefined();
      expect(out.actions).toEqual([]);
    }
  });

  it('exhausted in auto: synthesizes a checkpoint and hands off in the same pass', () => {
    // Purpose: DOR-2374's criterion; a hard limit mid-item moves with no operator action.
    const out = nextHandoffAction(input({ signal: OUT }));
    expect(kinds(out.actions)).toEqual(['synthesize-checkpoint', 'handoff']);
    expect(out.actions[1]).toEqual({ kind: 'handoff', to: PICK, reason: 'rejected' });
    // The move clears the limit; until then it stays, so nothing else talks to the worker.
    expect(out.run.limit).toMatchObject({ level: 'exhausted', state: 'awaiting-handoff' });
  });

  it('exhausted in ask: parks as pending-approval and notifies once, naming the candidate', () => {
    // Purpose: in ask mode the run waits and says why, starting nothing.
    const out = nextHandoffAction(input({ mode: 'ask', signal: OUT }));
    expect(kinds(out.actions)).toEqual(['synthesize-checkpoint', 'notify']);
    expect(out.actions[1]).toEqual({ kind: 'notify', candidate: PICK });
    expect(out.run.limit).toMatchObject({
      state: 'pending-approval',
      notifiedAt: NOW.toISOString(),
      candidate: 'claude-code:claude4',
    });
  });

  it('a reserve cause runs the same machine', () => {
    // Purpose: §5.2 "the same machine runs whether the cause is the real limit or the reserve".
    const out = nextHandoffAction(
      input({ signal: { ...OUT, window: 'seven_day', cause: 'reserve' } })
    );
    expect(out.run.limit?.cause).toBe('reserve');
    expect(kinds(out.actions)).toEqual(['synthesize-checkpoint', 'handoff']);
  });
});

describe('winding-down', () => {
  const winding = {
    level: 'warning' as const,
    state: 'winding-down' as const,
    window: 'seven_day',
  };

  it('a warning that clears before a handoff ends the episode; a stopped worker is told to go on', () => {
    // Purpose: a window reset mid wind-down resumes the same session, and a busy one is left alone.
    const idle = nextHandoffAction(input({ run: run(winding), signal: OK, session: IDLE }));
    expect(idle.run.limit).toBeUndefined();
    expect(kinds(idle.actions)).toEqual(['send:limit-cleared']);
    const busy = nextHandoffAction(input({ run: run(winding), signal: OK, session: BUSY }));
    expect(busy.run.limit).toBeUndefined();
    expect(busy.actions).toEqual([]);
  });

  it.each(MODES)('(%s) turning exhausted moves on to the handoff rows', (mode) => {
    // Purpose: winding-down + exhausted -> awaiting-handoff, decided in the same pass.
    const out = nextHandoffAction(input({ mode, run: run(winding), signal: OUT, session: IDLE }));
    expect(out.run.limit?.level).toBe('exhausted');
    expect(kinds(out.actions)).toEqual([
      'synthesize-checkpoint',
      mode === 'auto' ? 'handoff' : 'notify',
    ]);
  });

  it.each(MODES)(
    '(%s) a limit-warning checkpoint after `since` and a stopped worker hand off with no synthesis',
    (mode) => {
      // Purpose: the worker did its part; its own checkpoint is used.
      const out = nextHandoffAction(
        input({ mode, run: run(winding), signal: WARN, session: IDLE, checkpoint: WARNED })
      );
      expect(kinds(out.actions)).toEqual([mode === 'auto' ? 'handoff' : 'notify']);
      if (mode === 'auto') expect(out.actions[0]).toMatchObject({ reason: 'warning' });
    }
  );

  it('an older checkpoint, a task checkpoint, or a busy worker keeps winding down', () => {
    // Purpose: only a fresh limit-warning checkpoint plus a stopped worker counts as wound down.
    const cases: Partial<HandoffInput>[] = [
      { checkpoint: { trigger: 'limit-warning', writtenAt: at(-10) }, session: IDLE },
      { checkpoint: { trigger: 'task', writtenAt: at(-1) }, session: IDLE },
      { checkpoint: WARNED, session: BUSY },
    ];
    for (const c of cases) {
      const out = nextHandoffAction(input({ run: run(winding), signal: WARN, ...c }));
      expect(out.run.limit?.state).toBe('winding-down');
      expect(out.actions).toEqual([]);
    }
  });

  it('a stopped worker with no checkpoint past the grace time gets a synthesized one, then moves', () => {
    // Purpose: the second synthesize path (a worker that ignored the wind-down).
    const early = nextHandoffAction(
      input({ run: run({ ...winding, since: at(-19) }), signal: WARN, session: IDLE })
    );
    expect(early.actions).toEqual([]);
    const late = nextHandoffAction(
      input({ run: run({ ...winding, since: at(-20) }), signal: WARN, session: IDLE })
    );
    expect(kinds(late.actions)).toEqual(['synthesize-checkpoint', 'handoff']);
    const busy = nextHandoffAction(
      input({ run: run({ ...winding, since: at(-60) }), signal: WARN, session: BUSY })
    );
    expect(busy.actions).toEqual([]);
  });
});

describe('awaiting-handoff', () => {
  it('synthesizes first only when no checkpoint is newer than the episode', () => {
    // Purpose: the first synthesize path, and that a newer checkpoint is reused.
    const without = nextHandoffAction(input({ run: run({}), signal: OUT }));
    expect(kinds(without.actions)).toEqual(['synthesize-checkpoint', 'handoff']);
    const newer = nextHandoffAction(
      input({ run: run({}), signal: OUT, checkpoint: { trigger: 'task', writtenAt: at(-1) } })
    );
    expect(kinds(newer.actions)).toEqual(['handoff']);
  });

  it.each(MODES)('(%s) no candidate waits for the earliest known reset', (mode) => {
    // Purpose: wakeAfter is the soonest future reset of this account and every limited candidate.
    const out = nextHandoffAction(
      input({
        mode,
        run: run({ resetsAt: at(300) }),
        signal: { ...OUT, resetsAt: at(300) },
        candidates: { pick: null, resets: [at(240), null, at(-5), at(400)] },
        checkpoint: WARNED,
      })
    );
    expect(out.run.limit?.state).toBe('waiting-reset');
    expect(out.run.drain?.wakeAfter).toBe(at(240));
    expect(out.actions).toEqual([]);
  });

  it('no candidate and no known reset waits 30 minutes', () => {
    // Purpose: an unknown reset still wakes the run again.
    const out = nextHandoffAction(
      input({
        run: run({ resetsAt: null }),
        signal: { ...OUT, resetsAt: null },
        candidates: { pick: null, resets: [null] },
        checkpoint: WARNED,
      })
    );
    expect(out.run.drain?.wakeAfter).toBe(
      new Date(NOW.getTime() + UNKNOWN_RESET_WAIT_MS).toISOString()
    );
  });
});

describe('wait if the reset is soon (§5.2a)', () => {
  it.each(MODES)(
    '(%s) a reset within the threshold waits on the same account, even with a candidate',
    (mode) => {
      // Purpose: the warm session is kept; ask needs no approval for it.
      const out = nextHandoffAction(
        input({ mode, run: run({ resetsAt: at(60) }), signal: { ...OUT, resetsAt: at(60) } })
      );
      expect(out.run.limit?.state).toBe('waiting-reset');
      expect(out.run.drain?.wakeAfter).toBe(at(60));
      expect(out.actions).toEqual([]);
    }
  );

  it.each(MODES)('(%s) one minute past the threshold hands off or asks', (mode) => {
    // Purpose: the other side of the threshold.
    const out = nextHandoffAction(
      input({ mode, run: run({ resetsAt: at(61) }), signal: { ...OUT, resetsAt: at(61) } })
    );
    expect(kinds(out.actions)).toContain(mode === 'auto' ? 'handoff' : 'notify');
  });

  it('a reset already in the past does not wait again', () => {
    // Purpose: a stale ledger at wake time must not loop on waiting forever.
    const out = nextHandoffAction(
      input({
        run: run({ state: 'waiting-reset', resetsAt: at(-1) }, { wakeAfter: at(-1) }),
        signal: { ...OUT, resetsAt: at(-1) },
        checkpoint: WARNED,
      })
    );
    expect(kinds(out.actions)).toEqual(['handoff']);
  });
});

describe('model fallback (§5.2a)', () => {
  const opus = { window: 'seven_day_opus', resetsAt: at(3000) };

  it.each(MODES)('(%s) continues the same session on the next model, with no handoff', (mode) => {
    // Purpose: only the model's bucket is out, so the session switches model instead of moving.
    const out = nextHandoffAction(
      input({ mode, run: run(opus), signal: { ...OUT, ...opus }, modelFallback: 'sonnet-x' })
    );
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: 'send', message: 'limit-cleared', model: 'sonnet-x' }),
    ]);
    const send = out.actions[0] as Extract<HandoffAction, { kind: 'send' }>;
    expect(render(send.message, send.ctx as never)).toContain('now runs on sonnet-x');
  });

  it('is skipped for an account-wide window, with no fallback model, or after the host refused', () => {
    // Purpose: the row applies only when every condition holds.
    const cases: HandoffInput[] = [
      input({ run: run({}), signal: OUT, modelFallback: 'sonnet-x' }),
      input({ run: run(opus), signal: { ...OUT, ...opus }, modelFallback: null }),
      input({
        run: run({ ...opus, modelSwitch: 'unsupported' }),
        signal: { ...OUT, ...opus },
        modelFallback: 'sonnet-x',
      }),
    ];
    for (const c of cases) expect(kinds(nextHandoffAction(c).actions)).toContain('handoff');
  });
});

describe('pending-approval and waiting-reset', () => {
  it('pending-approval resumes the same session once its own account is ok (ask needs no approval)', () => {
    // Purpose: Decision D5; the reset keeps the warm transcript.
    // `unknown` counts too: a bound model's bucket the ledger never saw is no reading, not a limit.
    for (const level of ['ok', 'unknown'] as const) {
      const out = nextHandoffAction(
        input({
          mode: 'ask',
          run: run({ state: 'pending-approval', notifiedAt: at(-3) }),
          signal: { ...OK, level },
        })
      );
      expect(out.run.limit).toBeUndefined();
      expect(kinds(out.actions)).toEqual(['send:limit-cleared']);
      expect(out.run.drain?.handoffs.at(-1)).toMatchObject({
        from: 'claude3',
        to: 'claude3',
        reason: 'reset',
      });
    }
  });

  it('pending-approval with the account still out does nothing more', () => {
    // Purpose: ask notifies exactly once per episode; a second pass posts nothing.
    const out = nextHandoffAction(
      input({
        mode: 'ask',
        run: run({ state: 'pending-approval', notifiedAt: at(-3) }),
        signal: OUT,
      })
    );
    expect(out.actions).toEqual([]);
  });

  it('ask notifies again for a new episode', () => {
    // Purpose: once per episode, not once ever: a cleared episode resets notifiedAt.
    const first = nextHandoffAction(input({ mode: 'ask', signal: OUT, checkpoint: WARNED }));
    expect(kinds(first.actions).filter((k) => k === 'notify')).toHaveLength(1);
    const cleared = nextHandoffAction(input({ mode: 'ask', run: first.run, signal: OK }));
    expect(cleared.run.limit).toBeUndefined();
    const again = nextHandoffAction(
      input({ mode: 'ask', run: cleared.run, signal: OUT, checkpoint: WARNED })
    );
    expect(kinds(again.actions).filter((k) => k === 'notify')).toHaveLength(1);
    expect(again.run.limit?.notifiedAt).toBe(NOW.toISOString());
  });

  it('waiting-reset sleeps until wakeAfter', () => {
    // Purpose: nothing is decided before the wake time.
    const out = nextHandoffAction(
      input({ run: run({ state: 'waiting-reset' }, { wakeAfter: at(10) }), signal: OUT })
    );
    expect(out.actions).toEqual([]);
    expect(out.run.limit?.state).toBe('waiting-reset');
  });

  it.each(MODES)('(%s) at wakeAfter an ok account resumes here', (mode) => {
    // Purpose: the reset resumes the same session with limit-cleared.
    const out = nextHandoffAction(
      input({ mode, run: run({ state: 'waiting-reset' }, { wakeAfter: at(-1) }), signal: OK })
    );
    expect(out.run.limit).toBeUndefined();
    expect(out.run.drain?.wakeAfter).toBeNull();
    expect(kinds(out.actions)).toEqual(['send:limit-cleared']);
  });

  it.each(MODES)(
    '(%s) at wakeAfter with the account still out it acts as awaiting-handoff',
    (mode) => {
      // Purpose: auto hands off, ask notifies (once).
      const out = nextHandoffAction(
        input({
          mode,
          run: run({ state: 'waiting-reset' }, { wakeAfter: at(-1) }),
          signal: OUT,
          checkpoint: WARNED,
        })
      );
      expect(kinds(out.actions)).toEqual([mode === 'auto' ? 'handoff' : 'notify']);
    }
  );
});

describe("a person's wait (§5.2a)", () => {
  const held = { state: 'waiting-reset' as const, heldBy: 'person' as const, heldUntil: at(120) };

  it.each(MODES)('(%s) outranks every automatic move while it holds', (mode) => {
    // Purpose: no candidate moves a held run, even past drain.wakeAfter.
    const out = nextHandoffAction(
      input({ mode, run: run(held, { wakeAfter: at(-10) }), signal: OUT, checkpoint: WARNED })
    );
    expect(out.actions).toEqual([]);
    expect(out.run.limit?.heldBy).toBe('person');
  });

  it('resumes here when the account is ok again', () => {
    // Purpose: waiting was the point; the reset ends it.
    const out = nextHandoffAction(input({ run: run(held), signal: OK }));
    expect(out.run.limit).toBeUndefined();
    expect(kinds(out.actions)).toEqual(['send:limit-cleared']);
  });

  it('lifts when its time passes, and the run then moves as usual', () => {
    // Purpose: "the time passing releases it".
    const out = nextHandoffAction(
      input({ run: run({ ...held, heldUntil: at(-1) }), signal: OUT, checkpoint: WARNED })
    );
    expect(out.run.limit?.heldBy).toBeUndefined();
    expect(kinds(out.actions)).toEqual(['handoff']);
  });
});

describe('cross-runtime continuation (§5.2a)', () => {
  const codex = { runtime: 'codex' as const, id: 'default' };

  it('an other-runtime pick is ignored while crossRuntimeFallback is off', () => {
    // Purpose: flow never swaps runtime unless the operator turned it on.
    const out = nextHandoffAction(
      input({
        run: run({}),
        signal: OUT,
        checkpoint: WARNED,
        candidates: { pick: codex, resets: [] },
      })
    );
    expect(out.run.limit?.state).toBe('waiting-reset');
    expect(out.actions).toEqual([]);
  });

  it('with it on, the run moves to the other runtime', () => {
    // Purpose: HANDOFF.md is runtime-neutral, so the move may cross.
    const out = nextHandoffAction(
      input({
        run: run({}),
        signal: OUT,
        checkpoint: WARNED,
        candidates: { pick: codex, resets: [] },
        policy: { handoff: 'auto', crossRuntimeFallback: 'on' },
      })
    );
    expect(out.actions).toEqual([{ kind: 'handoff', to: codex, reason: 'rejected' }]);
  });
});

describe('handing-off', () => {
  it('a fresh mark waits for its mover; a stale one is adopted or reverted', () => {
    // Purpose: the mover died between the compare-and-set and the rewrite.
    const fresh = nextHandoffAction(
      input({ run: run({ state: 'handing-off', handingOffAt: at(-1) }), signal: OUT })
    );
    expect(fresh.actions).toEqual([]);
    const stale = nextHandoffAction(
      input({ run: run({ state: 'handing-off', handingOffAt: at(-2) }), signal: OUT })
    );
    expect(stale.actions).toEqual([{ kind: 'adopt-or-revert-handoff' }]);
  });
});

describe('reviewers', () => {
  it('a limited reviewer restarts on another account, with no episode', () => {
    // Purpose: a review restarts cheaply; the reviewer is not handed off.
    const reviewer = {
      host: 'cli' as const,
      runtime: 'claude-code' as const,
      sessionId: 'r-1',
      account: 'claude5',
      cwd: '/review',
      sha: 'abc',
      worktree: '/review',
      tokenHash: 'h',
    };
    const out = nextHandoffAction(
      input({
        run: run(undefined, { phase: 'reviewing', reviewer }),
        reviewer: { kind: 'limited', window: 'five_hour', resetsAt: at(60) },
        signal: OK,
        session: IDLE,
      })
    );
    expect(out.run.limit).toBeUndefined();
    expect(out.run.drain?.reviewer).toBeNull();
    expect(out.actions).toEqual([
      expect.objectContaining({ kind: 'restart-reviewer', exclude: 'claude-code:claude5' }),
    ]);
  });
});

describe('the signal', () => {
  it('the ambient account uses the launcher state alone', () => {
    // Purpose: no ledger; a limited session is exhausted, anything else is ok.
    expect(
      combineSignal(null, { kind: 'limited', window: 'five_hour', resetsAt: at(30) }, NOW)
    ).toEqual({
      level: 'exhausted',
      window: 'five_hour',
      resetsAt: at(30),
      cause: 'limit',
    });
    expect(combineSignal(null, BUSY, NOW).level).toBe('ok');
    // A stopped session keeps reporting its last limit; once it reset, it no longer counts.
    expect(
      combineSignal(null, { kind: 'limited', window: null, resetsAt: at(-1) }, NOW).level
    ).toBe('ok');
  });

  it('is the worse of the ledger and the launcher', () => {
    // Purpose: limited counts as exhausted even when the ledger lags.
    expect(combineSignal(WARN, { kind: 'limited', window: null, resetsAt: null }, NOW).level).toBe(
      'exhausted'
    );
    expect(combineSignal(OUT, IDLE, NOW)).toEqual(OUT);
  });
});

describe('pickFallbackModel', () => {
  const policy: ResolvedAccountPolicy = {
    runtime: 'claude-code',
    id: 'claude3',
    key: 'claude-code:claude3',
    role: 'rotation',
    reservePct: 0,
    spendDownWindowHours: 24,
    scope: { repos: [] },
  };
  const reading = (usedPct: number, status = 'allowed') => ({
    usedPct,
    resetsAt: at(3000),
    status,
    observedAt: at(-1),
    source: 'statusline',
  });
  const base = {
    runtime: 'claude-code' as const,
    list: ['opus', 'sonnet'],
    bindings: { opus: 'claude-opus-4', sonnet: 'claude-sonnet-4' },
    current: 'claude-opus-4',
    policy,
    warnMarginPct: 10,
    canSwitch: true,
    now: NOW,
  };
  const windows = {
    five_hour: reading(20),
    seven_day: reading(30),
    seven_day_opus: reading(100, 'rejected'),
  };

  it('picks the next listed model whose bucket has room', () => {
    // Purpose: the list resolves through models.bindings and is walked from the current model on.
    expect(pickFallbackModel({ ...base, windows })).toBe('claude-sonnet-4');
  });

  it('gives none when the host cannot switch, the list is empty, the account is out, or the next is out too', () => {
    // Purpose: every condition of the §5.2a row.
    expect(pickFallbackModel({ ...base, windows, canSwitch: false })).toBeNull();
    expect(pickFallbackModel({ ...base, windows, list: [] })).toBeNull();
    expect(
      pickFallbackModel({ ...base, windows: { ...windows, five_hour: reading(100, 'rejected') } })
    ).toBeNull();
    expect(
      pickFallbackModel({
        ...base,
        windows: { ...windows, seven_day_sonnet: reading(100, 'rejected') },
      })
    ).toBeNull();
    expect(pickFallbackModel({ ...base, windows, current: 'claude-sonnet-4' })).toBeNull();
  });
});
