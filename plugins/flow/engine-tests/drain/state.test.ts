/**
 * The drain and limit fields on the run record (spec `flow-handoff-dispatch`
 * §4.3, §5.1; task 1.3): `FlowRun.checkpointAt`, `checkpointSha`, `drain` and
 * `limit` read back unchanged through the all-or-nothing `flow-state.json`
 * reader, keep unknown nested fields through a read-modify-write, and refuse a
 * mistyped known field.
 */

import { describe, expect, it } from 'vitest';

import {
  DRAIN_PHASES,
  DrainStateSchema,
  handleRuntime,
  RunLimitSchema,
  type DrainState,
  type RunLimit,
} from '../../scripts/drain/state.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import {
  FlowStateSchema,
  parseFlowState,
  serializeFlowState,
  writeFlowRun,
  type FlowStateStore,
} from '../../scripts/flow-state.ts';

/** A drain state with every field set, both handle slots filled. */
function fullDrain(): DrainState {
  return {
    v: 1,
    rev: 7,
    phase: 'reviewing',
    worker: {
      host: 'cli',
      runtime: 'claude-code',
      sessionId: 'w-1',
      account: 'claude3',
      cwd: '/work/ABC-1',
      pid: 4242,
      logFile: '/work/ABC-1/.dork/flow/drain/logs/worker.jsonl',
      logOffset: 1024,
      pending: false,
    },
    reviewer: {
      host: 'cmux',
      runtime: 'claude-code',
      sessionId: 'r-1',
      account: null,
      cwd: '/work/ABC-1-review',
      surface: 'surface:3',
      workspace: 'workspace:1',
      pending: true,
      sha: '4be1c2d',
      worktree: '/work/ABC-1-review',
      tokenHash: 'sha256:abc',
    },
    pushedSha: '4be1c2d',
    reviewedSha: null,
    verdict: null,
    reviewRound: 2,
    pr: {
      repo: 'acme/app',
      number: 88,
      url: 'https://example.test/acme/app/pull/88',
      armed: false,
      disarmedForReview: true,
    },
    rearmedFor: null,
    nudges: 1,
    wakeAfter: '2026-09-26T19:00:00.000Z',
    handoffs: [
      { from: 'claude3', to: 'claude4', at: '2026-09-26T18:00:00.000Z', reason: 'warning' },
    ],
    parkedReason: null,
  };
}

/** A limit with every field set. */
function fullLimit(): RunLimit {
  return {
    level: 'warning',
    account: 'claude3',
    window: 'weekly',
    resetsAt: '2026-10-01T09:00:00.000Z',
    cause: 'reserve',
    since: '2026-09-26T17:30:00.000Z',
    state: 'handing-off',
    handoffToken: 'tok-1',
    handingOffAt: '2026-09-26T17:45:00.000Z',
    handoffSessionId: 'w-2',
    notifiedAt: null,
  };
}

/** A run carrying every new field. */
function fullRun(): FlowRun {
  return {
    issueId: 'issue-1',
    identifier: 'ABC-1',
    sessionId: 'w-1',
    worktreePath: '/work/ABC-1',
    branch: 'abc-1',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 4242,
    startedAt: '2026-09-26T16:00:00.000Z',
    account: 'claude3',
    host: 'cli',
    checkpointAt: '2026-09-26T17:00:00.000Z',
    checkpointSha: '4be1c2d',
    drain: fullDrain(),
    limit: fullLimit(),
  };
}

/** An in-memory store over one string cell. */
function memoryStore(initial: string | undefined): FlowStateStore & { cell(): string | undefined } {
  let cell = initial;
  return {
    read: () => cell,
    write: (contents) => {
      cell = contents;
    },
    cell: () => cell,
  };
}

