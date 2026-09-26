/**
 * `flow stage` (spec `flow-cli-core` §6, task 3.3): the stage projection
 * (adapter contract 2.0.0) and the run record's stage; and `--checkpoint-file`
 * (spec `flow-handoff-dispatch` §1): the checkpoint every stage boundary writes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCheckpoint } from '../../scripts/drain/checkpoint.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
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

describe('flow stage --checkpoint-file', () => {
  const BODY = [
    '## Done',
    '',
    '- Specified the export.',
    '',
    '## Next',
    '',
    '- Verify it.',
    '',
    '## Open questions',
    '',
    'None.',
    '',
    '## Next command',
    '',
    '```sh',
    'pnpm test',
    '```',
    '',
  ].join('\n');

  /** A drain state, enough for the store to accept it. */
  const drain: DrainState = {
    v: 1,
    rev: 3,
    phase: 'working',
    worker: null,
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
  };
  const started = item('FAKE-1', { stateCategory: 'started', labels: ['agent/claimed'] });
  const handoff = () => path.join(project.dir, '.dork', 'flow', 'HANDOFF.md');

  it('writes the checkpoint for the new stage, then moves the item', async () => {
    // Purpose: the header says where the next session resumes (the new stage),
    // with trigger "stage", and the run records the checkpoint.
    project.writeRuns({ 'id-FAKE-1': { ...run, worktreePath: project.dir } });
    writeFileSync(path.join(project.dir, 'body.md'), BODY);
    const result = await runFlow(project, { items: [started] }, [
      'stage',
      'FAKE-1',
      'verify',
      '--checkpoint-file',
      'body.md',
    ]);
    expect(result.code).toBe(EXIT.ok);
    const parsed = parseCheckpoint(readFileSync(handoff(), 'utf8'));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.header).toMatchObject({
      identifier: 'FAKE-1',
      stage: 'verify',
      trigger: 'stage',
    });
    expect(result.json.checkpoint).toMatchObject({ header: { stage: 'verify' } });
    expect(result.tracker.calls).toHaveLength(1);
    const stored = project.runs()['id-FAKE-1'];
    expect(stored.stage).toBe('verify');
    expect(stored.checkpointSha).toBe(parsed.header.headSha);
    expect(result.stderr).not.toMatch(/no checkpoint written/);
  });

  it('refuses a drain run without it (exit 5), before any write', async () => {
    // Purpose: a drain hands sessions between accounts; a stage boundary with
    // no checkpoint would leave the next session nothing to resume from.
    project.writeRuns({ 'id-FAKE-1': { ...run, drain } });
    const result = await runFlow(project, { items: [started] }, ['stage', 'FAKE-1', 'verify']);
    expect(result.code).toBe(EXIT.precondition);
    expect(JSON.stringify(result.json)).toContain(
      'a drain run writes a checkpoint at every stage boundary: pass --checkpoint-file'
    );
    expect(result.tracker.calls).toEqual([]);
    expect(project.runs()['id-FAKE-1'].stage).toBe('execute');
  });

  it('outside a drain, moves without it and warns on stderr', async () => {
    // Purpose: a person driving flow by hand is nudged, not blocked.
    project.writeRuns({ 'id-FAKE-1': run });
    const result = await runFlow(project, { items: [started] }, ['stage', 'FAKE-1', 'verify']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stderr).toContain('no checkpoint written for FAKE-1: pass --checkpoint-file');
    expect(existsSync(handoff())).toBe(false);
    expect(project.runs()['id-FAKE-1'].stage).toBe('verify');
  });

  it('a body that breaks a rule stops the move (exit 5)', async () => {
    // Purpose: the checkpoint comes first; a refused one must not leave the
    // item moved with no checkpoint behind it.
    project.writeRuns({ 'id-FAKE-1': { ...run, drain } });
    writeFileSync(path.join(project.dir, 'body.md'), '## Done\n\nOnly this.\n');
    const result = await runFlow(project, { items: [started] }, [
      'stage',
      'FAKE-1',
      'verify',
      '--checkpoint-file',
      'body.md',
    ]);
    expect(result.code).toBe(EXIT.precondition);
    expect(result.tracker.calls).toEqual([]);
    expect(project.runs()['id-FAKE-1'].stage).toBe('execute');
  });
});
