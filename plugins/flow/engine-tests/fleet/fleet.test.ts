/**
 * `flow fleet` end to end through `main(argv, deps)` (spec `flow-usage` §2.6):
 * a temp DORK_HOME, temp config dirs and a temp project; a fake `ps`/`git`
 * runner, a fake pid check and a fake fetch. Nothing touches the machine's own
 * accounts, sessions, processes or network.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessRunner, TextSink } from '../../scripts/cli/context.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/usage');
const NOW = '2026-09-26T16:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const M = 60_000;
const H = 60 * M;

// Made-up session ids.
const CLI_BUSY = '1a2b3c4d-1111-4111-8111-111111111111';
const CLI_IDLE = '2b3c4d5e-2222-4222-8222-222222222222';
const DORKOS_LIVE = '3c4d5e6f-3333-4333-8333-333333333333';
const RUN_ONLY = '4d5e6f70-4444-4444-8444-444444444444';

let root: string;
let home: string;
let dorkHome: string;
let project: string;
let worktree: string;

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-fleet-'));
  // The OS home is the temp root, so every place reads as ~/..., whatever tmpdir is.
  home = root;
  dorkHome = path.join(root, 'dork');
  project = path.join(root, 'project');
  worktree = path.join(root, 'project-wt', 'feature');
  mkdirSync(worktree, { recursive: true });

  writeJson(path.join(dorkHome, 'config.json'), {
    runtimes: {
      claudeCode: {
        accounts: [
          { id: 'claude2', path: path.join(home, '.claude2'), label: 'Claude 2' },
          { id: 'claude3', path: path.join(home, '.claude3') },
          { id: 'Bad_Id', path: path.join(home, '.bad') },
        ],
      },
    },
  });
  writeJson(path.join(dorkHome, 'flow', 'fleet.json'), {
    v: 1,
    accounts: { claude2: { role: 'main' }, claude3: { role: 'rotation' } },
  });
  writeJson(path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'claude2.json'), {
    v: 1,
    accountId: 'claude2',
    updatedAt: at(-3 * M),
    windows: {
      five_hour: {
        usedPct: 41,
        resetsAt: at(2 * H + 14 * M),
        status: 'allowed',
        observedAt: at(-3 * M),
        source: 'statusline',
      },
      seven_day: {
        usedPct: 72,
        resetsAt: at(76 * H),
        status: 'allowed',
        observedAt: at(-3 * M),
        source: 'statusline',
      },
      // Stale: no reset time and older than a week. It must be absent.
      'model:opus': {
        usedPct: 10,
        status: 'allowed',
        observedAt: at(-9 * 24 * H),
        source: 'sdk_event',
      },
    },
  });
  writeJson(path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'claude3.json'), {
    v: 1,
    accountId: 'claude3',
    updatedAt: at(-H),
    windows: {
      five_hour: {
        usedPct: 100,
        resetsAt: at(42 * M),
        status: 'rejected',
        observedAt: at(-H),
        source: 'transcript',
      },
      // Expired: reset an hour ago, so it reads 0% and expired.
      seven_day: {
        usedPct: 90,
        resetsAt: at(-H),
        status: 'allowed',
        observedAt: at(-8 * H),
        source: 'statusline',
      },
    },
  });

  writeJson(path.join(home, '.claude2', 'sessions', '1001.json'), {
    pid: 1001,
    sessionId: CLI_BUSY,
    cwd: worktree,
    status: 'busy',
    startedAt: Date.parse(at(-3 * H)),
    procStart: 'Sat Sep 26 13:00:00 2026',
  });
  writeJson(path.join(home, '.claude3', 'sessions', '1002.json'), {
    pid: 1002,
    sessionId: CLI_IDLE,
    cwd: path.join(home, 'Keep', 'dorkos'),
    status: 'idle',
    startedAt: Date.parse(at(-12 * M)),
    procStart: 'Sat Sep 26 15:48:00 2026',
  });

  writeJson(path.join(project, '.dork', 'flow', 'flow-state.json'), {
    'issue-1': {
      issueId: 'issue-1',
      identifier: 'DOR-2370',
      sessionId: CLI_BUSY,
      worktreePath: worktree,
      branch: 'x',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: 1001,
      startedAt: at(-3 * H),
      account: 'claude2',
    },
    'issue-2': {
      issueId: 'issue-2',
      identifier: 'DOR-2371',
      sessionId: DORKOS_LIVE,
      worktreePath: project,
      branch: 'y',
      stage: 'verify',
      status: 'running',
      attemptCount: 0,
      startedAt: at(-H),
      account: 'claude2',
      host: 'dorkos',
    },
    'issue-3': {
      issueId: 'issue-3',
      identifier: 'DOR-2372',
      sessionId: RUN_ONLY,
      worktreePath: path.join(root, 'project-wt', 'gone'),
      branch: 'z',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: 4242,
      startedAt: at(-5 * H),
      account: 'claude3',
      host: 'cli',
    },
    'issue-4': {
      issueId: 'issue-4',
      identifier: 'DOR-2373',
      sessionId: 'done',
      status: 'complete',
      stage: 'done',
      attemptCount: 0,
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A text buffer standing in for stdout or stderr. */
function sink(): TextSink & { text: string } {
  const buffer = { text: '', write: (chunk: string) => (buffer.text += chunk) };
  return buffer;
}

