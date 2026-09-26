/**
 * `flow stage` (spec `flow-cli-core` §6, task 3.3): the stage projection
 * (adapter contract 2.0.0) and the run record's stage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;

beforeEach(() => {
  project = makeProject();
});

afterEach(() => {
  project.cleanup();
});

const run: FlowRun = {
  issueId: 'id-FAKE-1',
  identifier: 'FAKE-1',
  sessionId: 'session-abc',
  worktreePath: '/w',
  branch: 'b',
  stage: 'execute',
  status: 'running',
  attemptCount: 0,
  workerPid: 1,
  startedAt: '2026-09-26T00:00:00.000Z',
};

describe('flow stage', () => {
  it('moves to a started stage by removing every stage label and updates the run', async () => {
    // Purpose: contract 2.0.0 — a started stage lives on the run record, never
    // on the tracker, so the write clears stage/* and the run carries "verify".
    project.writeRuns({ 'id-FAKE-1': run });
    const started = item('FAKE-1', { stateCategory: 'started', labels: ['agent/claimed'] });
    const result = await runFlow(project, { items: [started] }, ['stage', 'FAKE-1', 'verify']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toEqual([
      {
        method: 'applyWorkState',
        identifier: 'FAKE-1',
        change: { stateCategory: 'started', stageLabel: null },
      },
    ]);
    expect(project.runs()['id-FAKE-1'].stage).toBe('verify');
  });

  it('sets the label of a stage that is not started', async () => {
    // Purpose: before work starts, the stage/* label is where the next session resumes.
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'stage',
      'FAKE-1',
      'specify',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toEqual([
      { method: 'applyWorkState', identifier: 'FAKE-1', change: { stageLabel: 'stage/specify' } },
    ]);
    expect(result.tracker.backlog.items[0].labels).toEqual([
      'type/task',
      'agent/ready',
      'stage/specify',
    ]);
    expect(project.hasRunStore()).toBe(false);
  });

  it('refuses a stage that is not in config', async () => {
    // Purpose: a typo must not write a label no stage owns.
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'stage',
      'FAKE-1',
      'shipping',
    ]);
    expect(result.code).toBe(EXIT.precondition);
    expect(result.tracker.calls).toEqual([]);
  });

  it('exits 4 and keeps the run stage when the tracker drops the write', async () => {
    // Purpose: the run follows the tracker, never runs ahead of it.
    project.writeRuns({ 'id-FAKE-1': run });
    const result = await runFlow(project, { items: [item('FAKE-1')], dropWrites: true }, [
      'stage',
      'FAKE-1',
      'verify',
    ]);
    expect(result.code).toBe(EXIT.tracker);
    expect(project.runs()['id-FAKE-1'].stage).toBe('execute');
  });

  it('writes nothing with --dry-run', async () => {
    // Purpose: --dry-run prints the change and touches nothing.
    project.writeRuns({ 'id-FAKE-1': run });
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'stage',
      'FAKE-1',
      'verify',
      '--dry-run',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toEqual([]);
    expect(project.runs()['id-FAKE-1'].stage).toBe('execute');
    expect(result.json).toMatchObject({ dryRun: true, run: { stage: 'verify' } });
  });
});
