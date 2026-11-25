/**
 * `flow done` (spec `flow-cli-core` §6, task 3.3): the signed summary, the
 * idempotent retry, the done projection and the completed run record.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hostRefFor } from '../../scripts/cli/provenance.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { readSignature } from '../../scripts/signature-line.ts';
import { item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;

beforeEach(() => {
  project = makeProject();
});

afterEach(() => {
  project.cleanup();
});

/** A made-up DorkOS install id. */
const INSTALL_ID = '4f7c2c6e-1b0a-4c2a-9a1e-8d3b7f6e5c21';

const DONE_CHANGE = { stateCategory: 'completed', agentLabel: 'agent/completed', stageLabel: null };

const claimed = () =>
  item('FAKE-1', { stateCategory: 'started', labels: ['type/task', 'agent/claimed'] });

const run: FlowRun = {
  issueId: 'id-FAKE-1',
  identifier: 'FAKE-1',
  sessionId: 'session-abc',
  worktreePath: '/w',
  branch: 'b',
  stage: 'review',
  status: 'waiting_for_review',
  attemptCount: 0,
  workerPid: 1,
  startedAt: '2026-09-26T00:00:00.000Z',
};

describe('flow done', () => {
  it('posts the signed summary, closes the item and completes the run', async () => {
    // Purpose: done is one comment then the done projection, confirmed, and the
    // run record marked complete.
    project.writeRuns({ 'id-FAKE-1': run });
    const result = await runFlow(project, { items: [claimed()] }, [
      'done',
      'FAKE-1',
      '--summary',
      'Shipped the fix.',
      '--pr',
      'https://example.test/pr/1',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.writes.map((call) => call.method)).toEqual(['comment', 'applyWorkState']);
    const [comment, write] = result.tracker.writes;
    expect((comment as { body: string }).body).toMatch(
      /^Shipped the fix\.\n\nPR: https:\/\/example\.test\/pr\/1\n\n— 🤖 \/flow\n<!-- agent:provenance \{"v":2,"harness":"claude-code",.*"chat":"dork:chat:session-"\} -->$/
    );
    // The fake tracker declares no visibility: signed as public, so no `host`.
    expect((comment as { body: string }).body).not.toContain('"host"');
    expect(write).toEqual({ method: 'applyWorkState', identifier: 'FAKE-1', change: DONE_CHANGE });
    expect(project.runs()['id-FAKE-1']).toMatchObject({
      status: 'complete',
      completedAt: '2026-09-26T12:00:00.000Z',
    });
    expect(result.tracker.backlog.items[0].labels).toEqual(['type/task', 'agent/completed']);
  });

  it('signs in full, with the install, on a tracker that declares itself private', async () => {
    // Purpose: only a declared private tracker gets the whole chat id and `host`.
    project.writeRuns({ 'id-FAKE-1': run });
    const dorkHome = path.join(project.dir, 'dork-home');
    mkdirSync(dorkHome);
    writeFileSync(path.join(dorkHome, 'telemetry-install-id'), INSTALL_ID);
    const result = await runFlow(
      project,
      { items: [claimed()], visibility: 'private' },
      ['done', 'FAKE-1', '--summary', 'Shipped the fix.'],
      { env: { DORK_HOME: dorkHome, FLOW_SESSION_ID: 'session-abc', CLAUDECODE: '1' } }
    );
    expect(result.code).toBe(EXIT.ok);
    const body = (result.tracker.writes[0] as { body: string }).body;
    expect(readSignature(body)).toMatchObject({
      chat: 'session-abc',
      host: hostRefFor(INSTALL_ID),
    });
  });

  it('does not post the summary twice', async () => {
    // Purpose: a retried done (after a crash or a failed read-back) must not
    // repeat itself on the thread, even from another session with another signature.
    const signedElsewhere =
      'Shipped the fix.\n\n— 🤖 /flow\n<!-- agent:provenance {"v":1,"sessionId":"other"} -->';
    const result = await runFlow(
      project,
      {
        items: [claimed()],
        comments: {
          'FAKE-1': [
            {
              id: 'c1',
              author: 'agent-1',
              authorIsTrusted: false,
              body: signedElsewhere,
              createdAt: '2026-09-26T00:00:00Z',
            },
          ],
        },
      },
      ['done', 'FAKE-1', '--summary', 'Shipped the fix.']
    );
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.writes).toEqual([
      { method: 'applyWorkState', identifier: 'FAKE-1', change: DONE_CHANGE },
    ]);
    expect(result.json.commented).toBe(false);
  });

  it('fixes the labels of an item the tracker already closed', async () => {
    // Purpose: a merged "Closes <id>" closes the item first; done still leaves
    // agent/completed and no agent/claimed or stage label behind.
    const closed = item('FAKE-1', {
      stateCategory: 'completed',
      labels: ['type/task', 'agent/claimed', 'stage/verify'],
    });
    const result = await runFlow(project, { items: [closed] }, [
      'done',
      'FAKE-1',
      '--summary',
      'Done.',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.backlog.items[0].labels).toEqual(['type/task', 'agent/completed']);
  });

  it('reads the summary from --summary-file', async () => {
    // Purpose: long summaries go through a file, not a shell argument.
    const file = path.join(project.dir, 'done.md');
    writeFileSync(file, 'From a file.\n');
    const result = await runFlow(project, { items: [claimed()] }, [
      'done',
      'FAKE-1',
      '--summary-file',
      'done.md',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect((result.tracker.writes[0] as { body: string }).body.startsWith('From a file.\n\n')).toBe(
      true
    );
  });

  it('needs exactly one of --summary and --summary-file', async () => {
    // Purpose: a done with no summary, or two, is a usage error before anything is written.
    const none = await runFlow(project, { items: [claimed()] }, ['done', 'FAKE-1']);
    expect(none.code).toBe(EXIT.usage);
    const both = await runFlow(project, { items: [claimed()] }, [
      'done',
      'FAKE-1',
      '--summary',
      'a',
      '--summary-file',
      'b',
    ]);
    expect(both.code).toBe(EXIT.usage);
    expect(both.tracker.writes).toEqual([]);
  });

  it('exits 4 and leaves the run open when the tracker drops the write', async () => {
    // Purpose: the run is only complete when the tracker says the item is.
    project.writeRuns({ 'id-FAKE-1': run });
    const result = await runFlow(project, { items: [claimed()], dropWrites: true }, [
      'done',
      'FAKE-1',
      '--summary',
      'x',
    ]);
    expect(result.code).toBe(EXIT.tracker);
    expect(project.runs()['id-FAKE-1'].status).toBe('waiting_for_review');
  });

  it('writes nothing with --dry-run', async () => {
    // Purpose: --dry-run prints the plan and posts, changes and records nothing.
    project.writeRuns({ 'id-FAKE-1': run });
    const result = await runFlow(project, { items: [claimed()] }, [
      'done',
      'FAKE-1',
      '--summary',
      'x',
      '--dry-run',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.writes).toEqual([]);
    expect(project.runs()['id-FAKE-1'].status).toBe('waiting_for_review');
    expect(result.json).toMatchObject({
      dryRun: true,
      change: DONE_CHANGE,
      run: { status: 'complete' },
    });
  });
});