/** A fake `ps`/`git` that knows only this test's pids and the temp project. */
function fakeRunner(): ProcessRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const starts: Record<string, string> = {
    '1001': 'Sat Sep 26 13:00:00 2026',
    '1002': 'Sat Sep 26 15:48:00 2026',
  };
  const runner = vi.fn(async (cmd: string, args: readonly string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'env' && args.join(' ').startsWith('TZ=UTC LC_ALL=C ps -o pid=,lstart= -p ')) {
      const pids = args[args.length - 1].split(',');
      const lines = pids.filter((p) => starts[p]).map((p) => ` ${p} ${starts[p]}`);
      return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
    }
    if (
      cmd === 'git' &&
      args[0] === '-C' &&
      args.slice(2).join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
    ) {
      const cwd = args[1];
      if (
        cwd === project ||
        cwd.startsWith(`${project}/`) ||
        cwd.startsWith(path.join(root, 'project-wt'))
      ) {
        return { code: 0, stdout: `${path.join(project, '.git')}\n`, stderr: '' };
      }
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  });
  return Object.assign(runner, { calls });
}

type FetchAnswer = { status: number; body: unknown } | 'refused';

/** A fake fetch that records every request and gives one scripted answer. */
function fakeFetch(answer: FetchAnswer) {
  const requests: { url: string; method: string }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    if (answer === 'refused') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  return { impl: impl as unknown as typeof fetch, requests };
}

/** A DorkOS answer holding one live session that serves DOR-2371. */
function liveDorkos(): FetchAnswer {
  return {
    status: 200,
    body: {
      sessions: [
        {
          id: DORKOS_LIVE,
          createdAt: at(-H),
          runtime: 'claude-code',
          accountId: 'claude2',
          cwd: project,
          status: { lifecycle: 'streaming', limit: null },
        },
        // History with no live status and no active run: not shown.
        {
          id: '99999999-9999-4999-8999-999999999999',
          createdAt: at(-72 * H),
          runtime: 'claude-code',
          cwd: project,
        },
      ],
    },
  };
}

const ALIVE = new Set([1001, 1002]);

function run(argv: string[], fetchAnswer: FetchAnswer = liveDorkos()) {
  const stdout = sink();
  const stderr = sink();
  const runner = fakeRunner();
  const fetch = fakeFetch(fetchAnswer);
  const createAdapter = vi.fn(async () => {
    throw new Error('flow fleet must not need a tracker');
  });
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome },
    cwd: project,
    now: () => new Date(NOW),
    stdout,
    stderr,
    createAdapter,
    runProcess: runner,
    io: { osHome: home, fetch: fetch.impl, pidAlive: (pid) => ALIVE.has(pid) },
  };
  return {
    exec: () => main(['fleet', ...argv], deps),
    stdout,
    stderr,
    runner,
    fetch,
    createAdapter,
  };
}

