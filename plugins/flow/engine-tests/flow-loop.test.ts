/**
 * Fail-open safety suite for the `/flow auto` Stop hook (`.claude/hooks/flow-loop.mjs`).
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
import { decideStop } from '../hooks/flow-loop.mjs';

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
    expect(decideStop('', { active: true, ready: 0 }).decision).toBe('allow-stop');
    expect(decideStop('', { active: true }).decision).toBe('allow-stop');
    expect(decideStop('', { active: true, ready: -1 }).decision).toBe('allow-stop');
  });
});

describe('flow-loop decideStop — blocks ONLY an explicitly active drain with ready work', () => {
  it('blocks stop when an active /flow auto run reports ready work', () => {
    const result = decideStop('working...', { active: true, ready: 3 });
    expect(result.decision).toBe('block-stop');
    expect(result.reason).toContain('3');
  });
});

describe('flow-loop decideStop — STARVED drain (ready 0 but shapeable > 0) surfaces a triage prompt', () => {
  it('allows stop but names the starvation when shapeable work waits behind the gate', () => {
    // ready 0 + shapeable 4: the queue is starved, not done. A terminal drain
    // cannot triage itself, so allow the stop, but tell the operator to triage.
    const result = decideStop('', { active: true, ready: 0, shapeable: 4 });
    expect(result.decision).toBe('allow-stop');
    expect(result.reason).toContain('starved');
    expect(result.reason).toContain('triage');
  });

  it('reports a genuine drain complete when nothing is shapeable', () => {
    // ready 0 + shapeable 0: genuinely drained — the original "drain complete" path.
    const result = decideStop('', { active: true, ready: 0, shapeable: 0 });
    expect(result.decision).toBe('allow-stop');
    expect(result.reason).toContain('drain complete');
  });

  it('still BLOCKS an active drain with ready work, regardless of shapeable', () => {
    // ready 2: the blocking path is unchanged; shapeable is irrelevant when ready > 0.
    const result = decideStop('working...', { active: true, ready: 2 });
    expect(result.decision).toBe('block-stop');
    expect(result.reason).toContain('2');
  });
});

describe('flow-loop decideStop — explicit signals override the sentinel (always allow stop)', () => {
  it('PHASE_COMPLETE allows stop even with an active, ready drain', () => {
    const result = decideStop('done <promise>PHASE_COMPLETE:auto</promise>', {
      active: true,
      ready: 9,
    });
    expect(result.decision).toBe('allow-stop');
  });

  it('ABORT allows stop even with an active, ready drain', () => {
    const result = decideStop('stopping <promise>ABORT</promise>', { active: true, ready: 9 });
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
    const live = { active: true, ready: 3, startedAt: fresh(HOUR) };
    expect(decideStop('', live, 'unknown', NOW).decision).toBe('block-stop');
    expect(decideStop('', live).decision).toBe('block-stop');
  });

  it('allows the stop and reaps when the drain owner is dead', () => {
    // The reported bug: pid 49658 was gone, the file still said active, and the
    // banner re-fired on every Stop of every later session in the repo.
    const result = decideStop(
      '',
      { active: true, ready: 6, shapeable: 108, startedAt: fresh(HOUR), pid: 49658 },
      'dead',
      NOW
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
    expect(result.reason).toContain('49658');
  });

  it('still blocks for a live owner with ready work inside the TTL', () => {
    const result = decideStop(
      '',
      { active: true, ready: 3, startedAt: fresh(2 * HOUR), pid: 1234 },
      'alive',
      NOW
    );
    expect(result.decision).toBe('block-stop');
    expect(result.reap).toBeFalsy();
  });

  it('presumes a recycled pid once an active sentinel outlives the TTL', () => {
    // A live probe is not proof: a recycled pid looks alive. Age bounds belief.
    const result = decideStop(
      '',
      { active: true, ready: 3, startedAt: fresh(30 * HOUR), pid: 1234 },
      'alive',
      NOW
    );
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
    expect(result.reason).toContain('presumed gone');
  });

  it('ignores an unparseable or absent startedAt rather than reaping on it', () => {
    const noStamp = { active: true, ready: 3, pid: 1234 };
    expect(decideStop('', noStamp, 'alive', NOW).decision).toBe('block-stop');
    const junkStamp = { active: true, ready: 3, pid: 1234, startedAt: 'whenever' };
    expect(decideStop('', junkStamp, 'alive', NOW).decision).toBe('block-stop');
  });

  it('never reaps a paused sentinel, even when its owner is dead', () => {
    // active:false is what /flow:pause writes and /flow:resume reads back.
    // Deleting it would silently discard the operator's paused drain.
    const result = decideStop('', { active: false, ready: 5, pid: 49658 }, 'dead', NOW);
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBeFalsy();
  });
});

describe('flow-loop decideStop — the advertised escape hatch actually clears the sentinel', () => {
  it('reaps the sentinel on ABORT, so the banner does not re-fire on the next Stop', () => {
    const result = decideStop('<promise>ABORT</promise>', { active: true, ready: 3 });
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
  });

  it('reaps the sentinel on PHASE_COMPLETE too', () => {
    const result = decideStop('<promise>PHASE_COMPLETE:auto</promise>', {
      active: true,
      ready: 3,
    });
    expect(result.decision).toBe('allow-stop');
    expect(result.reap).toBe(true);
  });

  it('has nothing to reap when a signal fires with no sentinel or a paused one', () => {
    expect(decideStop('<promise>ABORT</promise>', null).reap).toBeFalsy();
    expect(decideStop('<promise>ABORT</promise>', { active: false }).reap).toBeFalsy();
  });

  it('reaps a drain that finished or starved, so it cannot outlive its owner', () => {
    expect(decideStop('', { active: true, ready: 0, shapeable: 0 }).reap).toBe(true);
    expect(decideStop('', { active: true, ready: 0, shapeable: 4 }).reap).toBe(true);
  });
});
