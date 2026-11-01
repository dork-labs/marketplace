/**
 * `run-ended.ts`: the one rule `flow status` and the Flow extension share for
 * when a run outlived its work. These cases pin the DorkOS-hosted drain run
 * whose chat is gone (DOR-2490), and that the rule never ends a run that may
 * still be live.
 */
import { describe, expect, it } from 'vitest';
import { runEnded, type RunSessions } from '../scripts/run-ended.ts';

const alive = () => null;

/** A drain run in `phase`; by default the reviewer reviews the pushed commit, with no verdict yet. */
function drainRun(
  phase: string,
  overrides: Record<string, unknown> = {},
  drain: Record<string, unknown> = {}
) {
  return {
    status: 'running',
    workerPid: -1,
    drain: {
      v: 1,
      phase,
      pushedSha: 'a1',
      reviewedSha: 'a1',
      verdict: null,
      reviewer: { sha: 'a1' },
      ...drain,
    },
    ...overrides,
  };
}

const gone: RunSessions = { worker: 'gone', reviewer: null };

describe('runEnded: a hosted drain run whose session is gone (DOR-2490)', () => {
  it('ends a run whose worker chat is gone while the drain waits on that worker', () => {
    for (const phase of ['working', 'fixing', 'fixing-ci']) {
      expect(runEnded(drainRun(phase), undefined, alive, gone), phase).toBe('session-gone');
    }
  });

  it('ends a run in review whose reviewer chat is gone', () => {
    expect(
      runEnded(drainRun('reviewing'), undefined, alive, { worker: 'idle', reviewer: 'gone' })
    ).toBe('session-gone');
  });

  it('never ends a run that may still be live', () => {
    // The host could not say (DorkOS down, an old DorkOS): not gone.
    expect(
      runEnded(drainRun('working'), undefined, alive, { worker: 'unknown', reviewer: null })
    ).toBeNull();
    // Started but not yet confirmed.
    expect(
      runEnded(drainRun('working'), undefined, alive, { worker: 'starting', reviewer: null })
    ).toBeNull();
    // In review, the worker's chat is not waited on yet; the reviewer's is.
    expect(
      runEnded(drainRun('reviewing'), undefined, alive, { worker: 'gone', reviewer: 'busy' })
    ).toBeNull();
    // A review with no reviewer yet: the drain starts one.
    expect(
      runEnded(drainRun('reviewing'), undefined, alive, { worker: 'gone', reviewer: null })
    ).toBeNull();
    // The drain carries a PR to merge without a session.
    for (const phase of ['pr-ready', 'watching', 'closing', 'parked']) {
      expect(runEnded(drainRun(phase), undefined, alive, gone), phase).toBeNull();
    }
    // A limit's handoff may start a new session.
    expect(
      runEnded(drainRun('working', { limit: { state: 'handing-off' } }), undefined, alive, gone)
    ).toBeNull();
    // Not a drain run, or finished.
    expect(runEnded({ status: 'running', workerPid: -1 }, undefined, alive, gone)).toBeNull();
    expect(
      runEnded(drainRun('working', { status: 'complete' }), undefined, alive, gone)
    ).toBeNull();
    // No sessions read.
    expect(runEnded(drainRun('working'), undefined, alive)).toBeNull();
  });

  it('never ends a run the drain carries on without that chat', () => {
    // An unreviewed push: the next pass starts a reviewer, whatever the worker does.
    for (const phase of ['working', 'fixing', 'fixing-ci']) {
      const pushed = drainRun(phase, {}, { pushedSha: 'b2', reviewedSha: 'a1' });
      expect(runEnded(pushed, undefined, alive, gone), phase).toBeNull();
    }
    // A push the review already covered: the worker is waited on again.
    const covered = drainRun(
      'fixing',
      {},
      { pushedSha: 'b2', reviewedSha: 'b2', verdict: 'changes' }
    );
    expect(runEnded(covered, undefined, alive, gone)).toBe('session-gone');
    const reviewerGone = { worker: 'idle', reviewer: 'gone' };
    const reviewer = (sha: string) => ({ sha });
    // A verdict at the pushed commit: the reviewer's chat is done with.
    const judged = drainRun(
      'reviewing',
      {},
      { pushedSha: 'b2', reviewedSha: 'b2', verdict: 'changes', reviewer: reviewer('b2') }
    );
    expect(runEnded(judged, undefined, alive, reviewerGone)).toBeNull();
    // A reviewer of an older commit: the next pass starts a fresh one.
    const stale = drainRun('reviewing', {}, { pushedSha: 'b2', reviewer: reviewer('a1') });
    expect(runEnded(stale, undefined, alive, reviewerGone)).toBeNull();
    // Nothing pushed: the drain waits on nothing yet.
    expect(
      runEnded(drainRun('reviewing', {}, { pushedSha: null }), undefined, alive, reviewerGone)
    ).toBeNull();
  });

  it('keeps the closed-item rule as it was', () => {
    const closed = { stateCategory: 'completed' };
    expect(runEnded(drainRun('parked'), closed, alive, gone)).toBe('item-closed');
    expect(runEnded(drainRun('watching'), closed, alive)).toBeNull();
  });
});
