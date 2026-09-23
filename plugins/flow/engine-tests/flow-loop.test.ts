/**
 * Fail-open safety suite for the `/flow auto` Stop hook (`hooks/flow-loop.mjs`).
 *
 * The hook runs on EVERY session's Stop. The single most important invariant is
 * that a session with NO active `/flow auto` run ALWAYS allows the stop — getting
 * this wrong would trap every session in an infinite loop. The hook's decision is
 * the pure exported {@link decideStop}; this suite pins its fail-open behavior.
 *
 * The hook is plain `.mjs` (no types) and lives outside `packages/flow`; it is
 * imported by relative path. `src/__tests__/**` is excluded from this package's
 * tsc, so the untyped import is fine — vitest resolves it at runtime.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — untyped .mjs hook imported by relative path for its pure decision fn.
import { decideStop, readSessionId } from '../hooks/flow-loop.mjs';

/** The session that started the drain, recorded in every live sentinel below. */
const OWNER = 'owner-session';
/** Context for a Stop from the drain's own session. */
const asOwner = { sessionId: OWNER };

describe('flow-loop decideStop — FAIL OPEN safety (no active /flow auto run → allow stop)', () => {
  it('allows stop when the sentinel is absent (null) — the normal session case', () => {
    expect(decideStop('any output', null).decision).toBe('allow-stop');
  });

  it('allows stop when the sentinel is a non-object (malformed/unreadable → null upstream)', () => {
    expect(decideStop('', null).decision).toBe('allow-stop');
  });

  it('allows stop when the sentinel exists but active is not true', () => {
    expect(decideStop('', { active: false, ready: 5 }).decision).toBe('allow-stop');
    expect(decideStop('', { ready: 5 }).decision).toBe('allow-stop');
  });

  it('allows stop when an active run has drained the queue (ready <= 0 or absent)', () => {
    const run = { active: true, sessionId: OWNER };
    expect(decideStop('', { ...run, ready: 0 }, asOwner).decision).toBe('allow-stop');
    expect(decideStop('', run, asOwner).decision).toBe('allow-stop');
    expect(decideStop('', { ...run, ready: -1 }, asOwner).decision).toBe('allow-stop');
  });
});

describe('flow-loop decideStop — blocks ONLY an explicitly active drain with ready work', () => {
  it('blocks stop when an active /flow auto run reports ready work', () => {
    const result = decideStop('working...', { active: true, ready: 3, sessionId: OWNER }, asOwner);
    expect(result.decision).toBe('block-stop');
    expect(result.reason).toContain('3');
  });
});

describe("flow-loop decideStop — only the drain's own session is ever held", () => {
  const live = { active: true, ready: 3, sessionId: OWNER, pid: 1234 };

  it('lets every other session stop, quietly, while a live drain runs', () => {
    const result = decideStop('working...', live, {
      sessionId: 'someone-else',
      ownerLiveness: 'alive',
    });
    expect(result.decision).toBe('allow-stop');
    expect(result.quiet).toBe(true);
    expect(result.reap).toBeFalsy();
  });

  it('lets a session stop when its own id is unknown, since it cannot be the owner', () => {
    expect(decideStop('', live, { ownerLiveness: 'alive' }).decision).toBe('allow-stop');
    expect(decideStop('', live, { sessionId: '', ownerLiveness: 'alive' }).decision).toBe(
      'allow-stop'
    );
  });

  it('holds nobody when the sentinel records no owner, not even a caller that claims one', () => {
    // A sentinel written before sessionId existed, or by a harness that could
    // not fill ${CLAUDE_SESSION_ID}: the owner cannot be told apart, so fail open.
    const legacy = { active: true, ready: 3 };
    expect(decideStop('', legacy, asOwner).decision).toBe('allow-stop');
    expect(decideStop('', { ...legacy, sessionId: '' }, asOwner).decision).toBe('allow-stop');
    expect(decideStop('', { ...legacy, sessionId: 42 }, asOwner).decision).toBe('allow-stop');
  });

  it("ignores another session's ABORT: it cannot end a drain it never started", () => {
    const result = decideStop('<promise>ABORT</promise>', live, {
      sessionId: 'someone-else',
      ownerLiveness: 'alive',
    });
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBeFalsy();
  });

  it('never touches a drain that finished for another session to report on', () => {
    // The owner reaps its own finished drain; a stranger leaves it alone.
    const done = { active: true, ready: 0, sessionId: OWNER };
    expect(decideStop('', done, { sessionId: 'someone-else' }).reap).toBeFalsy();
  });

  it('still lets any session reap an orphan, so garbage never waits for its dead owner', () => {
    const dead = decideStop('', live, { sessionId: 'someone-else', ownerLiveness: 'dead' });
    expect(dead.decision).toBe('allow-stop');
    expect(dead.reap).toBe(true);
  });
});