describe('the run record carries drain, limit and checkpoint fields', () => {
  // Purpose: a record with every new field set reads back deep-equal and
  // re-serializes to the same bytes. Fails if the schema drops or reshapes any
  // of them (a strict nested object would strip, a wrong type would empty the file).
  it('round-trips a record with every field set', () => {
    const text = serializeFlowState({ 'issue-1': fullRun() });
    const read = parseFlowState(text);
    expect(read).toEqual({ 'issue-1': fullRun() });
    expect(serializeFlowState(read)).toBe(text);
  });

  // Purpose: unknown fields inside drain, a handle, a PR, a handoff entry and
  // the limit survive when another run is upserted. Fails if any nested schema
  // is a plain (stripping) object instead of a looseObject.
  it('keeps unknown nested fields when another run is written', () => {
    const run = fullRun() as unknown as Record<string, Record<string, unknown>>;
    const drain = run.drain as Record<string, unknown> & DrainState;
    Object.assign(drain, { futureDrain: 1 });
    Object.assign(drain.worker as object, { futureHandle: 'x' });
    Object.assign(drain.reviewer as object, { futureReviewer: true });
    Object.assign(drain.pr as object, { futurePr: [1] });
    Object.assign(drain.handoffs[0], { futureHandoff: null });
    Object.assign(run.limit, { futureLimit: { a: 1 } });
    const store = memoryStore(serializeFlowState({ 'issue-1': run as unknown as FlowRun }));

    writeFlowRun(store, { ...fullRun(), issueId: 'issue-2', identifier: 'ABC-2' });

    const after = JSON.parse(store.cell() as string) as Record<string, unknown>;
    expect(after['issue-1']).toEqual(run);
  });

  // Purpose: the vocabularies (phase, host, limit state, handoff reason) are
  // checked for type only, like FlowRun.host, so a record from a newer flow with
  // a new value still reads instead of emptying every run on the machine.
  it('reads a vocabulary value it does not know', () => {
    const run = fullRun() as unknown as {
      drain: Record<string, unknown>;
      limit: Record<string, unknown>;
    };
    run.drain.phase = 'some-future-phase';
    (run.drain.worker as Record<string, unknown>).host = 'some-future-host';
    run.limit.state = 'some-future-state';
    expect(FlowStateSchema.safeParse({ 'issue-1': run }).success).toBe(true);
    expect(DRAIN_PHASES).toContain('fixing-ci');
  });

  // Purpose: a handle written before launchers were runtime-aware has no
  // runtime. The reader must accept it and add nothing (a read-modify-write
  // would otherwise change other runs' records), and handleRuntime reads it as
  // claude-code, since every such session was. Fails if the schema requires the
  // field, injects a default, or handleRuntime guesses another runtime.
  it('accepts a handle without a runtime unchanged, and handleRuntime reads it as claude-code', () => {
    const drain = fullDrain() as unknown as { worker: Record<string, unknown> };
    delete drain.worker.runtime;
    const parsed = DrainStateSchema.safeParse(drain);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.worker).not.toHaveProperty('runtime');
    expect(handleRuntime(parsed.data!.worker!)).toBe('claude-code');
    expect(handleRuntime({ runtime: 'codex' })).toBe('codex');
  });

  // Purpose: a mistyped known field is still refused (forward compatibility is
  // about unknown fields, not wrong types). Fails if a field is left unchecked.
  it.each([
    ['drain.rev as a string', (d: Record<string, unknown>) => (d.rev = '7')],
    ['drain.rev as a fraction', (d: Record<string, unknown>) => (d.rev = 1.5)],
    ['drain.phase as a number', (d: Record<string, unknown>) => (d.phase = 3)],
    [
      'a worker handle without a sessionId',
      (d: Record<string, unknown>) => delete (d.worker as Record<string, unknown>).sessionId,
    ],
    [
      'a reviewer without its tokenHash',
      (d: Record<string, unknown>) => delete (d.reviewer as Record<string, unknown>).tokenHash,
    ],
    [
      'pending as a string',
      (d: Record<string, unknown>) => ((d.worker as Record<string, unknown>).pending = 'yes'),
    ],
    [
      'pr.number as a string',
      (d: Record<string, unknown>) => ((d.pr as Record<string, unknown>).number = '88'),
    ],
    ['handoffs as an object', (d: Record<string, unknown>) => (d.handoffs = {})],
    ['reviewRound negative', (d: Record<string, unknown>) => (d.reviewRound = -1)],
    ['wakeAfter missing', (d: Record<string, unknown>) => delete d.wakeAfter],
  ])('refuses %s', (_name, mutate) => {
    const drain = fullDrain() as unknown as Record<string, unknown>;
    mutate(drain);
    expect(DrainStateSchema.safeParse(drain).success).toBe(false);
    expect(parseFlowState(JSON.stringify({ 'issue-1': { ...fullRun(), drain } }))).toEqual({});
  });

  // Purpose: the limit's known fields are type-checked too.
  it.each([
    ['since missing', (l: Record<string, unknown>) => delete l.since],
    ['handoffToken as a number', (l: Record<string, unknown>) => (l.handoffToken = 1)],
    ['handoffSessionId missing', (l: Record<string, unknown>) => delete l.handoffSessionId],
  ])('refuses a limit with %s', (_name, mutate) => {
    const limit = fullLimit() as unknown as Record<string, unknown>;
    mutate(limit);
    expect(RunLimitSchema.safeParse(limit).success).toBe(false);
  });

  // Purpose: checkpointAt and checkpointSha are strings when present.
  it('refuses a non-string checkpointSha', () => {
    expect(
      FlowStateSchema.safeParse({ 'issue-1': { ...fullRun(), checkpointSha: 42 } }).success
    ).toBe(false);
  });
});
