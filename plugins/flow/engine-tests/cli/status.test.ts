/**
 * `flow status` (spec `flow-cli-core` §6; task 3.4): the one-screen join of the
 * run records, the drain sentinel, the pause and the backlog, and the drift
 * between them.
 *
 * Each case builds a temp git checkout with its own `.dork/flow/flow-state.json`
 * and runs `main(argv, deps)` with the file-based fake adapter, so every drift
 * kind is seeded on disk and in the fake tracker, never mocked.
 *
 * @see specs/flow-cli-core/02-specification.md §6 "flow status"
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FlowRun } from '../../scripts/flow-run.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import { createFakeAdapter, type FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';

const NOW = new Date('2026-09-26T12:00:00.000Z');

/** A pid that is certainly not running: a child that has already exited. */
const DEAD_PID = spawnSync('true').pid as number;

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-status-')));
  execFileSync('git', ['init', '-q'], { cwd: project });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function item(identifier: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'started',
    stateName: 'In Progress',
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['type/task', 'agent/claimed'],
    agentDisposition: 'claimed',
    ...overrides,
  };
}

function runRecord(identifier: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    issueId: `id-${identifier}`,
    identifier,
    sessionId: `session-${identifier}`,
    worktreePath: `/work/${identifier}`,
    branch: `dork/${identifier}`,
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: process.pid,
    startedAt: '2026-09-26T11:00:00.000Z',
    account: 'spare',
    host: 'cli',
    ...overrides,
  };
}

function writeRuns(runs: FlowRun[]): void {
  const dir = path.join(project, '.dork', 'flow');
  mkdirSync(dir, { recursive: true });
  const state = Object.fromEntries(runs.map((run) => [run.issueId, run]));
  writeFileSync(path.join(dir, 'flow-state.json'), JSON.stringify(state, null, 2));
}

function writeSentinel(value: unknown): void {
  const dir = path.join(project, '.dork', 'flow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auto-run.json'), JSON.stringify(value));
}

async function status(argv: string[], backlog: FakeBacklog = { items: [] }) {
  const fake = createFakeAdapter(backlog);
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: {},
    cwd: project,
    now: () => NOW,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => fake.adapter,
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  const code = await main(['status', ...argv], deps);
  return { code, stdout, stderr, json: () => JSON.parse(stdout), calls: fake.calls };
}

const kinds = (out: { drift: { identifier: string; kind: string; check?: string }[] }) =>
  out.drift.map((d) => [d.identifier, d.kind, d.check].filter(Boolean).join(' '));