describe("flow-loop readSessionId — the stopping session's id from the Stop payload", () => {
  it('reads session_id from the payload Claude Code sends', () => {
    const payload = JSON.stringify({
      session_id: 'af930891-a2a5-4caa-9432-44161b771628',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'done',
    });
    expect(readSessionId(payload)).toBe('af930891-a2a5-4caa-9432-44161b771628');
  });

  it('returns undefined for anything that is not a usable id', () => {
    expect(readSessionId('')).toBeUndefined();
    expect(readSessionId('plain text, not json')).toBeUndefined();
    expect(readSessionId('{"session_id":""}')).toBeUndefined();
    expect(readSessionId('{"session_id":7}')).toBeUndefined();
    expect(readSessionId('null')).toBeUndefined();
  });
});

describe('flow-loop decideStop — STARVED drain (ready 0 but shapeable > 0) surfaces a triage prompt', () => {
  it('allows stop but names the starvation when shapeable work waits behind the gate', () => {
    // ready 0 + shapeable 4: the queue is starved, not done. A terminal drain
    // cannot triage itself, so allow the stop, but tell the operator to triage.
    const result = decideStop(
      '',
      { active: true, ready: 0, shapeable: 4, sessionId: OWNER },
      asOwner
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reason).toContain('starved');
    expect(result.reason).toContain('triage');
  });

  it('reports a genuine drain complete when nothing is shapeable', () => {
    // ready 0 + shapeable 0: genuinely drained — the original "drain complete" path.
    const result = decideStop(
      '',
      { active: true, ready: 0, shapeable: 0, sessionId: OWNER },
      asOwner
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reason).toContain('drain complete');
  });

  it('still BLOCKS an active drain with ready work, regardless of shapeable', () => {
    // ready 2: the blocking path is unchanged; shapeable is irrelevant when ready > 0.
    const result = decideStop('working...', { active: true, ready: 2, sessionId: OWNER }, asOwner);
    expect(result.decision).toBe('block-stop');
    expect(result.reason).toContain('2');
  });
});

describe('flow-loop decideStop — explicit signals override the sentinel (always allow stop)', () => {
  it('PHASE_COMPLETE allows stop even with an active, ready drain', () => {
    const result = decideStop(
      'done <promise>PHASE_COMPLETE:auto</promise>',
      { active: true, ready: 9, sessionId: OWNER },
      asOwner
    );
    expect(result.decision).toBe('allow-stop');
  });

  it('ABORT allows stop even with an active, ready drain', () => {
    const result = decideStop(
      'stopping <promise>ABORT</promise>',
      { active: true, ready: 9, sessionId: OWNER },
      asOwner
    );
    expect(result.decision).toBe('allow-stop');
  });
});

