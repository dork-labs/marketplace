/**
 * `flow claim` (spec `flow-cli-core` §6, task 3.3): the preconditions, the one
 * work-state change it writes, and the run record it keeps.
 *
 * Every case drives `main` against a real temp git project and the in-memory
 * fake adapter, and asserts the exact `applyWorkState` calls.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import { item, makeProject, runFlow, FAKE_PPID, type WriteProject } from './write-harness.ts';

let project: WriteProject;

beforeEach(() => {
  project = makeProject();
});

afterEach(() => {
  project.cleanup();
});

const CLAIM_CHANGE = { stateCategory: 'started', agentLabel: 'agent/claimed', stageLabel: null };

describe('flow claim writes the claim projection and records the run', () => {
  it('moves a ready item to started with agent/claimed and no stage label', async () => {
    // Purpose: the claim is exactly projectionFor('claim'), written once and
    // confirmed, so the item ends with agent/claimed and no stage/* label (contract 2.0.0).
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.writes).toEqual([
      { method: 'applyWorkState', identifier: 'FAKE-1', change: CLAIM_CHANGE },
    ]);
    const after = result.tracker.backlog.items[0];
    expect(after.stateCategory).toBe('started');
    expect(after.labels).toEqual(['type/task', 'agent/claimed']);
  });

  it('records a FlowRun with the removed stage, the worker, the checkout and provenance', async () => {
    // Purpose: once the stage label is gone, the run record is the only place
    // the stage lives, so it must carry the stage the claim removed.
    const result = await runFlow(
      project,
      { items: [item('FAKE-1', { labels: ['agent/ready', 'stage/specify'] })] },
      ['claim', 'FAKE-1', '--account', 'acct-1', '--host', 'dorkos']
    );
    expect(result.code).toBe(EXIT.ok);
    expect(project.runs()).toEqual({
      'id-FAKE-1': {
        issueId: 'id-FAKE-1',
        identifier: 'FAKE-1',
        title: 'Title of FAKE-1',
        type: 'task',
        sessionId: 'session-abc',
        worktreePath: project.dir,
        branch: 'work',
        stage: 'specify',
        status: 'running',
        attemptCount: 0,
        workerPid: FAKE_PPID,
        startedAt: '2026-09-26T12:00:00.000Z',
        provenance: {
          v: 1,
          harness: 'claude-code',
          sessionId: 'session-abc',
          account: 'claude-work',
          host: os.hostname(),
          surface: 'dorkos',
          worktree: project.dir,
          branch: 'work',
        },
        account: 'acct-1',
        host: 'dorkos',
        runtime: 'claude-code',
        updatedAt: '2026-09-26T12:00:00.000Z',
      },
    });
    expect(result.json.run).toEqual(project.runs()['id-FAKE-1']);
  });

  it('records the item title on the run, and leaves it out when the tracker gave none', async () => {
    // Purpose: a reader names the work from the run record alone, so the claim
    // copies the title; an unknown title is omitted, never written as "" or null.
    const titled = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(titled.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1'].title).toBe('Title of FAKE-1');

    const untitled = await runFlow(project, { items: [item('FAKE-2', { title: '  ' })] }, [
      'claim',
      'FAKE-2',
    ]);
    expect(untitled.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-2']).toBeDefined();
    expect('title' in project.runs()['id-FAKE-2']).toBe(false);
  });

  it("records the item's type on the run, so a drain asks a bug for its proof test", async () => {
    // Purpose: DOR-3261 — `flow report pushed` reads the type from the run, with no tracker call.
    const bug = await runFlow(project, { items: [item('FAKE-1', { type: 'signal' })] }, [
      'claim',
      'FAKE-1',
    ]);
    expect(bug.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1'].type).toBe('signal');
  });

  it('defaults the stage to execute and counts a repeat claim as a new attempt', async () => {
    // Purpose: an item with no stage label resumes at execute, and a claim over
    // an existing record is attempt n + 1, which the recovery ladder caps.
    project.writeRuns({
      'id-FAKE-1': {
        issueId: 'id-FAKE-1',
        identifier: 'FAKE-1',
        sessionId: 'old',
        worktreePath: '/old',
        branch: 'old',
        stage: 'verify',
        status: 'running',
        attemptCount: 2,
        workerPid: 1,
        startedAt: '2026-09-25T00:00:00.000Z',
      },
    });
    const result = await runFlow(
      project,
      { items: [item('FAKE-1', { labels: ['agent/ready'] })] },
      ['claim', 'FAKE-1', '--pid', '77', '--worktree', '/w', '--branch', 'b']
    );
    expect(result.code).toBe(EXIT.ok);
    const run = project.runs()['id-FAKE-1'];
    expect(run).toMatchObject({
      stage: 'execute',
      attemptCount: 3,
      workerPid: 77,
      worktreePath: '/w',
      branch: 'b',
      sessionId: 'session-abc',
    });
  });

  it('refuses a claim with no session id, before any write (exit 5)', async () => {
    // Purpose: recovery resumes a run by its session id, so a run with none
    // cannot be resumed. The claim stops and names every way to give one; the
    // id is never invented and nothing is written.
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1'], {
      env: {},
    });
    expect(result.code).toBe(EXIT.precondition);
    const message = String((result.json.error as { message: string }).message);
    for (const name of [
      '--session',
      'FLOW_SESSION_ID',
      'CLAUDE_CODE_SESSION_ID',
      'CODEX_THREAD_ID',
    ])
      expect(message).toContain(name);
    expect(result.tracker.writes).toEqual([]);
    expect(project.hasRunStore()).toBe(false);
  });

  it('under Codex, takes the session id from CODEX_THREAD_ID and records the runtime', async () => {
    // Purpose: Codex sets CODEX_THREAD_ID for every command it runs, so a Codex
    // drain claims with no flag, and the run names the runtime its session is on.
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1'], {
      env: { CODEX_THREAD_ID: 'thread-7' },
    });
    expect(result.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1']).toMatchObject({ sessionId: 'thread-7', runtime: 'codex' });
    expect(project.runs()['id-FAKE-1'].provenance).toMatchObject({ harness: 'codex' });
  });

  it('--runtime also picks which runtime the session id comes from', async () => {
    // Purpose: with two runtimes' variables inherited, detection alone would
    // take Codex's thread id; a claim that names Claude Code must record Claude
    // Code's session, or recovery would resume the wrong conversation.
    const result = await runFlow(
      project,
      { items: [item('FAKE-1')] },
      ['claim', 'FAKE-1', '--runtime', 'claude-code'],
      { env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-9', CODEX_THREAD_ID: 'thread-9' } }
    );
    expect(result.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1']).toMatchObject({
      sessionId: 'cc-9',
      runtime: 'claude-code',
    });
  });

  it('under OpenCode, needs --session (it sets no session id) and records the runtime', async () => {
    // Purpose: OpenCode marks its commands with OPENCODE=1 but gives no session
    // id, so the claim is refused without --session and runs with it.
    const env = { OPENCODE: '1' };
    const refused = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1'], {
      env,
    });
    expect(refused.code).toBe(EXIT.precondition);
    const result = await runFlow(
      project,
      { items: [item('FAKE-1')] },
      ['claim', 'FAKE-1', '--session', 'oc-1'],
      { env }
    );
    expect(result.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1']).toMatchObject({ sessionId: 'oc-1', runtime: 'opencode' });
  });

  it('--runtime names the runtime; outside a known runtime the field is left out', async () => {
    // Purpose: a launcher that knows better says so, a value flow does not know
    // is a usage error, and a run is never given a runtime nobody named.
    const bad = await runFlow(
      project,
      { items: [item('FAKE-1')] },
      ['claim', 'FAKE-1', '--runtime', 'gemini'],
      { env: { FLOW_SESSION_ID: 's' } }
    );
    expect(bad.code).toBe(EXIT.usage);
    const bare = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1'], {
      env: { FLOW_SESSION_ID: 's' },
    });
    expect(bare.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1']).not.toHaveProperty('runtime');
    const named = await runFlow(
      project,
      { items: [item('FAKE-1')] },
      ['claim', 'FAKE-1', '--runtime', 'codex'],
      { env: { FLOW_SESSION_ID: 's', CLAUDECODE: '1' } }
    );
    expect(named.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1'].runtime).toBe('codex');
  });

  it('records --dispatched-by, the chat that launched the run (fleet contract 4.1.0)', async () => {
    // Purpose: DorkOS lists a run in the chat that launched it by matching
    // dispatchedBy to that chat's session id (spec flow-multiproject §6.1).
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'claim',
      'FAKE-1',
      '--dispatched-by',
      'orchestrator-session',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1'].dispatchedBy).toBe('orchestrator-session');
    const plain = await runFlow(project, { items: [item('FAKE-2')] }, ['claim', 'FAKE-2']);
    expect(plain.code).toBe(EXIT.ok);
    expect('dispatchedBy' in project.runs()['id-FAKE-2']).toBe(false);
  });

  it('posts no comment', async () => {
    // Purpose: the label is the signal (agent etiquette: mostly quiet).
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(result.tracker.writes.filter((call) => call.method === 'comment')).toEqual([]);
  });

  it('prints one plain line in human mode', async () => {
    // Purpose: a person driving by hand gets a readable confirmation.
    const { main } = await import('../../scripts/flow.ts');
    const { FakeTracker } = await import('../../scripts/tracker/fake.ts');
    const { defaultRunner } = await import('./write-harness.ts');
    let out = '';
    const code = await main(['claim', 'FAKE-1'], {
      env: { FLOW_SESSION_ID: 's' },
      cwd: project.dir,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      stdout: { write: (chunk: string) => (out += chunk) },
      stderr: { write: () => true },
      createAdapter: async () => new FakeTracker({ items: [item('FAKE-1')] }).adapter,
      runProcess: defaultRunner,
    });
    expect(code).toBe(EXIT.ok);
    expect(out).toBe(`Claimed FAKE-1 at stage execute (worker ${FAKE_PPID}, work).\n`);
  });
});

describe('flow claim over an answer nothing has used', () => {
  const left = (answer: object, fields: object = {}) => ({
    'id-FAKE-1': {
      issueId: 'id-FAKE-1',
      identifier: 'FAKE-1',
      sessionId: 'session-old',
      worktreePath: project.dir,
      branch: 'work',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: 1,
      startedAt: '2026-09-26T10:00:00.000Z',
      question: {
        text: 'Keep it?',
        choices: [{ id: 'c1', label: 'Yes' }],
        pick: 'c1',
        why: 'Cheaper.',
        askedAt: '2026-09-26T11:00:00.000Z',
        decideBy: null,
        floor: [],
        answeredBy: 'person',
        checkAfter: null,
        answer: { text: 'Private words.', at: '2026-09-26T11:30:00.000Z', ...answer },
        ...fields,
      },
    },
  });
  const journal = () => {
    const file = path.join(project.dir, '.dork', 'flow', 'journal.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const claim = () => runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);

  it("leaves one line for a person's, without the words", async () => {
    project.writeRuns(left({ by: 'person' }) as never);
    expect((await claim()).code).toBe(EXIT.ok);
    expect(project.runs()['id-FAKE-1'].question).toBeUndefined();
    expect(journal()).toContain('"answer.dropped"');
    expect(journal()).not.toContain('Private words.');
  });

  it("leaves none for an agent's pick, or one handed over", async () => {
    project.writeRuns(left({ by: 'agent-default' }) as never);
    await claim();
    project.writeRuns(
      left({ by: 'person' }, { answerHandedOverAt: '2026-09-26T11:40:00.000Z' }) as never
    );
    await claim();
    expect(journal()).not.toContain('"answer.dropped"');
  });
});

describe('flow claim refuses what it must not claim (exit 5)', () => {
  const cases: [string, Parameters<typeof item>[1], RegExp][] = [
    ['a closed item', { stateCategory: 'completed' }, /is completed/],
    ['an item without agent/ready', { labels: ['stage/execute'] }, /does not carry agent\/ready/],
    ['a claimed item', { labels: ['agent/ready', 'agent/claimed'] }, /already claimed/],
    ['an item someone else owns', { assignee: 'someone-else' }, /ownership settings/],
  ];
  for (const [name, overrides, message] of cases) {
    it(`refuses ${name}`, async () => {
      // Purpose: each precondition on its own stops the claim before any write.
      const result = await runFlow(project, { items: [item('FAKE-1', overrides)] }, [
        'claim',
        'FAKE-1',
      ]);
      expect(result.code).toBe(EXIT.precondition);
      expect(result.json.error).toMatchObject({ code: EXIT.precondition });
      expect(String((result.json.error as { message: string }).message)).toMatch(message);
      expect(result.tracker.writes).toEqual([]);
      expect(project.hasRunStore()).toBe(false);
    });
  }

  it('claims an item assigned to the agent itself', async () => {
    // Purpose: the ownership check reads identity.agent, so the agent's own item stays claimable.
    const result = await runFlow(project, { items: [item('FAKE-1', { assignee: 'agent-1' })] }, [
      'claim',
      'FAKE-1',
    ]);
    expect(result.code).toBe(EXIT.ok);
  });

  it('refuses an item that does not exist', async () => {
    // Purpose: a typo must not claim anything.
    const result = await runFlow(project, { items: [] }, ['claim', 'FAKE-9']);
    expect(result.code).toBe(EXIT.precondition);
  });

  it('asks for --pid when the worker process cannot be found', async () => {
    // Purpose: a run with a wrong worker pid reads as orphaned; better to stop and ask.
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1'], {
      runProcess: async (cmd) => ({ code: cmd === 'ps' ? 1 : 0, stdout: '', stderr: '' }),
    });
    expect(result.code).toBe(EXIT.precondition);
    expect(String((result.json.error as { message: string }).message)).toMatch(/--pid/);
    expect(result.tracker.writes).toEqual([]);
  });

  it('rejects an unknown --host as a usage error', async () => {
    // Purpose: the launcher vocabulary is pinned (cli, dorkos, cmux).
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'claim',
      'FAKE-1',
      '--host',
      'laptop',
    ]);
    expect(result.code).toBe(EXIT.usage);
  });
});

describe('flow claim and the pause', () => {
  it('exits 7 while paused', async () => {
    // Purpose: a pause stops every new claim an autonomous tick would make.
    project.pause();
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(result.code).toBe(EXIT.paused);
    expect(result.tracker.writes).toEqual([]);
  });

  it('claims again once a timed pause has ended, without --manual', async () => {
    // Purpose: spec flow-multiproject §5.1: a timed pause ends on time with
    // DorkOS closed, because claim reads the end itself. The harness clock is
    // 2026-09-26T12:00Z; a pause that ended at 11:00Z no longer stops a claim,
    // one that ends at 13:00Z still does.
    const flag = (until: string) =>
      writeFileSync(
        path.join(project.dir, '.agents', 'flow', 'paused.json'),
        JSON.stringify({ pausedAt: '2026-09-26T10:00:00.000Z', until, hostSchedules: [] })
      );
    flag('2026-09-26T13:00:00.000Z');
    const stillPaused = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(stillPaused.code).toBe(EXIT.paused);
    flag('2026-09-26T11:00:00.000Z');
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(result.code).toBe(EXIT.ok);
  });

  it('claims while paused with --manual', async () => {
    // Purpose: a person driving by hand is not stopped by the pause.
    project.pause();
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'claim',
      'FAKE-1',
      '--manual',
    ]);
    expect(result.code).toBe(EXIT.ok);
  });
});

describe('flow claim failure and dry run', () => {
  it('exits 4 and records no run when the tracker does not keep the write', async () => {
    // Purpose: a write the tracker dropped must not leave a run record claiming work.
    const result = await runFlow(project, { items: [item('FAKE-1')], dropWrites: true }, [
      'claim',
      'FAKE-1',
    ]);
    expect(result.code).toBe(EXIT.tracker);
    expect(project.hasRunStore()).toBe(false);
  });

  it('writes nothing with --dry-run and prints the plan', async () => {
    // Purpose: --dry-run shows the change and the run without touching either store.
    const result = await runFlow(project, { items: [item('FAKE-1')] }, [
      'claim',
      'FAKE-1',
      '--dry-run',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.writes).toEqual([]);
    expect(project.hasRunStore()).toBe(false);
    expect(result.json).toMatchObject({
      dryRun: true,
      change: CLAIM_CHANGE,
      run: { stage: 'execute', status: 'running' },
    });
  });

  it('refuses a corrupt run store before touching the tracker', async () => {
    // Purpose: the store writer refuses a file it cannot read; finding that out
    // after the tracker write would leave a claim with no run.
    project.writeRuns('{ not json');
    const result = await runFlow(project, { items: [item('FAKE-1')] }, ['claim', 'FAKE-1']);
    expect(result.code).toBe(EXIT.config);
    expect(result.tracker.writes).toEqual([]);
  });
});

describe('approximate picks still require a fresh claim', () => {
  for (const taken of [false, true])
    it(`refuses a saved pick that is now ${taken ? 'taken' : 'deleted'} before any write`, async () => {
      const saved = path.join(project.dir, 'panel.json');
      writeFileSync(
        saved,
        JSON.stringify({
          v: 1,
          tracker: 'fake',
          panelOnly: true,
          fetchedAt: '2026-01-02T10:15:00.000Z',
          team: { id: null, key: null },
          items: [item('FAKE-1')],
          closed: [],
          projects: [],
        })
      );
      const current = {
        items: taken
          ? [item('FAKE-1', { labels: ['type/task', 'agent/claimed'], assignee: 'another-agent' })]
          : [],
      };
      const picked = await runFlow(project, current, [
        'next',
        '--manual',
        '--no-account',
        '--snapshot',
        saved,
      ]);
      expect(picked.code, picked.stderr).toBe(0);
      expect((picked.json.picked as { identifier: string }[])[0].identifier).toBe('FAKE-1');
      expect(picked.tracker.writes).toEqual([]);
      const claim = await runFlow(project, current, ['claim', 'FAKE-1']);
      expect(claim.code).toBe(EXIT.precondition);
      expect(claim.stderr).toMatch(taken ? /already claimed/ : /not found/);
      expect(claim.tracker.writes).toEqual([]);
      expect(project.runs()).toEqual({});
    });
});
