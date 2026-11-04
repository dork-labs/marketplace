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
import { FlowRunSchema } from '../../scripts/flow-state.ts';
import { formatWhen } from '../../scripts/question.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import { FakeTracker, type FakeBacklog } from '../../scripts/tracker/fake.ts';

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

/**
 * Write the run store. A scheduled drain's pass is stamped a minute before
 * {@link NOW} unless `lastPass` says otherwise (`null`: no pass on record), so
 * drain runs are watched by default (DOR-3263).
 */
function writeRuns(runs: FlowRun[], opts: { lastPass?: string | null } = {}): void {
  const dir = path.join(project, '.dork', 'flow');
  mkdirSync(dir, { recursive: true });
  const state = Object.fromEntries(runs.map((run) => [run.issueId, run]));
  writeFileSync(path.join(dir, 'flow-state.json'), JSON.stringify(state, null, 2));
  const lastPass =
    opts.lastPass === undefined ? new Date(NOW.getTime() - 60_000).toISOString() : opts.lastPass;
  if (lastPass !== null) {
    writeFileSync(path.join(dir, 'drain-last-pass.json'), JSON.stringify({ at: lastPass }));
  }
}

function writeSentinel(value: unknown): void {
  const dir = path.join(project, '.dork', 'flow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auto-run.json'), JSON.stringify(value));
}