/** Every file and folder under `dir`: path, size, mtime and a hash of its bytes. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        out.push(`${full}/ ${stat.mtimeMs}`);
        walk(full);
      } else {
        const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
        out.push(`${full} ${stat.size} ${stat.mtimeMs} ${hash}`);
      }
    }
  };
  walk(dir);
  return out;
}

describe('flow fleet', () => {
  it('joins Claude Code files, DorkOS and flow runs, so a session serving an item shows it', async () => {
    // Purpose: DOR-2370 validations 1 and 2. Each source alone misses something: the CLI
    // file has no item, DorkOS has no run, the run has no live process.
    const { exec, stdout, stderr, createAdapter } = run([]);
    expect(await exec()).toBe(0);
    const text = stdout.text;
    const sessions = text.slice(text.indexOf('Sessions\n'), text.indexOf('\n\nSessions on'));
    expect(sessions.split('\n')).toEqual([
      'Sessions',
      '  claude2  DOR-2370  busy     cli     1a2b3c4d  ~/project-wt/feature  3h',
      '  claude2  DOR-2371  busy     dorkos  3c4d5e6f  ~/project             1h',
      '  claude3  DOR-2372  stale    cli     4d5e6f70  ~/project-wt/gone     5h',
      '  claude3  -         limited  cli     2b3c4d5e  ~/Keep/dorkos         12m',
    ]);
    expect(text).toContain('  Bad_Id   invalid id, not tracked');
    expect(text).toContain('Sessions on accounts flow does not know are not shown.');
    // DorkOS contributed a row, so there is no DorkOS line.
    expect(text).not.toContain('DorkOS:');
    expect(createAdapter).not.toHaveBeenCalled();
    // Only the invalid id's own warning; nothing else went wrong.
    expect(stderr.text.trim().split('\n')).toHaveLength(1);
    expect(stderr.text).toContain('"Bad_Id"');
  });

  it('warns when a run store cannot be read, and still shows the live sessions', async () => {
    // Purpose: a corrupt flow-state.json must say so on stderr, never read silently as "no runs".
    writeFileSync(path.join(project, '.dork', 'flow', 'flow-state.json'), '{ torn');
    const { exec, stdout, stderr } = run([]);
    expect(await exec()).toBe(0);
    expect(stderr.text).toContain(path.join(project, '.dork', 'flow', 'flow-state.json'));
    expect(stdout.text).toMatch(/ {2}claude2 +- +busy +cli +1a2b3c4d/);
  });

  it('prints the --json shape the spec names', async () => {
    // Purpose: agents and S3 dispatch read this payload; its fields and meanings are a contract.
    const { exec, stdout } = run(['--json']);
    expect(await exec()).toBe(0);
    const payload = JSON.parse(stdout.text);
    expect(Object.keys(payload)).toEqual([
      'v',
      'now',
      'handoff',
      'accounts',
      'sessions',
      'dorkos',
      'warnings',
    ]);
    expect(payload.v).toBe(1);
    expect(payload.now).toBe(NOW);
    expect(payload.handoff).toBe('auto');

    const [claude2, claude3, bad] = payload.accounts;
    expect(Object.keys(claude2)).toEqual([
      'id',
      'label',
      'color',
      'path',
      'validId',
      'role',
      'reservePct',
      'effectiveReservePct',
      'scopeRepos',
      'fiveHourRoom',
      'weeklyRoom',
      'lastSeen',
      'windows',
    ]);
    expect(claude2).toMatchObject({
      id: 'claude2',
      label: 'Claude 2',
      color: null,
      path: path.join(home, '.claude2'),
      validId: true,
      role: 'main',
      reservePct: 50,
      effectiveReservePct: 50,
      scopeRepos: [],
      fiveHourRoom: true,
      // 72% used against a 50% reserve: no weekly room.
      weeklyRoom: false,
      lastSeen: at(-3 * M),
    });
    // The stale model window is absent.
    expect(Object.keys(claude2.windows)).toEqual(['five_hour', 'seven_day']);
    expect(claude2.windows.five_hour).toEqual({
      usedPct: 41,
      resetsAt: at(2 * H + 14 * M),
      status: 'allowed',
      observedAt: at(-3 * M),
      source: 'statusline',
      expired: false,
    });
    // Expired: usedPct 0 and expired: true. Rejected: no 5-hour room.
    expect(claude3.windows.seven_day).toMatchObject({ usedPct: 0, expired: true });
    expect(claude3).toMatchObject({ role: 'rotation', fiveHourRoom: false, weeklyRoom: true });
    expect(bad).toMatchObject({ id: 'Bad_Id', validId: false, role: 'kept-out', windows: {} });

    const busy = payload.sessions[0];
    expect(busy).toEqual({
      sessionId: CLI_BUSY,
      account: 'claude2',
      item: 'DOR-2370',
      stage: 'execute',
      state: 'busy',
      host: 'cli',
      pid: 1001,
      cwd: worktree,
      startedAt: at(-3 * H),
      sources: ['claude-code', 'flow-run'],
    });
    expect(payload.sessions.map((s: { state: string }) => s.state)).toEqual([
      'busy',
      'busy',
      'stale',
      'limited',
    ]);
    expect(payload.dorkos).toEqual({
      url: 'http://127.0.0.1:4242',
      reachable: true,
      sessionsShown: 1,
    });
    expect(payload.warnings).toHaveLength(1);
  });

  it('changes nothing on disk, and its only request is one GET to DorkOS', async () => {
    // Purpose: DOR-2370 validation 3. fleet reads only: no ledger, stamp, lock or run store is touched.
    const before = snapshot(root);
    const { exec, fetch, runner } = run([]);
    expect(await exec()).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(fetch.requests).toEqual([
      { url: 'http://127.0.0.1:4242/api/sessions?limit=500', method: 'GET' },
    ]);
    // Every process it started was a read: one ps, and git rev-parse per distinct folder.
    const kinds = runner.calls.map((c) => (c[0] === 'env' ? 'ps' : `git ${c[3]}`));
    expect(kinds.filter((k) => k === 'ps')).toHaveLength(1);
    expect(kinds.every((k) => k === 'ps' || k === 'git rev-parse')).toBe(true);
  });

  it('says DorkOS is not running when nothing answers, without a warning', async () => {
    // Purpose: a person with no DorkOS gets a plain note, not an error.
    const { exec, stdout, stderr } = run([], 'refused');
    expect(await exec()).toBe(0);
    expect(stdout.text.trimEnd().split('\n').at(-1)).toBe(
      'DorkOS: not running at http://127.0.0.1:4242'
    );
    expect(stderr.text).not.toContain('DorkOS');
    // The run DorkOS hosted still shows, from its run record.
    expect(stdout.text).toContain('DOR-2371  unseen   dorkos');
  });

  it('warns naming the status when DorkOS answers 401, and claims nothing about its sessions', async () => {
    // Purpose: with sign-in on, DorkOS refuses; that is a warning, and "no live sessions" would be untrue.
    const { exec, stdout, stderr } = run(['--json'], { status: 401, body: { error: 'sign in' } });
    expect(await exec()).toBe(0);
    expect(stderr.text).toMatch(/warning: DorkOS answered 401/);
    const payload = JSON.parse(stdout.text);
    expect(payload.dorkos).toEqual({
      url: 'http://127.0.0.1:4242',
      reachable: true,
      sessionsShown: 0,
    });
    expect(payload.warnings.some((w: string) => w.includes('401'))).toBe(true);

    const human = run([], { status: 401, body: {} });
    expect(await human.exec()).toBe(0);
    expect(human.stdout.text).not.toContain('DorkOS:');
  });

  it('notes a running DorkOS with no live sessions when its answer keeps no row', async () => {
    // Purpose: a release before D7/D8 and one with nothing live read the same, so the note says only that.
    const body = JSON.parse(
      readFileSync(path.join(FIXTURES, 'dorkos', 'sessions-pre-d7.json'), 'utf8')
    );
    const { exec, stdout, stderr } = run([], { status: 200, body });
    expect(await exec()).toBe(0);
    expect(stdout.text.trimEnd().split('\n').at(-1)).toBe(
      'DorkOS: running at http://127.0.0.1:4242, no live sessions'
    );
    expect(stderr.text).not.toContain('DorkOS');
  });

  it('refuses a DorkOS URL off this machine with exit 2, before reading or asking anything', async () => {
    // Purpose: fleet never sends a request anywhere but this machine.
    const { exec, stdout, stderr, fetch, runner } = run([
      '--dorkos-url',
      'http://example.com:4242',
    ]);
    expect(await exec()).toBe(2);
    expect(stderr.text).toContain('only asks a DorkOS on this machine');
    expect(stdout.text).toBe('');
    expect(fetch.requests).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it('asks the --dorkos-url it is given, when that is on this machine', async () => {
    // Purpose: the flag is honored, not silently replaced by the default.
    const { exec, fetch } = run(['--dorkos-url', 'http://localhost:6242']);
    expect(await exec()).toBe(0);
    expect(fetch.requests.map((r) => r.url)).toEqual([
      'http://localhost:6242/api/sessions?limit=500',
    ]);
  });

  it('makes no request with --no-dorkos, and refuses it together with --dorkos-url', async () => {
    // Purpose: --no-dorkos is a promise of no network at all.
    const { exec, stdout, fetch } = run(['--no-dorkos', '--json']);
    expect(await exec()).toBe(0);
    expect(fetch.requests).toEqual([]);
    expect(JSON.parse(stdout.text).dorkos).toBeNull();

    const both = run(['--no-dorkos', '--dorkos-url', 'http://127.0.0.1:1']);
    expect(await both.exec()).toBe(2);
    expect(both.fetch.requests).toEqual([]);
  });
});
