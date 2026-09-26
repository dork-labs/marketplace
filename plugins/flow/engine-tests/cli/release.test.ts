/**
 * `flow release` (spec `flow-cli-core` §6, task 3.3): where a released item
 * goes, where it resumes, and what happens to its run record and the thread.
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

/** A claimed, started item. */
const claimed = () =>
  item('FAKE-1', { stateCategory: 'started', labels: ['type/task', 'agent/claimed'] });

/** A run record at `stage`. */
function runAt(stage: FlowRun['stage']): Record<string, FlowRun> {
  return {
    'id-FAKE-1': {
      issueId: 'id-FAKE-1',
      identifier: 'FAKE-1',
      sessionId: 'session-abc',
      worktreePath: '/w',
      branch: 'b',
      stage,
      status: 'running',
      attemptCount: 0,
      workerPid: 1,
      startedAt: '2026-09-26T00:00:00.000Z',
      host: 'cli',
    },
  };
}

describe('flow release --to ready', () => {
  it('returns the item to the queue at its run stage and deletes the run', async () => {
    // Purpose: a ready item must say where to resume (GRM-10), and the run
    // record's stage is where the work stopped.
    project.writeRuns(runAt('verify'));
    const result = await runFlow(project, { items: [claimed()] }, ['release', 'FAKE-1']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toEqual([
      {
        method: 'applyWorkState',
        identifier: 'FAKE-1',
        change: {
          stateCategory: 'unstarted',
          agentLabel: 'agent/ready',
          stageLabel: 'stage/verify',
        },
      },
    ]);
    expect(project.runs()).toEqual({});
    expect(result.json).toMatchObject({ runRemoved: true, commented: false });
  });

  it('exits 5 asking for --stage when no resume stage is known', async () => {
    // Purpose: releasing to ready with no stage would fail GRM-10, so it stops first.
    const result = await runFlow(project, { items: [claimed()] }, ['release', 'FAKE-1']);
    expect(result.code).toBe(EXIT.precondition);
    expect(String((result.json.error as { message: string }).message)).toMatch(/--stage/);
    expect(result.tracker.calls).toEqual([]);
  });

  it('uses --stage over the run record', async () => {
    // Purpose: the person releasing knows best where the work should restart.
    project.writeRuns(runAt('verify'));
    const result = await runFlow(project, { items: [claimed()] }, [
      'release',
      'FAKE-1',
      '--stage',
      'specify',
    ]);
    expect(result.tracker.calls[0]).toMatchObject({ change: { stageLabel: 'stage/specify' } });
  });
});

describe('flow release --to none', () => {
  it('leaves the item unowned and does not invent a stage', async () => {
    // Purpose: with no known stage the stage label is left alone, not guessed.
    const result = await runFlow(project, { items: [claimed()] }, [
      'release',
      'FAKE-1',
      '--to',
      'none',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toEqual([
      {
        method: 'applyWorkState',
        identifier: 'FAKE-1',
        change: { stateCategory: 'unstarted', agentLabel: null },
      },
    ]);
  });
});

describe('flow release --reason', () => {
  it('posts one signed comment only when a reason is given', async () => {
    // Purpose: a release is quiet unless there is something a person should read,
    // and anything posted carries the marker and the provenance line.
    project.writeRuns(runAt('execute'));
    const result = await runFlow(project, { items: [claimed()] }, [
      'release',
      'FAKE-1',
      '--reason',
      'Blocked on the API key.',
    ]);
    expect(result.code).toBe(EXIT.ok);
    const comments = result.tracker.calls.filter((call) => call.method === 'comment');
    expect(comments).toHaveLength(1);
    const body = (comments[0] as { body: string }).body;
    expect(body.startsWith('Blocked on the API key.\n\n— 🤖 /flow\n<!-- agent:provenance ')).toBe(
      true
    );
    expect(body).toMatch(/"surface":"bare-cli"/);
  });
});

describe('flow release refusals, failure and dry run', () => {
  it('refuses a closed item', async () => {
    // Purpose: a closed item has nothing to release; reopening it would be a surprise.
    const result = await runFlow(
      project,
      { items: [item('FAKE-1', { stateCategory: 'canceled' })] },
      ['release', 'FAKE-1', '--stage', 'execute']
    );
    expect(result.code).toBe(EXIT.precondition);
  });

  it('exits 4 and keeps the run when the tracker drops the write', async () => {
    // Purpose: the run record must outlive a release that did not land.
    project.writeRuns(runAt('verify'));
    const result = await runFlow(project, { items: [claimed()], dropWrites: true }, [
      'release',
      'FAKE-1',
    ]);
    expect(result.code).toBe(EXIT.tracker);
    expect(Object.keys(project.runs())).toEqual(['id-FAKE-1']);
  });

  it('writes nothing with --dry-run', async () => {
    // Purpose: --dry-run prints the change and touches neither the tracker nor the store.
    project.writeRuns(runAt('verify'));
    const result = await runFlow(project, { items: [claimed()] }, [
      'release',
      'FAKE-1',
      '--reason',
      'x',
      '--dry-run',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.calls).toEqual([]);
    expect(Object.keys(project.runs())).toEqual(['id-FAKE-1']);
    expect(result.json).toMatchObject({ dryRun: true, change: { stageLabel: 'stage/verify' } });
  });
});
