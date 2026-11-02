import { describe, it, expect } from 'vitest';
import { RecoverySchema } from '../scripts/config-schema.ts';
import {
  recoverOrphan,
  RECOVERY_BLOCKED_LABEL,
  RECOVERY_NEEDS_INPUT_LABEL,
  type FlowRun,
  type RecoveryConfig,
  type RecoveryContext,
} from '../scripts/flow-run.ts';

/** The §9 / §12 resolved default recovery config — the oracle the spec ships. */
const DEFAULT_RECOVERY: RecoveryConfig = RecoverySchema.parse({});

/** A durable run record with a usable checkpoint, overridable per-test. */
function flowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: 'issue-node-id',
    identifier: 'DOR-123',
    sessionId: 'session-abc',
    worktreePath: '/Users/x/.dork/workspaces/core/DOR-123',
    branch: 'dork/DOR-123',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

/** A probe context where the checkpoint (git commit + JSONL session) survives. */
function intactContext(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return { worktreeExists: true, sessionLogIntact: true, ...overrides };
}

describe('recoverOrphan — the next-tick recovery ladder (§12)', () => {
  describe('needs-input — parked on a human is NEVER reclaimed', () => {
    it('skips a needs-input item regardless of checkpoint state', () => {
      const action = recoverOrphan('needs-input', flowRun(), intactContext(), DEFAULT_RECOVERY);
      expect(action).toEqual({ kind: 'skip', reason: 'parked-on-human' });
    });

    it('skips even when retries are exhausted (never blocks or releases a parked item)', () => {
      const exhausted = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries });
      const action = recoverOrphan('needs-input', exhausted, intactContext(), DEFAULT_RECOVERY);
      expect(action.kind).toBe('skip');
    });

    it('does NOT increment attemptCount when skipping', () => {
      const run = flowRun({ attemptCount: 1 });
      recoverOrphan('needs-input', run, intactContext(), DEFAULT_RECOVERY);
      // The pure ladder never mutates the run; skip carries no attemptCount.
      expect(run.attemptCount).toBe(1);
      const action = recoverOrphan('needs-input', run, intactContext(), DEFAULT_RECOVERY);
      expect(action).not.toHaveProperty('attemptCount');
    });
  });

  describe('claimed-no-worker — adopt + resume when the checkpoint survives', () => {
    it('resumes (re-attach + session resume) when worktree exists AND session log intact', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action).toEqual({ kind: 'resume', attemptCount: 1 });
    });

    it('increments attemptCount on each reclaim', () => {
      const first = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(first.kind === 'resume' && first.attemptCount).toBe(1);

      const second = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 1 }),
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(second.kind === 'resume' && second.attemptCount).toBe(2);
    });
  });

  describe('claimed-no-worker — restart-clean when the checkpoint is gone', () => {
    it('restart-cleans (no-worktree) when the worktree is missing', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext({ worktreeExists: false }),
        DEFAULT_RECOVERY
      );
      expect(action).toEqual({ kind: 'restart-clean', reason: 'no-worktree', attemptCount: 1 });
    });

    it('restart-cleans (session-log-corrupt) when the session log is broken but the worktree exists', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext({ sessionLogIntact: false }),
        DEFAULT_RECOVERY
      );
      expect(action).toEqual({
        kind: 'restart-clean',
        reason: 'session-log-corrupt',
        attemptCount: 1,
      });
    });

    it('still increments attemptCount on a restart-clean reclaim', () => {
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 1 }),
        intactContext({ worktreeExists: false }),
        DEFAULT_RECOVERY
      );
      expect(action.kind === 'restart-clean' && action.attemptCount).toBe(2);
    });
  });

  describe('over maxRetries — onExhausted "block" (the default): agent/blocked', () => {
    it('blocks when attemptCount has reached maxRetries (no reclaim left)', () => {
      const exhausted = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries });
      const action = recoverOrphan(
        'claimed-no-worker',
        exhausted,
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(DEFAULT_RECOVERY.onExhausted).toBe('block');
      expect(action.kind).toBe('block');
      expect(action.kind === 'block' && action.label).toBe(RECOVERY_BLOCKED_LABEL);
      expect(action.kind === 'block' && action.label).toBe('agent/blocked');
    });

    it('blocks when attemptCount exceeds maxRetries', () => {
      const over = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries + 5 });
      const action = recoverOrphan('claimed-no-worker', over, intactContext(), DEFAULT_RECOVERY);
      expect(action.kind).toBe('block');
    });

    it('does not give up while one attempt remains (maxRetries - 1 still resumes)', () => {
      const lastAttempt = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries - 1 });
      const action = recoverOrphan(
        'claimed-no-worker',
        lastAttempt,
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action.kind).toBe('resume');
      expect(action.kind === 'resume' && action.attemptCount).toBe(DEFAULT_RECOVERY.maxRetries);
    });

    it('carries a human-readable reason for the comment', () => {
      const exhausted = flowRun({ attemptCount: DEFAULT_RECOVERY.maxRetries });
      const action = recoverOrphan(
        'claimed-no-worker',
        exhausted,
        intactContext(),
        DEFAULT_RECOVERY
      );
      expect(action.kind === 'block' && action.reason).toMatch(/exhausted/i);
    });
  });

  describe('over maxRetries — onExhausted "escalate": ask a person (agent/needs-input)', () => {
    const escalate: RecoveryConfig = RecoverySchema.parse({ onExhausted: 'escalate' });

    it('parks the item as a question with agent/needs-input, never agent/blocked', () => {
      const exhausted = flowRun({ attemptCount: escalate.maxRetries });
      const action = recoverOrphan('claimed-no-worker', exhausted, intactContext(), escalate);
      expect(action).toEqual({
        kind: 'escalate',
        label: RECOVERY_NEEDS_INPUT_LABEL,
        reason: expect.stringMatching(/exhausted/i),
        question: expect.stringContaining('DOR-123'),
      });
      // The question is for a person: plain words, no counters.
      expect(action.kind === 'escalate' && action.question).not.toMatch(/attemptCount|>=/);
      expect(action.kind === 'escalate' && action.question).toMatch(/reply/i);
      expect(RECOVERY_NEEDS_INPUT_LABEL).toBe('agent/needs-input');
    });

    it('still resumes while retries remain: the setting only applies once they run out', () => {
      const action = recoverOrphan('claimed-no-worker', flowRun(), intactContext(), escalate);
      expect(action.kind).toBe('resume');
    });

    it('once parked, the next tick skips it (the parked state is never reclaimed)', () => {
      const exhausted = flowRun({ attemptCount: escalate.maxRetries });
      expect(recoverOrphan('needs-input', exhausted, intactContext(), escalate)).toEqual({
        kind: 'skip',
        reason: 'parked-on-human',
      });
    });
  });

  describe('over maxRetries — onExhausted "abandon": let the item go', () => {
    const abandon: RecoveryConfig = RecoverySchema.parse({ onExhausted: 'abandon' });

    it('releases the item unowned, carrying no label and no attempt count', () => {
      const exhausted = flowRun({ attemptCount: abandon.maxRetries });
      const action = recoverOrphan('claimed-no-worker', exhausted, intactContext(), abandon);
      expect(action).toEqual({
        kind: 'abandon',
        releaseTo: 'none',
        reason: expect.stringMatching(/exhausted/i),
      });
    });

    it('abandons even with no checkpoint left (the setting wins over restart-clean)', () => {
      const exhausted = flowRun({ attemptCount: abandon.maxRetries });
      const action = recoverOrphan(
        'claimed-no-worker',
        exhausted,
        intactContext({ worktreeExists: false }),
        abandon
      );
      expect(action.kind).toBe('abandon');
    });
  });

  describe('no-local-record — re-derive from tracker + workspace (tracker-as-truth)', () => {
    it('re-derives when there is no local run record (claimed on another machine)', () => {
      const action = recoverOrphan('no-local-record', null, intactContext(), DEFAULT_RECOVERY);
      expect(action).toEqual({ kind: 're-derive', reason: 'no-local-record' });
    });

    it('re-derives even when a stale run object is passed (signal wins, no reclaim of a foreign run)', () => {
      const action = recoverOrphan('no-local-record', flowRun(), intactContext(), DEFAULT_RECOVERY);
      expect(action.kind).toBe('re-derive');
    });
  });

  describe('input invariants', () => {
    it('throws when claimed-no-worker is given without a local run record', () => {
      expect(() =>
        recoverOrphan('claimed-no-worker', null, intactContext(), DEFAULT_RECOVERY)
      ).toThrow(/requires a local FlowRun/);
    });

    it('honors a custom maxRetries from config', () => {
      const strict: RecoveryConfig = RecoverySchema.parse({ maxRetries: 0 });
      // With maxRetries 0, a fresh (attemptCount 0) claimed orphan blocks immediately.
      const action = recoverOrphan(
        'claimed-no-worker',
        flowRun({ attemptCount: 0 }),
        intactContext(),
        strict
      );
      expect(action.kind).toBe('block');
    });
  });
});
