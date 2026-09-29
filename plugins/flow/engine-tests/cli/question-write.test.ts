/**
 * The locked question writes (`scripts/cli/question-write.ts`): several paths
 * can settle one parked question (a person, the DorkOS deadline, the drain's
 * own deadline pass, the reviewer agent), and exactly one may win.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimAnswer,
  claimCheck,
  clearQuestion,
  releaseAnswer,
} from '../../scripts/cli/question-write.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { openFlowStateFile } from '../../scripts/flow-state-file.ts';

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'flow-question-write-')));
  execFileSync('git', ['init', '-q', repo]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const ASKED = '2026-09-26T11:00:00.000Z';

function run(): FlowRun {
  return {
    issueId: 'i1',
    identifier: 'ACME-1',
    sessionId: 's1',
    worktreePath: repo,
    branch: 'b',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 1,
    startedAt: ASKED,
    question: {
      text: 'Keep it?',
      choices: [
        { id: 'c1', label: 'Yes' },
        { id: 'c2', label: 'No' },
      ],
      pick: 'c1',
      why: 'Safer.',
      askedAt: ASKED,
      decideBy: null,
      floor: [],
      answeredBy: 'person',
      checkAfter: null,
    },
  };
}

describe('claimAnswer', () => {
  // Review finding 5: the second path to answer finds it settled; an answer
  // meant for an earlier question never lands on a newer one.
  it('lets exactly one answer win, and only for the question it read', async () => {
    const store = openFlowStateFile(repo);
    await store.upsertRun(run());
    const person = { text: 'No', at: '2026-09-26T12:00:00.000Z', by: 'person' };
    const pick = { text: 'Yes', at: '2026-09-26T12:00:01.000Z', by: 'agent-default' };
    expect(await claimAnswer(store, 'i1', '2020-01-01T00:00:00.000Z', person)).toBe(false);
    expect(await claimAnswer(store, 'i1', ASKED, person)).toBe(true);
    expect(await claimAnswer(store, 'i1', ASKED, pick)).toBe(false);
    expect(store.read().i1.question?.answer).toEqual(person);
    // A failed post gives it back, so another path can still settle it.
    await releaseAnswer(store, 'i1', ASKED, person);
    expect(store.read().i1.question?.answer).toBeUndefined();
    expect(await claimAnswer(store, 'i1', ASKED, pick)).toBe(true);
  });

  it('hands out one check, and clears a consumed question', async () => {
    const store = openFlowStateFile(repo);
    await store.upsertRun(run());
    expect(await claimCheck(store, 'i1', ASKED, 'h1')).toBe(true);
    expect(await claimCheck(store, 'i1', ASKED, 'h2')).toBe(false);
    expect(store.read().i1.question?.checkTokenHash).toBe('h1');
    await clearQuestion(store, 'i1', '2020-01-01T00:00:00.000Z');
    expect(store.read().i1.question).toBeDefined();
    await clearQuestion(store, 'i1', ASKED);
    expect(store.read().i1.question).toBeUndefined();
  });
});
