/**
 * `flow triage`: the one write that ends a triage. `--ready` makes an item
 * claimable at a stage; `--park` asks one signed question and applies
 * `agent/needs-input`. Every refusal comes before any tracker write.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import type { Capability } from '../../scripts/tracker/types.ts';
import { defaultRunner, item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;

beforeEach(() => {
  project = makeProject();
});

afterEach(() => {
  project.cleanup();
});

/** A captured idea, untriaged: in triage, no agent/* label. */
const untriaged = () =>
  item('FAKE-1', {
    type: 'idea',
    stateCategory: 'backlog',
    stateName: 'Triage',
    labels: ['type/idea', 'origin/human'],
    agentDisposition: undefined,
  });

/** The writes a run made (reads are not recorded). */
const writes = (result: Awaited<ReturnType<typeof runFlow>>) => result.tracker.calls;

describe('flow triage --ready', () => {
  it('makes the item unstarted with agent/ready and the stage label, and posts nothing', async () => {
    // Purpose: a ready item must say where to start (GRM-10) and be claimable.
    const result = await runFlow(project, { items: [untriaged()] }, [
      'triage',
      'FAKE-1',
      '--ready',
      '--stage',
      'execute',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(writes(result)).toEqual([
      {
        method: 'applyWorkState',
        identifier: 'FAKE-1',
        change: {
          stateCategory: 'unstarted',
          agentLabel: 'agent/ready',
          stageLabel: 'stage/execute',
        },
      },
    ]);
    expect(result.tracker.backlog.items[0].labels).toEqual([
      'type/idea',
      'origin/human',
      'agent/ready',
      'stage/execute',
    ]);
    expect(result.json).toMatchObject({
      v: 1,
      ok: true,
      dryRun: false,
      identifier: 'FAKE-1',
      decision: 'ready',
      commented: false,
    });
  });

  it('replaces a parked item’s agent/needs-input once the answer makes it ready', async () => {
    // Purpose: one agent/* label at a time; readying a parked item drops the park.
    const parked = { ...untriaged(), labels: ['type/idea', 'agent/needs-input'] };
    const result = await runFlow(project, { items: [parked] }, [
      'triage',
      'FAKE-1',
      '--ready',
      '--stage',
      'ideate',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.tracker.backlog.items[0].labels).toEqual([
      'type/idea',
      'agent/ready',
      'stage/ideate',
    ]);
  });

  it('writes nothing on --dry-run and prints the change', async () => {
    const result = await runFlow(project, { items: [untriaged()] }, [
      'triage',
      'FAKE-1',
      '--ready',
      '--stage',
      'execute',
      '--dry-run',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(writes(result)).toEqual([]);
    expect(result.json).toMatchObject({
      dryRun: true,
      change: { agentLabel: 'agent/ready', stageLabel: 'stage/execute' },
    });
  });
});

describe('flow triage --park', () => {
  it('posts the question once, signed, then applies agent/needs-input', async () => {
    // Purpose: the question is the comment a person answers, and it says who asked.
    const result = await runFlow(project, { items: [untriaged()] }, [
      'triage',
      'FAKE-1',
      '--park',
      'Which report: the monthly one or all of them?',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(writes(result).map((call) => call.method)).toEqual(['comment', 'applyWorkState']);
    const [comment, write] = writes(result);
    expect((comment as { body: string }).body).toMatch(
      /^Which report: the monthly one or all of them\?\n\nReply to this comment to go on\.\n\n— 🤖 \/flow\n<!-- agent:provenance \{"v":1,"harness":"claude-code","sessionId":"session-abc",.*\} -->$/
    );
    expect(write).toEqual({
      method: 'applyWorkState',
      identifier: 'FAKE-1',
      change: { agentLabel: 'agent/needs-input' },
    });
    expect(result.tracker.backlog.items[0].labels).toEqual([
      'type/idea',
      'origin/human',
      'agent/needs-input',
    ]);
    expect(result.json).toMatchObject({ decision: 'park', commented: true });
  });

  it('does not post the question twice on a retry, and drops agent/ready', async () => {
    // Purpose: a retry after a failed label write must not ask the person twice,
    // and a parked item never stays ready.
    const first = await runFlow(project, { items: [untriaged()] }, [
      'triage',
      'FAKE-1',
      '--park',
      'Which report?',
    ]);
    first.tracker.backlog.items[0].labels = ['type/idea', 'agent/ready', 'stage/execute'];
    const retry = await runFlow(project, first.tracker, [
      'triage',
      'FAKE-1',
      '--park',
      'Which report?',
    ]);
    expect(retry.code).toBe(EXIT.ok);
    expect(retry.json).toMatchObject({ commented: false });
    expect(retry.tracker.calls.filter((call) => call.method === 'comment')).toHaveLength(1);
    expect(retry.tracker.backlog.items[0].labels).toEqual([
      'type/idea',
      'stage/execute',
      'agent/needs-input',
    ]);
  });

  it('writes nothing on --dry-run', async () => {
    const result = await runFlow(project, { items: [untriaged()] }, [
      'triage',
      'FAKE-1',
      '--park',
      'Which report?',
      '--dry-run',
    ]);
    expect(result.code).toBe(EXIT.ok);
    expect(writes(result)).toEqual([]);
    expect(result.json).toMatchObject({
      dryRun: true,
      decision: 'park',
      commented: true,
      change: { agentLabel: 'agent/needs-input' },
    });
  });

  it('prints one plain line without --json', async () => {
    const { main } = await import('../../scripts/flow.ts');
    const { createFakeAdapter } = await import('../fixtures/cli/fake-adapter/adapter.ts');
    const tracker = createFakeAdapter({ items: [untriaged()] });
    let out = '';
    const code = await main(['triage', 'FAKE-1', '--park', 'Which report?'], {
      env: { FLOW_SESSION_ID: 'session-abc', CLAUDECODE: '1' },
      cwd: project.dir,
      now: () => new Date('2026-09-26T12:00:00.000Z'),
      stdout: { write: (t: string) => ((out += t), true) },
      stderr: { write: () => true },
      createAdapter: async () => tracker.adapter,
      runProcess: defaultRunner,
    });
    expect(code).toBe(EXIT.ok);
    expect(out).toBe('Marked FAKE-1 as waiting on a person, with the question posted.\n');
  });
});

describe('flow triage refuses before any write', () => {
  const cases: [string, string[], number][] = [
    ['neither --ready nor --park', ['triage', 'FAKE-1'], EXIT.usage],
    [
      'both --ready and --park',
      ['triage', 'FAKE-1', '--ready', '--stage', 'execute', '--park', 'Why?'],
      EXIT.usage,
    ],
    ['--ready without --stage', ['triage', 'FAKE-1', '--ready'], EXIT.usage],
    [
      '--stage with --park',
      ['triage', 'FAKE-1', '--park', 'Why?', '--stage', 'execute'],
      EXIT.usage,
    ],
    ['an empty question', ['triage', 'FAKE-1', '--park', '  '], EXIT.usage],
    ['no identifier', ['triage', '--ready', '--stage', 'execute'], EXIT.usage],
    [
      'a stage not in config',
      ['triage', 'FAKE-1', '--ready', '--stage', 'nowhere'],
      EXIT.precondition,
    ],
    [
      'a stage with no label',
      ['triage', 'FAKE-1', '--ready', '--stage', 'review'],
      EXIT.precondition,
    ],
  ];
  for (const [name, argv, code] of cases) {
    it(`refuses ${name} (exit ${code})`, async () => {
      const result = await runFlow(project, { items: [untriaged()] }, argv);
      expect(result.code).toBe(code);
      expect(result.json).toMatchObject({ ok: false });
      expect(writes(result)).toEqual([]);
    });
  }

  it('refuses a closed item, exit 5', async () => {
    const closed = { ...untriaged(), stateCategory: 'completed' as const, labels: ['type/idea'] };
    const result = await runFlow(project, { items: [closed] }, [
      'triage',
      'FAKE-1',
      '--park',
      'Why?',
    ]);
    expect(result.code).toBe(EXIT.precondition);
    expect(writes(result)).toEqual([]);
  });

  it('refuses an item an agent is working, started or claimed, exit 5', async () => {
    // Purpose: triage must never yank work out from under a running session.
    for (const over of [
      { stateCategory: 'started' as const, labels: ['type/task'] },
      { labels: ['type/task', 'agent/claimed'] },
    ]) {
      const busy = { ...untriaged(), ...over };
      const result = await runFlow(project, { items: [busy] }, [
        'triage',
        'FAKE-1',
        '--ready',
        '--stage',
        'execute',
      ]);
      expect(result.code).toBe(EXIT.precondition);
      expect(String((result.json.error as { message: string }).message)).toMatch(/being worked/);
      expect(writes(result)).toEqual([]);
    }
  });

  it('exits 3 naming comment when the adapter cannot post the question', async () => {
    const noComment: Capability[] = [
      'getCurrentUser',
      'getBacklogSnapshot',
      'getItem',
      'applyWorkState',
    ];
    const result = await runFlow(project, { items: [untriaged()], capabilities: noComment }, [
      'triage',
      'FAKE-1',
      '--park',
      'Why?',
    ]);
    expect(result.code).toBe(EXIT.config);
    expect(JSON.stringify(result.json)).toContain('comment');
    expect(writes(result)).toEqual([]);
  });
});

describe('flow triage journal', () => {
  it('gets its verb line from main, naming the item', async () => {
    await runFlow(project, { items: [untriaged()] }, [
      'triage',
      'FAKE-1',
      '--ready',
      '--stage',
      'execute',
    ]);
    const lines = readFileSync(path.join(project.dir, '.dork', 'flow', 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(
      expect.objectContaining({ kind: 'verb', verb: 'triage', item: 'FAKE-1' })
    );
  });
});