async function status(
  argv: string[],
  backlog: FakeBacklog = { items: [] },
  createLauncher?: MainDeps['createLauncher']
) {
  const fake = new FakeTracker({ user: { id: 'agent-1', name: 'Fake agent' }, ...backlog });
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
    createLauncher,
    // A private OS home: the setup nudge looks for account folders there.
    // No DorkOS: Health's reads fail as unreachable, never the real one here.
    io: {
      osHome: path.join(project, 'home'),
      fetch: async () => {
        throw new Error('no DorkOS in this test');
      },
    },
  };
  const code = await main(['status', ...argv], deps);
  return { code, stdout, stderr, json: () => JSON.parse(stdout), calls: fake.writes };
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

  // DOR-3768: a refusal to arm is why a PR sits, so the pane says it.
  describe('a refusal to arm', () => {
    const SHA = 'abc1234def'.padEnd(40, '0');
    const refused = {
      sha: SHA,
      reason: 'security-label-missing',
      detail: 'it has no "security-reviewed" label',
      at: '2026-09-26T10:00:00.000Z',
    };
    const atGate = (reviewedSha: string): FlowRun =>
      runRecord('FAKE-1', {
        stage: 'review',
        status: 'waiting_for_review',
        armRefusal: refused,
        review: { tokenHash: 'h', sha: reviewedSha, verdict: 'clean', reviewedSha },
      });

    it('prints and returns the reason at the reviewed commit', async () => {
      writeRuns([atGate(SHA)]);
      const backlog = { items: [item('FAKE-1')] };
      expect((await status([], backlog)).stdout).toContain(
        '; not armed: it has no "security-reviewed" label'
      );
      expect((await status(['--json'], backlog)).json().inFlight[0].armRefused).toEqual({
        reason: 'security-label-missing',
        detail: 'it has no "security-reviewed" label',
      });
    });

    it('drops a refusal once the PR is armed', async () => {
      const run = atGate(SHA);
      const armed: FlowRun = {
        ...run,
        drain: {
          v: 1,
          rev: 0,
          phase: 'watching',
          worker: null,
          reviewer: null,
          pushedSha: SHA,
          reviewedSha: SHA,
          verdict: 'clean',
          reviewRound: 1,
          pr: { repo: 'acme/app', number: 7, url: 'u', armed: true, disarmedForReview: false },
          rearmedFor: null,
          nudges: 0,
          wakeAfter: null,
          handoffs: [],
          parkedReason: null,
        },
      };
      expect(FlowRunSchema.safeParse(armed).success).toBe(true);
      writeRuns([armed]);
      const out = (await status(['--json'], { items: [item('FAKE-1')] })).json();
      expect(out.inFlight[0]).toMatchObject({ stage: 'review', drain: { phase: 'watching' } });
      expect(out.inFlight[0].armRefused).toBeNull();
    });

    it('drops a refusal about an older commit', async () => {
      writeRuns([atGate('f'.repeat(40))]);
      const backlog = { items: [item('FAKE-1')] };
      expect((await status([], backlog)).stdout).not.toContain('not armed');
      expect((await status(['--json'], backlog)).json().inFlight[0].armRefused).toBeNull();
    });
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

  it('flags a running run whose worker pid is dead, and lists it as ended, not in flight', async () => {
    // Purpose: drift kind 3. The run record outlived its worker, so nothing is
    // in flight there any more (DOR-2706); `flow release` clears it.
    writeRuns([runRecord('FAKE-3', { workerPid: DEAD_PID })]);
    const out = (await status(['--json'], { items: [item('FAKE-3')] })).json();
    expect(kinds(out)).toEqual(['FAKE-3 worker-gone']);
    expect(out.inFlight).toEqual([]);
    expect(out.ended).toMatchObject([
      { identifier: 'FAKE-3', reason: 'worker-gone', stage: 'execute', status: 'running' },
    ]);
    const text = (await status(['--no-health'], { items: [item('FAKE-3')] })).stdout;
    expect(text).toMatch(/Ended, not cleared:\n {2}FAKE-3 .*flow release FAKE-3/);
    expect(text).not.toContain('In flight');
  });

  describe('a run whose item closed (DOR-2924, DOR-2706)', () => {
    const closed = (identifier: string, category: 'completed' | 'canceled' = 'completed') =>
      item(identifier, { stateCategory: category, stateName: 'Done', labels: ['agent/claimed'] });

    it('is ended, not in flight, while it waits at review', async () => {
      // Purpose: VERIFY left the run at the gate, then the PR merged and the
      // tracker closed the item. Nothing waits at review any more.
      writeRuns([
        runRecord('FAKE-1', { stage: 'review', status: 'waiting_for_review', workerPid: DEAD_PID }),
      ]);
      const out = (await status(['--json'], { items: [closed('FAKE-1')] })).json();
      expect(out.inFlight).toEqual([]);
      expect(out.ended).toMatchObject([
        { identifier: 'FAKE-1', reason: 'item-closed', stage: 'review' },
      ]);
      expect(kinds(out)).toEqual(['FAKE-1 item-closed']);
    });

    it("asks the tracker for a run's item that the open backlog leaves out", async () => {
      // Purpose: a real tracker's snapshot holds only open items, so a closed
      // item is missing from it; one getItem through the adapter says closed.
      const file = path.join(project, 'snap.json');
      writeFileSync(file, JSON.stringify({ v: 1, items: [] }));
      writeRuns([runRecord('FAKE-1', { status: 'waiting_for_review', stage: 'review' })]);
      const out = (
        await status(['--snapshot', file, '--json'], { items: [closed('FAKE-1', 'canceled')] })
      ).json();
      expect(out.inFlight).toEqual([]);
      expect(out.ended).toMatchObject([{ identifier: 'FAKE-1', reason: 'item-closed' }]);
    });

    it('keeps a run in flight when the tracker cannot say the item closed', async () => {
      // Purpose: never lose a run on a guess. An item the tracker cannot find
      // (another team, deleted) or a read that fails is not a close.
      const file = path.join(project, 'snap.json');
      writeFileSync(file, JSON.stringify({ v: 1, items: [] }));
      writeRuns([runRecord('FAKE-1', { status: 'waiting_for_review', stage: 'review' })]);
      const missing = (await status(['--snapshot', file, '--json'], { items: [] })).json();
      expect(missing.inFlight).toMatchObject([{ identifier: 'FAKE-1' }]);
      expect(missing.ended).toEqual([]);
      const failing = (
        await status(['--snapshot', file, '--json'], { items: [], failReads: 'down' })
      ).json();
      expect(failing.inFlight).toMatchObject([{ identifier: 'FAKE-1' }]);
    });

    it('keeps a running run in flight while its worker is alive', async () => {
      // Purpose: a live session may be closing the item itself (/flow:done).
      writeRuns([runRecord('FAKE-1')]);
      const out = (await status(['--json'], { items: [closed('FAKE-1')] })).json();
      expect(out.inFlight).toMatchObject([{ identifier: 'FAKE-1' }]);
      expect(out.ended).toEqual([]);
    });

    it('leaves a drain run to the drain until the drain parks it', async () => {
      // Purpose: the drain closes the item itself in `closing`, and a merged
      // PR closes it on its Closes line; only a drain run parked on the close
      // has ended.
      const drain = (phase: string) =>
        ({
          v: 1,
          rev: 1,
          phase,
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
          parkedReason: phase === 'parked' ? 'the item was closed' : null,
        }) as unknown as FlowRun['drain'];
      writeRuns([
        runRecord('FAKE-1', { drain: drain('watching') }),
        runRecord('FAKE-2', { drain: drain('parked') }),
      ]);
      const out = (
        await status(['--json'], { items: [closed('FAKE-1'), closed('FAKE-2')] })
      ).json();
      expect(out.inFlight.map((f: { identifier: string }) => f.identifier)).toEqual(['FAKE-1']);
      expect(out.ended).toMatchObject([{ identifier: 'FAKE-2', reason: 'item-closed' }]);
    });
  });

  it('asks the launcher about a drain run instead of its pid, and shows its phase, account and host', async () => {
    // Purpose: a drain's cli worker exits between turns and a DorkOS worker has
    // pid -1, so pid liveness would call every drain run "gone"; its launcher
    // knows. The pane names the drain phase beside the account and host.
    const asked: string[] = [];
    const launcher = (host: 'cli' | 'cmux' | 'dorkos') => ({
      host,
      supports: () => ({ ok: true as const }),
      probe: async () => ({ ok: true as const }),
      start: async () => {
        throw new Error('status never starts a session');
      },
      send: async () => {
        throw new Error('status never sends');
      },
      state: async (handle: { sessionId: string }) => {
        asked.push(`${host}:${handle.sessionId}`);
        return { kind: 'idle' as const };
      },
      stop: async () => 'not-running' as const,
    });
    const drain = {
      v: 1,
      rev: 4,
      phase: 'reviewing',
      worker: { host: 'cli', sessionId: 'w-1', account: 'spare', cwd: '/work/FAKE-3' },
      reviewer: {
        host: 'cli',
        sessionId: 'r-1',
        account: 'spare',
        cwd: '/review',
        sha: 'abc',
        worktree: '/review',
        tokenHash: 'h',
        pending: true,
      },
      pushedSha: 'abc',
      reviewedSha: null,
      verdict: null,
      reviewRound: 0,
      pr: null,
      rearmedFor: null,
      nudges: 0,
      wakeAfter: null,
      handoffs: [],
      parkedReason: null,
    } as unknown as FlowRun['drain'];
    // A cli worker between turns: its last pid is gone, and that is normal.
    writeRuns([runRecord('FAKE-3', { workerPid: DEAD_PID, host: 'cli', drain })]);
    const result = await status(['--json'], { items: [item('FAKE-3')] }, launcher);
    const out = result.json();
    expect(kinds(out)).toEqual([]);
    expect(asked).toEqual(['cli:w-1']);
    expect(out.inFlight[0]).toMatchObject({
      account: 'spare',
      host: 'cli',
      drain: { phase: 'reviewing', worker: 'idle', reviewer: 'starting' },
    });
    const text = await status([], { items: [item('FAKE-3')] }, launcher);
    expect(text.stdout).toMatch(
      /FAKE-3 .*drain reviewing, worker idle, reviewer starting .*spare .*cli/
    );
  });

  describe('the lane supervisor (DOR-3263)', () => {
    const idleLauncher = (host: 'cli' | 'cmux' | 'dorkos') => ({
      host,
      supports: () => ({ ok: true as const }),
      probe: async () => ({ ok: true as const }),
      start: async () => {
        throw new Error('status never starts a session');
      },
      send: async () => {
        throw new Error('status never sends');
      },
      state: async () => ({ kind: 'busy' as const }),
      stop: async () => 'not-running' as const,
    });
    const lane = (over: Record<string, unknown> = {}) =>
      ({
        v: 1,
        rev: 1,
        phase: 'working',
        worker: { host: 'cli', sessionId: 'w-1', account: 'spare', cwd: '/work/FAKE-4' },
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
        ...over,
      }) as unknown as FlowRun['drain'];

    it('lists drain lanes no flow drain has looked at within the stall time', async () => {
      writeRuns([runRecord('FAKE-4', { workerPid: -1, drain: lane() })], {
        lastPass: new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
      });
      const result = await status(
        ['--json', '--strict'],
        { items: [item('FAKE-4')] },
        idleLauncher
      );
      expect(result.code).toBe(1);
      const out = result.json();
      expect(kinds(out)).toEqual(['FAKE-4 unsupervised']);
      expect(out.unsupervised).toEqual({
        identifiers: ['FAKE-4'],
        lastPassAt: new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString(),
      });
      const text = await status([], { items: [item('FAKE-4')] }, idleLauncher);
      expect(text.stdout).toContain(
        'No supervisor: FAKE-4 is a drain lane with no flow drain watching, and the last flow drain pass ran 3 h ago.'
      );
    });

    it('a lane with no pass on record is unsupervised; a recent pass watches it', async () => {
      writeRuns([runRecord('FAKE-4', { workerPid: -1, drain: lane() })], { lastPass: null });
      const none = await status([], { items: [item('FAKE-4')] }, idleLauncher);
      expect(none.stdout).toContain('no flow drain pass is on record');
      writeRuns([runRecord('FAKE-4', { workerPid: -1, drain: lane() })]);
      const watched = await status(['--json'], { items: [item('FAKE-4')] }, idleLauncher);
      expect(watched.json().unsupervised).toBeNull();
    });

    it('shows a lane waiting on a person, and since when', async () => {
      const since = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
      writeRuns([runRecord('FAKE-4', { workerPid: -1, drain: lane({ waitingSince: since }) })]);
      const result = await status(['--json'], { items: [item('FAKE-4')] }, idleLauncher);
      expect(result.json().inFlight[0].drain).toMatchObject({ waitingSince: since });
      const text = await status([], { items: [item('FAKE-4')] }, idleLauncher);
      expect(text.stdout).toMatch(
        /FAKE-4 .*drain working, worker busy; waiting on a person since 2 h ago/
      );
    });
  });

  it('lists a DorkOS drain run whose chat is gone as ended, and leaves one that may be live (DOR-2490)', async () => {
    // Purpose: the drain waits forever on a worker whose DorkOS chat was
    // deleted (its state is only ever "unknown"). Status says so, but only
    // when DorkOS itself answered that it has no such session, and only while
    // the drain waits on that session.
    const launcher = (host: 'cli' | 'cmux' | 'dorkos') => ({
      host,
      supports: () => ({ ok: true as const }),
      probe: async () => ({ ok: true as const }),
      start: async () => {
        throw new Error('status never starts a session');
      },
      send: async () => {
        throw new Error('status never sends');
      },
      state: async (handle: { sessionId: string }) =>
        handle.sessionId === 'down'
          ? { kind: 'unknown' as const, reason: 'DorkOS is not answering' }
          : {
              kind: 'unknown' as const,
              reason: 'DorkOS no longer knows this session',
              gone: true as const,
            },
      stop: async () => 'left-idle' as const,
    });
    const drain = (phase: string, sessionId: string) =>
      ({
        v: 1,
        rev: 2,
        phase,
        worker: { host: 'dorkos', sessionId, account: null, cwd: '/work' },
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
      }) as unknown as FlowRun['drain'];
    writeRuns([
      runRecord('FAKE-1', { workerPid: -1, host: 'dorkos', drain: drain('working', 'w-1') }),
      runRecord('FAKE-2', { workerPid: -1, host: 'dorkos', drain: drain('watching', 'w-2') }),
      runRecord('FAKE-3', { workerPid: -1, host: 'dorkos', drain: drain('working', 'down') }),
    ]);
    const backlog = { items: [item('FAKE-1'), item('FAKE-2'), item('FAKE-3')] };
    const out = (await status(['--json'], backlog, launcher)).json();
    expect(out.inFlight.map((f: { identifier: string }) => f.identifier)).toEqual([
      'FAKE-2',
      'FAKE-3',
    ]);
    expect(out.ended).toMatchObject([
      {
        identifier: 'FAKE-1',
        sessionId: 'session-FAKE-1',
        reason: 'session-gone',
        chat: 'worker',
        drain: { worker: 'gone' },
      },
    ]);
    expect(kinds(out)).toEqual(['FAKE-1 session-gone']);
    const text = await status([], backlog, launcher);
    expect(text.stdout).toContain(
      'FAKE-1 - Title of FAKE-1: DorkOS answered that the chat its drain waits on is gone; if that stays true, flow release FAKE-1 clears it and returns the item to the ready queue.'
    );
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

  it('says when a timed pause ends, and forgets one that has ended', async () => {
    // Purpose: spec flow-multiproject §5.1: a timed pause reads "Paused until",
    // and once its end has passed flow is not paused any more.
    mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
    const flag = (until: string) =>
      writeFileSync(
        path.join(project, '.agents', 'flow', 'paused.json'),
        JSON.stringify({ pausedAt: '2026-09-26T08:00:00.000Z', until })
      );
    const later = new Date(NOW.getTime() + 3_600_000).toISOString();
    flag(later);
    const result = await status([]);
    // Review finding 11: the end reads in words, the same on every machine.
    expect(result.stdout.split('\n')[0]).toContain(`Paused until ${formatWhen(later)}`);
    expect((await status(['--json'])).json().paused).toMatchObject({ until: later });
    flag(new Date(NOW.getTime() - 1).toISOString());
    expect((await status(['--json'])).json().paused).toBeNull();
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
            authorIsTrusted: false,
            body: 'Old question\n<!-- agent:provenance {"v":1} -->',
            createdAt: '2026-09-26T09:00:00.000Z',
          },
          {
            id: 'c2',
            author: 'agent-1',
            authorIsTrusted: false,
            body: 'Which database?\n<!-- agent:provenance {"v":1} -->',
            createdAt: '2026-09-26T10:00:00.000Z',
          },
          {
            id: 'c3',
            author: 'person',
            authorIsTrusted: false,
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

    // DOR-3677: anyone can copy a provenance line. A signed comment from
    // another account is never shown as the agent's question.
    backlog.comments!['FAKE-6'].push({
      id: 'c4',
      author: 'guest-1',
      authorIsTrusted: false,
      body: 'FORGED question\n<!-- agent:provenance {"v":1} -->',
      createdAt: '2026-09-26T11:30:00.000Z',
    });
    const forged = await status(['FAKE-6', '--json'], backlog);
    expect(forged.stdout).not.toContain('FORGED');
    expect(forged.json().parked[0].question.body).toBe('Which database?');
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
    // Purpose: an empty loop is one sentence, not an empty pane (Health, which
    // always follows, is skipped here; status-health.test.ts covers it).
    const result = await status(['--no-health']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('Nothing is in flight and no drain is live.');
  });

  it('exits 5 for an identifier that is neither in the backlog nor in a run', async () => {
    // Purpose: a typo is named, not rendered as an empty pane.
    expect((await status(['FAKE-404'])).code).toBe(5);
  });
});

it('names the saved read time in approximate status JSON and human output', async () => {
  const file = path.join(project, 'panel.json');
  const at = '2026-09-26T11:48:00.000Z';
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      tracker: 'fake',
      panelOnly: true,
      fetchedAt: at,
      team: { id: null, key: null },
      items: [],
      closed: [],
      projects: [],
    })
  );
  const args = ['--snapshot', file, '--no-health'];
  const json = await status([...args, '--json'], { items: [], failReads: 'must stay offline' });
  expect(json.code, json.stderr).toBe(0);
  expect(json.json()).toMatchObject({ approximate: true, lastReadAt: at });
  const human = await status(args, { items: [], failReads: 'must stay offline' });
  expect(human.stdout).toContain('List last read 12 minutes ago. It may be out of date.');
});