describe('flow-loop decideStop — a sentinel is only as good as its owner (DOR-1679)', () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.parse('2026-09-20T12:00:00.000Z');
  const fresh = (agoMs: number) => new Date(NOW - agoMs).toISOString();

  it('keeps the pre-DOR-1679 behavior when the sentinel records no usable pid', () => {
    // 'unknown' liveness is the default, so a sentinel without a pid decides on
    // active/ready alone — exactly as it did before owner liveness existed.
    const live = { active: true, ready: 3, startedAt: fresh(HOUR), sessionId: OWNER };
    expect(decideStop('', live, { ...asOwner, ownerLiveness: 'unknown', now: NOW }).decision).toBe(
      'block-stop'
    );
    expect(decideStop('', live, { ...asOwner, now: NOW }).decision).toBe('block-stop');
  });

  it('allows the stop and reaps when the drain owner is dead', () => {
    // The reported bug: pid 49658 was gone, the file still said active, and the
    // banner re-fired on every Stop of every later session in the repo.
    const result = decideStop(
      '',
      {
        active: true,
        ready: 6,
        shapeable: 108,
        startedAt: fresh(HOUR),
        pid: 49658,
        sessionId: OWNER,
      },
      { ...asOwner, ownerLiveness: 'dead', now: NOW }
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
    expect(result.reason).toContain('49658');
  });

  it('still blocks for a live owner with ready work inside the TTL', () => {
    const result = decideStop(
      '',
      { active: true, ready: 3, startedAt: fresh(2 * HOUR), pid: 1234, sessionId: OWNER },
      { ...asOwner, ownerLiveness: 'alive', now: NOW }
    );
    expect(result.decision).toBe('block-stop');
    expect(result.reap).toBeFalsy();
  });

  it('presumes a recycled pid once an active sentinel outlives the TTL', () => {
    // A live probe is not proof: a recycled pid looks alive. Age bounds belief.
    const result = decideStop(
      '',
      { active: true, ready: 3, startedAt: fresh(30 * HOUR), pid: 1234, sessionId: OWNER },
      { ...asOwner, ownerLiveness: 'alive', now: NOW }
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
    expect(result.reason).toContain('presumed gone');
  });

  it('ignores an unparseable or absent startedAt rather than reaping on it', () => {
    const alive = { ...asOwner, ownerLiveness: 'alive', now: NOW };
    const noStamp = { active: true, ready: 3, pid: 1234, sessionId: OWNER };
    expect(decideStop('', noStamp, alive).decision).toBe('block-stop');
    const junkStamp = { ...noStamp, startedAt: 'whenever' };
    expect(decideStop('', junkStamp, alive).decision).toBe('block-stop');
  });

  it('never reaps a paused sentinel, even when its owner is dead', () => {
    // active:false is what /flow:pause writes and /flow:resume reads back.
    // Deleting it would silently discard the operator's paused drain.
    const result = decideStop(
      '',
      { active: false, ready: 5, pid: 49658, sessionId: OWNER },
      { ...asOwner, ownerLiveness: 'dead', now: NOW }
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBeFalsy();
  });
});

describe('flow-loop decideStop — the advertised escape hatch actually clears the sentinel', () => {
  it('reaps the sentinel on ABORT, so the banner does not re-fire on the next Stop', () => {
    const result = decideStop(
      '<promise>ABORT</promise>',
      { active: true, ready: 3, sessionId: OWNER },
      asOwner
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
  });

  it('reaps the sentinel on PHASE_COMPLETE too', () => {
    const result = decideStop(
      '<promise>PHASE_COMPLETE:auto</promise>',
      { active: true, ready: 3, sessionId: OWNER },
      asOwner
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
  });

  it('has nothing to reap when a signal fires with no sentinel or a paused one', () => {
    expect(decideStop('<promise>ABORT</promise>', null, asOwner).reap).toBeFalsy();
    expect(
      decideStop('<promise>ABORT</promise>', { active: false, sessionId: OWNER }, asOwner).reap
    ).toBeFalsy();
  });

  it('reaps a drain that finished or starved, so it cannot outlive its owner', () => {
    const run = { active: true, ready: 0, sessionId: OWNER };
    expect(decideStop('', { ...run, shapeable: 0 }, asOwner).reap).toBe(true);
    expect(decideStop('', { ...run, shapeable: 4 }, asOwner).reap).toBe(true);
  });
});