describe('flow status', () => {
  it('reports a coherent run and claimed item with no drift', async () => {
    // Purpose: the green baseline every drift case is a one-change twin of.
    writeRuns([runRecord('FAKE-1')]);
    const result = await status(['--json', '--strict'], { items: [item('FAKE-1')] });
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out).toMatchObject({ v: 1, paused: null, drain: null, parked: [], drift: [] });
    expect(out.inFlight).toEqual([
      expect.objectContaining({
        identifier: 'FAKE-1',
        title: 'Title of FAKE-1',
        stage: 'execute',
        status: 'running',
        worktree: '/work/FAKE-1',
        branch: 'dork/FAKE-1',
        account: 'spare',
        host: 'cli',
        claimed: true,
      }),
    ]);
    expect(result.calls).toEqual([]);
  });

  it('flags a running run whose item is not started', async () => {
    // Purpose: drift kind 1. The labels say unstarted, the run says running.
    writeRuns([runRecord('FAKE-1')]);
    const backlog = {
      items: [
        item('FAKE-1', { stateCategory: 'unstarted', labels: ['agent/ready', 'stage/execute'] }),
      ],
    };
    const out = (await status(['--json'], backlog)).json();
    expect(kinds(out)).toEqual(['FAKE-1 run-not-started']);
  });

  it('flags a claimed item with no run on this machine', async () => {
    // Purpose: drift kind 2. Something claimed it, nothing here is driving it.
    const result = await status(['--json'], { items: [item('FAKE-2')] });
    expect(kinds(result.json())).toEqual(['FAKE-2 claimed-no-run']);
    expect(result.json().inFlight).toMatchObject([
      { identifier: 'FAKE-2', status: null, claimed: true },
    ]);
  });

  it('flags a running run whose worker pid is dead', async () => {
    // Purpose: drift kind 3. The run record outlived its worker.
    writeRuns([runRecord('FAKE-3', { workerPid: DEAD_PID })]);
    const out = (await status(['--json'], { items: [item('FAKE-3')] })).json();
    expect(kinds(out)).toEqual(['FAKE-3 worker-gone']);
  });

  it('flags every STATE-n breach on an in-flight item', async () => {
    // Purpose: drift kind 4, straight from work-state.ts (not GRM-15): a started
    // claimed item that still carries a stage label and agent/ready.
    writeRuns([runRecord('FAKE-4')]);
    const breached = item('FAKE-4', { labels: ['agent/claimed', 'agent/ready', 'stage/execute'] });
    const out = (
      await status(['--json'], {
        items: [
          breached,
          item('FAKE-5', { stateCategory: 'unstarted', labels: ['stage/a', 'stage/b'] }),
        ],
      })
    ).json();
    // FAKE-5 breaks STATE-1 but is not in flight, so it is not status's drift.
    expect(kinds(out)).toEqual(['FAKE-4 state-breach STATE-2', 'FAKE-4 state-breach STATE-4']);
  });

  it('--strict exits 1 on drift and 0 without it', async () => {
    // Purpose: the exit-code contract (1 = the check found problems).
    expect((await status(['--strict'], { items: [item('FAKE-2')] })).code).toBe(1);
    expect((await status([], { items: [item('FAKE-2')] })).code).toBe(0);
  });

  it('--strict --json reports ok:false when it exits 1 on drift', async () => {
    // Purpose: a caller reading the JSON must not see ok:true for a failed check.
    const failed = await status(['--strict', '--json'], { items: [item('FAKE-2')] });
    expect(failed.code).toBe(1);
    expect(failed.json().ok).toBe(false);
    const lenient = await status(['--json'], { items: [item('FAKE-2')] });
    expect(lenient.json().ok).toBe(true);
    writeRuns([runRecord('FAKE-1')]);
    const clean = await status(['--strict', '--json'], { items: [item('FAKE-1')] });
    expect(clean.json().ok).toBe(true);
  });

  it('reports a live drain, and an orphan sentinel by dead pid or age', async () => {
    // Purpose: a sentinel is not a live drain until its owner is checked.
    writeSentinel({
      active: true,
      ready: 3,
      shapeable: 1,
      startedAt: '2026-09-26T11:30:00.000Z',
      pid: process.pid,
      sessionId: 's',
    });
    let drain = (await status(['--json'])).json().drain;
    expect(drain).toMatchObject({ active: true, ready: 3, shapeable: 1, orphan: null });

    writeSentinel({ active: true, ready: 3, startedAt: '2026-09-26T11:30:00.000Z', pid: DEAD_PID });
    drain = (await status(['--json'])).json().drain;
    expect(drain.orphan).toContain(`pid ${DEAD_PID} gone`);

    writeSentinel({
      active: true,
      ready: 3,
      startedAt: '2026-09-25T11:00:00.000Z',
      pid: process.pid,
    });
    const aged = await status([]);
    expect(aged.stdout).toContain('over 24 hours ago');
  });

  it('heads the pane with the pause', async () => {
    // Purpose: a paused loop is the first thing a person must see.
    mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(project, '.agents', 'flow', 'paused.json'),
      JSON.stringify({ pausedAt: '2026-09-26T08:00:00.000Z' })
    );
    const result = await status([]);
    expect(result.stdout.split('\n')[0]).toContain('Paused since 2026-09-26T08:00:00.000Z');
    const out = (await status(['--json'])).json();
    expect(out.paused).toMatchObject({ since: '2026-09-26T08:00:00.000Z' });
  });

  it('lists parked items, and with an identifier shows the last parked question', async () => {
    // Purpose: parked items are listed; the focused view reads the item's
    // comments (getItem with 20) and shows the agent's last signed question.
    const parked = item('FAKE-6', { stateCategory: 'unstarted', labels: ['agent/needs-input'] });
    const backlog: FakeBacklog = {
      items: [parked, item('FAKE-7')],
      comments: {
        'FAKE-6': [
          {
            id: 'c1',
            author: 'agent-1',
            body: 'Old question\n<!-- agent:provenance {"v":1} -->',
            createdAt: '2026-09-26T09:00:00.000Z',
          },
          {
            id: 'c2',
            author: 'agent-1',
            body: 'Which database?\n<!-- agent:provenance {"v":1} -->',
            createdAt: '2026-09-26T10:00:00.000Z',
          },
          {
            id: 'c3',
            author: 'person',
            body: 'thinking...',
            createdAt: '2026-09-26T11:00:00.000Z',
          },
        ],
      },
    };
    const whole = (await status(['--json'], backlog)).json();
    expect(whole.parked).toEqual([
      { identifier: 'FAKE-6', title: 'Title of FAKE-6', question: null },
    ]);

    const focused = await status(['FAKE-6', '--json'], backlog);
    const out = focused.json();
    expect(out.inFlight).toEqual([]);
    expect(out.parked).toEqual([
      {
        identifier: 'FAKE-6',
        title: 'Title of FAKE-6',
        question: { body: 'Which database?', askedAt: '2026-09-26T10:00:00.000Z' },
      },
    ]);
    const text = await status(['FAKE-6'], backlog);
    expect(text.stdout).toContain('asked 2 h ago: Which database?');
  });

  it('reads a saved snapshot instead of the tracker', async () => {
    // Purpose: --snapshot lets a drain reuse one pull; the tracker is not asked.
    const file = path.join(project, 'snap.json');
    writeFileSync(file, JSON.stringify({ v: 1, items: [item('FAKE-8')] }));
    const result = await status(['--snapshot', file, '--json'], {
      items: [],
      failReads: 'must not read',
    });
    expect(result.code).toBe(0);
    expect(kinds(result.json())).toEqual(['FAKE-8 claimed-no-run']);
  });

  it('reads --snapshot the way next and audit do: a file without v:1 or an unreadable one is a usage error', async () => {
    // Purpose: one reader for every verb's --snapshot, so status never accepts
    // a file next and audit refuse, and a bad path exits 2 everywhere.
    const file = path.join(project, 'old.json');
    writeFileSync(file, JSON.stringify({ items: [item('FAKE-8')] }));
    const noVersion = await status(['--snapshot', file, '--json'], { items: [] });
    expect(noVersion.code).toBe(2);
    expect(String(noVersion.json().error.message)).toMatch(/"v": 1/);
    const missing = await status(['--snapshot', path.join(project, 'nope.json'), '--json'], {
      items: [],
    });
    expect(missing.code).toBe(2);
  });

  it('says so plainly when nothing is in flight', async () => {
    // Purpose: an empty loop is one sentence, not an empty pane.
    const result = await status([]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('Nothing is in flight and no drain is live.');
  });

  it('exits 5 for an identifier that is neither in the backlog nor in a run', async () => {
    // Purpose: a typo is named, not rendered as an empty pane.
    expect((await status(['FAKE-404'])).code).toBe(5);
  });
});
