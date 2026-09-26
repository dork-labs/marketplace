/**
 * `flow drain` end to end with fakes (spec `flow-handoff-dispatch` §4, task
 * 3.5): driven through `main` with the shipped verb table, against a real temp
 * git project with a bare `origin` and a temp DorkOS home. The launcher, the
 * forge and the tracker are fakes that record every call; git is real, except
 * that `git remote get-url origin` answers a GitHub address so the forge
 * resolves. The worker's and reviewer's own verbs (`flow checkpoint`, `flow
 * report`, `flow pr`, `flow done`) run for real, so the review gate is the
 * shipped one.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';
import { drain, type DrainOptions } from '../../scripts/cli/drain.ts';
import { BRIEF_VARS, renderBrief, renderTemplate } from '../../scripts/drain/briefs.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
import { dueForSnapshot } from '../../scripts/drain/usage-sample.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { main, VERBS } from '../../scripts/flow.ts';
import type { CreatePrInput, Forge, PrStatus } from '../../scripts/forge/types.ts';
import {
  LaunchError,
  type HostName,
  type LaunchRequest,
  type Launcher,
  type SessionHandle,
  type SessionState,
} from '../../scripts/launchers/types.ts';
import { createFakeAdapter, type FakeTracker } from '../fixtures/cli/fake-adapter/adapter.ts';
import { item, makeProject, type WriteProject } from '../cli/write-harness.ts';

const FLOW_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const T0 = Date.parse('2026-09-26T12:00:00.000Z');

let project: WriteProject;
let origin: string;
let dorkHome: string;
let clock: number;
let load: { load1: number; cpus: number };

/** Run git in `cwd` with a fixed identity. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

/** Every call a fake launcher saw. */
interface LauncherLog {
  starts: { host: HostName; req: LaunchRequest; handle: SessionHandle }[];
  sends: { handle: SessionHandle; file: string; text: string }[];
  stops: SessionHandle[];
}

/** How the fake launcher should behave. */
interface LauncherScript {
  /** Throw this from the next start, before anything starts. */
  failNext?: LaunchError;
  /** Record the next start as started, then throw a plain error (the supervisor dies). */
  crashNext?: boolean;
  /** Called during each start, after the session "exists". */
  onStart?: (req: LaunchRequest) => void;
  /** Called during each state read. */
  onState?: (handle: SessionHandle) => void;
  /** Session states by session id (default busy). */
  states: Map<string, SessionState>;
}

/** A launcher per host that records every call and starts nothing real. */
function fakeLaunchers(log: LauncherLog, script: LauncherScript) {
  let pid = 5000;
  return (host: HostName): Launcher => ({
    host,
    supports: () => ({ ok: true }),
    probe: async () => ({ ok: true }),
    async start(req) {
      if (script.failNext) {
        const error = script.failNext;
        script.failNext = undefined;
        throw error;
      }
      const handle: SessionHandle = {
        host,
        runtime: req.runtime,
        sessionId: req.sessionId,
        account: req.account?.id ?? null,
        cwd: req.cwd,
        ...(host === 'dorkos' ? {} : { pid: (pid += 1) }),
      };
      log.starts.push({ host, req, handle });
      script.onStart?.(req);
      if (script.crashNext) {
        script.crashNext = false;
        throw new Error('simulated crash after the session started');
      }
      return handle;
    },
    async send(handle, file) {
      log.sends.push({ handle, file, text: readFileSync(file, 'utf8') });
      return { result: 'delivered', handle };
    },
    async state(handle) {
      script.onState?.(handle);
      return script.states.get(handle.sessionId) ?? { kind: 'busy' };
    },
    async stop(handle) {
      log.stops.push(handle);
      return 'stopped';
    },
  });
}

/** A fake forge whose createPr and arm check the review gate at call time. */
function fakeForge() {
  const calls: { method: string; arg?: unknown }[] = [];
  const violations: string[] = [];
  let armed = false;
  let prNumber: number | null = null;
  const status: Partial<PrStatus> = {};
  /** The gate the whole drain exists for: a clean verdict at the branch head on origin. */
  const gate = (what: string) => {
    const run = Object.values(project.runs()).find((r) => r.identifier === 'ACME-1');
    const d = run?.drain;
    const head = git(project.dir, 'ls-remote', 'origin', `refs/heads/${run?.branch}`).split(
      /\s+/
    )[0];
    if (!d || d.verdict !== 'clean' || d.reviewedSha !== head) {
      violations.push(
        `${what} without a clean review at the head (${d?.verdict} at ${d?.reviewedSha}, head ${head})`
      );
    }
  };
  const forge: Forge = {
    repo: 'acme/app',
    async branchHead() {
      return null;
    },
    async prForBranch() {
      calls.push({ method: 'prForBranch' });
      return prNumber === null ? null : { number: prNumber, url: `u/${prNumber}`, headSha: null };
    },
    async createPr(input: CreatePrInput) {
      calls.push({ method: 'createPr', arg: input });
      gate('createPr');
      prNumber = 7;
      return { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: null };
    },
    async prStatus(pr) {
      calls.push({ method: 'prStatus', arg: pr });
      return {
        state: 'open',
        failing: [],
        armed,
        queued: false,
        headSha: 'x',
        base: 'work',
        ...status,
      };
    },
    async arm(pr) {
      calls.push({ method: 'arm', arg: pr });
      gate('arm');
      armed = true;
    },
    async disarm(pr) {
      calls.push({ method: 'disarm', arg: pr });
      armed = false;
    },
    async recentGroupFailures() {
      return [];
    },
  };
  return { forge, calls, violations, status };
}

/** Real git, except `remote get-url origin` answers a GitHub address. */
const runner: ProcessRunner = async (cmd, args, opts) => {
  if (cmd === 'git' && args.join(' ') === 'remote get-url origin') {
    return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' };
  }
  if (cmd === 'ps') return { code: 0, stdout: '  4242\n', stderr: '' };
  return realProcessRunner(cmd, args, opts);
};

/** The world one test drives. */
interface World {
  tracker: FakeTracker;
  log: LauncherLog;
  script: LauncherScript;
  forge: ReturnType<typeof fakeForge>;
  options: DrainOptions;
}

let world: World;

/** Run `flow <argv> --json` with the fakes; `drain` gets the test's options. */
async function flow(argv: string[], cwd = project.dir) {
  let out = '';
  let err = '';
  const verbs = VERBS.map((verb) =>
    verb.name === 'drain'
      ? {
          ...verb,
          load: async () => ({
            run: (ctx: Parameters<typeof drain>[0]) => drain(ctx, world.options),
          }),
        }
      : verb
  );
  const code = await main([...argv, '--json'], {
    env: { FLOW_SESSION_ID: 'supervisor-session', CLAUDECODE: '1', DORK_HOME: dorkHome },
    cwd,
    now: () => new Date(clock),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    createAdapter: async () => world.tracker.adapter,
    runProcess: runner,
    createForge: () => world.forge.forge,
    createLauncher: fakeLaunchers(world.log, world.script),
    io: { load: () => load, sleep: async () => undefined },
    verbs,
  });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(out) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { code, json, stdout: out, stderr: err };
}

/** One `flow drain --tick` pass, on the cli host unless `extra` names another. */
function tick(...extra: string[]) {
  const host = extra.includes('--host') ? [] : ['--host', 'cli'];
  return flow(['drain', '--tick', '--parallel', '1', ...host, ...extra]);
}

/** The run for an item. */
function runOf(identifier: string): FlowRun {
  const run = Object.values(project.runs()).find((r) => r.identifier === identifier);
  if (!run) throw new Error(`no run for ${identifier}`);
  return run;
}

/** Its drain. */
function drainOf(identifier: string): DrainState {
  return runOf(identifier).drain as DrainState;
}

const BODY = [
  '## Done',
  '',
  '- A task.',
  '',
  '## Next',
  '',
  '- The next task.',
  '',
  '## Open questions',
  '',
  'None.',
  '',
  '## Next command',
  '',
  '```sh',
  'flow report ACME-1 pushed',
  '```',
  '',
].join('\n');

/** The worker commits, checkpoints, pushes and reports; returns the SHA. */
async function workerPushes(identifier: string, label: string, trigger = 'task'): Promise<string> {
  const run = runOf(identifier);
  const wt = run.worktreePath;
  writeFileSync(path.join(wt, `${label}.txt`), label);
  git(wt, 'add', `${label}.txt`);
  git(wt, 'commit', '-q', '-m', label);
  const body = path.join(wt, '.dork', 'flow', 'drain', 'checkpoint-body.md');
  mkdirSync(path.dirname(body), { recursive: true });
  writeFileSync(body, BODY);
  const checkpoint = await flow(
    [
      'checkpoint',
      identifier,
      '--trigger',
      trigger,
      ...(trigger === 'task' ? ['--task', label] : []),
      '--body-file',
      body,
    ],
    wt
  );
  expect(checkpoint.code, checkpoint.stderr).toBe(0);
  git(wt, 'push', '-q', 'origin', run.branch);
  const report = await flow(['report', identifier, 'pushed'], wt);
  expect(report.code, report.stderr).toBe(0);
  return git(wt, 'rev-parse', 'HEAD');
}

/** The latest reviewer start. */
function lastReviewer() {
  const start = world.log.starts.filter((s) => s.req.role === 'reviewer').at(-1);
  if (!start) throw new Error('no reviewer started');
  return start;
}

/** The reviewer records its verdict with the token from its own brief. */
async function reviewerSays(identifier: string, sha: string, verdict: 'clean' | 'changes') {
  const start = lastReviewer();
  const brief = readFileSync(start.req.promptFile, 'utf8');
  const token = /--token ([0-9a-f]{32})/.exec(brief)?.[1];
  expect(token).toBeDefined();
  const extra: string[] = ['--clean'];
  if (verdict === 'changes') {
    const findings = path.join(start.req.cwd, 'findings.md');
    writeFileSync(findings, '1. blocker: a.txt:1 breaks on empty input. Fix: guard it.\n');
    extra.splice(0, 1, '--changes', '--findings-file', findings);
  }
  const result = await flow(
    ['report', identifier, 'verdict', '--sha', sha, '--token', token as string, ...extra],
    start.req.cwd
  );
  expect(result.code, result.stderr).toBe(0);
}

/** Register Claude Code accounts under the temp DorkOS home, each with a fleet policy. */
function fleet(accounts: Record<string, Record<string, unknown>>): void {
  const put = (rel: string, value: unknown) => {
    const file = path.join(dorkHome, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  put('config.json', {
    runtimes: {
      claudeCode: {
        accounts: Object.keys(accounts).map((id) => ({
          id,
          path: path.join(dorkHome, 'claude', id),
          label: `Label ${id}`,
        })),
      },
    },
  });
  put('flow/fleet.json', {
    v: 1,
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([id, e]) => [`claude-code:${id}`, e])
    ),
  });
}

/** The project config, with drain settings on top. */
function configure(drainSettings: Record<string, unknown> = {}): void {
  project.config({
    tracker: 'fake',
    identity: { agent: 'agent-1' },
    autonomy: { wipCap: { global: 10, perProject: 10 } },
    models: { bindings: { workhorse: 'model-x' } },
    drain: drainSettings,
  });
}

beforeEach(() => {
  project = makeProject();
  origin = `${project.dir}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'work', origin]);
  git(project.dir, 'remote', 'add', 'origin', origin);
  git(project.dir, 'push', '-q', 'origin', 'work');
  git(project.dir, 'fetch', '-q', 'origin');
  git(project.dir, 'remote', 'set-head', 'origin', 'work');
  dorkHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-drain-home-')));
  clock = T0;
  load = { load1: 0.5, cpus: 8 };
  configure();
  world = {
    tracker: createFakeAdapter({
      user: { id: 'agent-1' },
      items: [item('ACME-1'), item('ACME-2')],
    }),
    log: { starts: [], sends: [], stops: [] },
    script: { states: new Map() },
    forge: fakeForge(),
    options: {},
  };
});

afterEach(() => {
  project.cleanup();
  rmSync(origin, { recursive: true, force: true });
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('flow drain: one item from pick to closing', () => {
  it('claims queued, reviews every push in a separate session, and opens and arms the PR only after a clean review at the head', async () => {
    // Purpose: the whole loop the drain exists for, with the forge fake
    // checking at every createPr and arm that a clean verdict covers the branch
    // head. A drain that opened or armed a PR early fails here.
    world.tracker = createFakeAdapter({ user: { id: 'agent-1' }, items: [item('ACME-1')] });
    let queuedAtStart: FlowRun | undefined;
    world.script.onStart = (req) => {
      if (req.role === 'worker') queuedAtStart = runOf('ACME-1');
    };

    // Pass 1: picked, claimed queued with the worker's intent, then started and running.
    let pass = await tick();
    expect(pass.code, pass.stderr).toBe(0);
    expect(queuedAtStart?.status).toBe('queued');
    expect(queuedAtStart?.drain?.worker).toMatchObject({ pending: true });
    const worker = world.log.starts[0];
    expect(worker.req).toMatchObject({ role: 'worker', runtime: 'claude-code', model: 'model-x' });
    expect(runOf('ACME-1')).toMatchObject({
      status: 'running',
      sessionId: worker.handle.sessionId,
      workerPid: worker.handle.pid,
      runtime: 'claude-code',
      host: 'cli',
    });
    expect(drainOf('ACME-1').worker).toMatchObject({ sessionId: worker.handle.sessionId });
    expect(drainOf('ACME-1').worker?.pending).toBeUndefined();
    expect(runOf('ACME-1').worktreePath).toBe(
      path.join(dorkHome, 'workspaces', 'app', 'ACME-1-title-of-acme-1')
    );
    expect(readFileSync(worker.req.promptFile, 'utf8')).not.toMatch(/\{\{/);
    expect(pass.stderr).toContain('claude-code sessions run on');

    // Push 1 -> a reviewer at that SHA, in its own session and detached worktree.
    const s1 = await workerPushes('ACME-1', 'one');
    pass = await tick();
    let reviewer = lastReviewer();
    expect(reviewer.req.sessionId).not.toBe(worker.req.sessionId);
    expect(git(reviewer.req.cwd, 'rev-parse', 'HEAD')).toBe(s1);
    expect(reviewer.req.cwd).not.toBe(runOf('ACME-1').worktreePath);
    // The token is only in the reviewer's brief; the store keeps its hash.
    const brief = readFileSync(reviewer.req.promptFile, 'utf8');
    const token = /--token ([0-9a-f]{32})/.exec(brief)?.[1] as string;
    expect(drainOf('ACME-1').reviewer?.tokenHash).toBe(
      createHash('sha256').update(token).digest('hex')
    );
    expect(JSON.stringify(project.runs())).not.toContain(token);

    // Changes -> the worker gets the findings; the reviewer is stopped and its worktree removed.
    await reviewerSays('ACME-1', s1, 'changes');
    pass = await tick();
    expect(world.log.sends.at(-1)?.text).toContain('reviews/1-');
    expect(world.log.stops.map((h) => h.sessionId)).toContain(reviewer.handle.sessionId);
    expect(existsSync(reviewer.req.cwd)).toBe(false);
    expect(drainOf('ACME-1').phase).toBe('fixing');

    // Push 2 -> a delta review from the last reviewed SHA.
    const s2 = await workerPushes('ACME-1', 'two', 'fix');
    await tick();
    reviewer = lastReviewer();
    expect(readFileSync(reviewer.req.promptFile, 'utf8')).toContain(`git diff ${s1} ${s2}`);

    // Clean -> the worker is told to open the PR; nothing was created or armed yet.
    expect(world.forge.calls.filter((c) => c.method === 'createPr' || c.method === 'arm')).toEqual(
      []
    );
    await reviewerSays('ACME-1', s2, 'clean');
    await tick();
    expect(world.log.sends.at(-1)?.text).toContain('flow.ts pr ACME-1');
    expect(drainOf('ACME-1').phase).toBe('pr-ready');

    // The worker opens and arms the PR through the gate.
    const bodyFile = path.join(runOf('ACME-1').worktreePath, 'pr-body.md');
    writeFileSync(bodyFile, 'What changes.\n');
    const pr = await flow(
      ['pr', 'ACME-1', '--title', 'Title of ACME-1', '--body-file', bodyFile, '--arm'],
      runOf('ACME-1').worktreePath
    );
    expect(pr.code, pr.stderr).toBe(0);
    await tick();
    expect(drainOf('ACME-1').phase).toBe('watching');

    // Red CI -> ci-red to the worker.
    world.forge.status.failing = [{ name: 'test', url: 'https://ci/1' }];
    await tick();
    expect(world.log.sends.at(-1)?.text).toContain('test');
    expect(drainOf('ACME-1').phase).toBe('fixing-ci');
    world.forge.status.failing = [];

    // A fix push disarms the PR, is reviewed, and is re-armed on clean.
    const s3 = await workerPushes('ACME-1', 'three', 'fix');
    expect(world.forge.calls.at(-1)).toEqual({ method: 'disarm', arg: 7 });
    await tick();
    await reviewerSays('ACME-1', s3, 'clean');
    await tick();
    expect(world.forge.calls.filter((c) => c.method === 'arm')).toHaveLength(2);
    expect(drainOf('ACME-1')).toMatchObject({ phase: 'watching', pr: { armed: true } });

    // Merged -> the worker is told to close; flow done -> its session is stopped.
    world.forge.status.state = 'merged';
    await tick();
    expect(world.log.sends.at(-1)?.text).toContain('flow.ts done ACME-1');
    expect(drainOf('ACME-1').phase).toBe('closing');
    const done = await flow(
      ['done', 'ACME-1', '--summary', 'Shipped.'],
      runOf('ACME-1').worktreePath
    );
    expect(done.code, done.stderr).toBe(0);
    await tick();
    expect(world.log.stops.map((h) => h.sessionId)).toContain(worker.handle.sessionId);

    expect(world.forge.violations).toEqual([]);
    expect(world.log.starts.filter((s) => s.req.role === 'worker')).toHaveLength(1);
  }, 120_000);
});

describe('flow drain: filling slots', () => {
  it('puts two items on two rotation accounts, each with its own worktree', async () => {
    // Purpose: -n spreading reaches the launch: with one session per account,
    // two picks land on two accounts, and each run records its own.
    configure({ maxLivePerAccount: 1 });
    fleet({ a: { role: 'rotation' }, b: { role: 'rotation' } });
    const pass = await flow(['drain', '--tick', '--parallel', '2', '--host', 'cli']);
    expect(pass.code, pass.stderr).toBe(0);
    const accounts = world.log.starts.map((s) => s.req.account?.id);
    expect(new Set(accounts)).toEqual(new Set(['a', 'b']));
    expect(world.log.starts[0].req.account?.path).toBe(
      path.join(dorkHome, 'claude', accounts[0] as string)
    );
    expect(new Set([runOf('ACME-1').account, runOf('ACME-2').account])).toEqual(
      new Set(['a', 'b'])
    );
    expect(runOf('ACME-1').worktreePath).not.toBe(runOf('ACME-2').worktreePath);
  });

  it('launches nothing while the machine is busy', async () => {
    // Purpose: the load cap holds new launches back (running sessions are never stopped).
    load = { load1: 40, cpus: 8 };
    const pass = await flow(['drain', '--tick', '--parallel', '2', '--host', 'cli']);
    expect(pass.code, pass.stderr).toBe(0);
    expect(world.log.starts).toEqual([]);
    expect(project.runs()).toEqual({});
    expect(world.tracker.calls.filter((c) => c.method === 'applyWorkState')).toEqual([]);
  });

  it('releases the claim when the worker does not start', async () => {
    // Purpose: no run record may name a session that never started; the item
    // goes back to the ready queue at its stage.
    world.tracker = createFakeAdapter({ user: { id: 'agent-1' }, items: [item('ACME-1')] });
    world.script.failNext = new LaunchError('unavailable', 'the claude binary is not on PATH');
    const pass = await tick();
    expect(pass.code, pass.stderr).toBe(0);
    expect(project.runs()).toEqual({});
    const after = world.tracker.backlog.items.find((i) => i.identifier === 'ACME-1');
    expect(after?.labels).toContain('agent/ready');
    expect(after?.labels).not.toContain('agent/claimed');
    expect(JSON.stringify(pass.json)).toContain('did not start');
  });

  it('refuses a second drain while one holds the lock, and replaces a dead one', async () => {
    // Purpose: one supervisor per project; a crashed supervisor's lock must not block forever.
    const lock = path.join(project.dir, '.dork', 'flow', 'drain.lock');
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 't', startedAt: 'x' }));
    const refused = await tick();
    expect(refused.code).toBe(EXIT.precondition);
    expect(refused.stderr).toContain(`a drain is already running, pid ${process.pid}`);
    expect(world.log.starts).toEqual([]);

    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, token: 't', startedAt: 'x' }));
    const taken = await tick();
    expect(taken.code, taken.stderr).toBe(0);
    expect(world.log.starts).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  it('--dry-run reports what it would do and writes nothing', async () => {
    // Purpose: a dry run is safe to run against a live project: no claim, no
    // run record, no worktree, no session, no lock.
    const pass = await flow(['drain', '--tick', '--parallel', '2', '--host', 'cli', '--dry-run']);
    expect(pass.code, pass.stderr).toBe(0);
    expect(JSON.stringify(pass.json)).toContain('would claim');
    expect(project.hasRunStore()).toBe(false);
    expect(world.log.starts).toEqual([]);
    expect(world.tracker.calls).toEqual([]);
    expect(existsSync(path.join(dorkHome, 'workspaces'))).toBe(false);
    expect(existsSync(path.join(project.dir, '.dork', 'flow', 'drain.lock'))).toBe(false);
  });

  it('exits 2 with no --parallel and drain.parallel 0', async () => {
    // Purpose: a drain never starts sessions nobody asked for.
    const result = await flow(['drain', '--tick']);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain('set --parallel or drain.parallel');
  });
});

describe('flow drain: adopt before releasing', () => {
  it('adopts a worker a crashed pass started, instead of starting a second one', async () => {
    // Purpose: a pass that dies between start and recording leaves a queued run
    // with a pending intent; the next pass after the start timeout must find
    // and adopt that session, never release it or start another writer.
    world.tracker = createFakeAdapter({ user: { id: 'agent-1' }, items: [item('ACME-1')] });
    world.script.crashNext = true;
    world.options.findSession = async (probe) =>
      world.log.starts.find((s) => s.req.sessionId === probe.sessionId)?.handle ?? null;
    await tick();
    expect(runOf('ACME-1')).toMatchObject({ status: 'queued' });
    expect(drainOf('ACME-1').worker).toMatchObject({ pending: true });

    // Within the start timeout nothing happens: no second worker.
    clock = T0 + 30_000;
    await tick();
    expect(world.log.starts).toHaveLength(1);

    clock = T0 + 5 * 60_000;
    const pass = await tick();
    expect(pass.code, pass.stderr).toBe(0);
    expect(world.log.starts).toHaveLength(1);
    expect(runOf('ACME-1')).toMatchObject({
      status: 'running',
      sessionId: world.log.starts[0].handle.sessionId,
    });
    expect(drainOf('ACME-1').worker?.pending).toBeUndefined();
    expect(JSON.stringify(pass.json)).toContain('adopted the worker session');
  });

  it('releases a queued claim whose session is nowhere, and parks one on DorkOS instead', async () => {
    // Purpose: not found proves the worker never started on this machine, so
    // the claim goes back; on DorkOS session_start may have minted another id,
    // so not found proves nothing and the run parks with instructions.
    world.tracker = createFakeAdapter({ user: { id: 'agent-1' }, items: [item('ACME-1')] });
    world.script.crashNext = true;
    world.options.findSession = async () => null;
    await tick();
    clock = T0 + 5 * 60_000;
    load = { load1: 40, cpus: 8 }; // so the released item is not picked again in the same pass
    const released = await tick();
    expect(JSON.stringify(released.json)).toContain('released to ready');
    expect(project.runs()).toEqual({});
    expect(world.tracker.backlog.items[0].labels).toContain('agent/ready');
    load = { load1: 0.5, cpus: 8 };

    // DorkOS: parks.
    clock = T0;
    world.script.crashNext = true;
    await tick('--host', 'dorkos');
    clock = T0 + 5 * 60_000;
    const pass = await tick('--host', 'dorkos');
    expect(pass.code, pass.stderr).toBe(0);
    expect(drainOf('ACME-1')).toMatchObject({ phase: 'parked' });
    expect(drainOf('ACME-1').parkedReason).toContain('check DorkOS for a session');
    const labels = world.tracker.backlog.items[0].labels;
    expect(labels).toContain('agent/needs-input');
    expect(world.log.starts).toHaveLength(2);
  });
});

describe('flow drain: compare-and-set', () => {
  /** Start ACME-1 and report one push, ready for a reviewer. */
  async function pushedOnce(): Promise<string> {
    world.tracker = createFakeAdapter({ user: { id: 'agent-1' }, items: [item('ACME-1')] });
    await tick();
    return workerPushes('ACME-1', 'one');
  }

  /** Bump drain.rev as another writer would (a report landing). */
  function reportLands(): void {
    const run = runOf('ACME-1');
    const file = path.join(project.dir, '.dork', 'flow', 'flow-state.json');
    const runs = project.runs();
    runs[run.issueId] = {
      ...run,
      drain: { ...(run.drain as DrainState), rev: (run.drain as DrainState).rev + 1 },
    };
    writeFileSync(file, JSON.stringify(runs, null, 2));
  }

  it('drops the decision when a report lands between the gather and the write', async () => {
    // Purpose: the supervisor never overwrites news it did not see; the
    // decision is made again next pass from the new facts.
    await pushedOnce();
    let landed = false;
    world.script.onState = () => {
      if (!landed) {
        landed = true;
        reportLands();
      }
    };
    const dropped = await tick();
    expect(JSON.stringify(dropped.json)).toContain('a report landed during the pass');
    expect(world.log.starts.filter((s) => s.req.role === 'reviewer')).toHaveLength(0);
    expect(drainOf('ACME-1').reviewer).toBeNull();

    await tick();
    expect(world.log.starts.filter((s) => s.req.role === 'reviewer')).toHaveLength(1);
  });

  it('keeps the launched reviewer when a report lands while it starts, and starts no second one', async () => {
    // Purpose: the handle write after a launch needs no unchanged rev; losing
    // it would start a second reviewer next pass.
    await pushedOnce();
    world.script.onStart = (req) => {
      if (req.role === 'reviewer') reportLands();
    };
    await tick();
    const reviewer = lastReviewer();
    expect(drainOf('ACME-1').reviewer).toMatchObject({ sessionId: reviewer.handle.sessionId });
    expect(drainOf('ACME-1').reviewer?.pending).toBeUndefined();

    world.script.onStart = undefined;
    await tick();
    expect(world.log.starts.filter((s) => s.req.role === 'reviewer')).toHaveLength(1);
  });
});

describe('flow drain: the handoff seam', () => {
  it('runs the handoff reducer before drainStep, which acts on its result', async () => {
    // Purpose: the handoff phase plugs in here; drainStep must see the run the
    // handoff reducer returned (here, told to sleep), not the one gathered.
    world.tracker = createFakeAdapter({ user: { id: 'agent-1' }, items: [item('ACME-1')] });
    await tick();
    await workerPushes('ACME-1', 'one');
    const seen: string[] = [];
    world.options.handoffStep = (run, facts) => {
      seen.push(`${run.identifier}:${facts.reports.pushedSha === null ? 'none' : 'pushed'}`);
      return {
        run: {
          ...run,
          drain: { ...(run.drain as DrainState), wakeAfter: '2099-01-01T00:00:00.000Z' },
        },
        actions: [],
      };
    };
    await tick();
    expect(seen).toEqual(['ACME-1:pushed']);
    expect(world.log.starts.filter((s) => s.req.role === 'reviewer')).toHaveLength(0);

    world.options.handoffStep = undefined;
    const run = runOf('ACME-1');
    writeFileSync(
      path.join(project.dir, '.dork', 'flow', 'flow-state.json'),
      JSON.stringify({
        [run.issueId]: { ...run, drain: { ...(run.drain as DrainState), wakeAfter: null } },
      })
    );
    await tick();
    expect(world.log.starts.filter((s) => s.req.role === 'reviewer')).toHaveLength(1);
  });
});

describe('flow drain: usage snapshots', () => {
  it('journals each account at most once per 15 minutes', async () => {
    // Purpose: a drain ticking every minute must not read every ledger and the
    // journal on every pass.
    // Every account the pass ranked is considered; the ambient Claude Code one is enough to watch.
    const state = () => ({
      'claude-code:default': JSON.parse(
        readFileSync(path.join(project.dir, '.dork', 'flow', 'drain-usage.json'), 'utf8')
      )['claude-code:default'],
    });
    await tick();
    expect(state()).toEqual({ 'claude-code:default': new Date(T0).toISOString() });
    clock = T0 + 5 * 60_000;
    await tick();
    expect(state()).toEqual({ 'claude-code:default': new Date(T0).toISOString() });
    clock = T0 + 16 * 60_000;
    await tick();
    expect(state()).toEqual({ 'claude-code:default': new Date(clock).toISOString() });
  });

  it('dueForSnapshot keeps a key for the interval, then lets it through', () => {
    // Purpose: the pure rule the verb relies on, including a clock that went backwards.
    const now = new Date(T0);
    const first = dueForSnapshot({}, ['a', 'a', 'b'], now);
    expect(first.due).toEqual(['a', 'b']);
    expect(dueForSnapshot(first.next, ['a'], new Date(T0 + 60_000)).due).toEqual([]);
    expect(dueForSnapshot(first.next, ['a'], new Date(T0 + 15 * 60_000)).due).toEqual(['a']);
    expect(dueForSnapshot(first.next, ['a'], new Date(T0 - 60_000)).due).toEqual(['a']);
  });
});

describe('the briefs', () => {
  const vars = {
    worker: Object.fromEntries(BRIEF_VARS.worker.map((name) => [name, `<${name}>`])),
    reviewer: Object.fromEntries(BRIEF_VARS.reviewer.map((name) => [name, `<${name}>`])),
  };

  it('render with every placeholder filled and none left over', () => {
    // Purpose: a brief with a hole would send a session off with a literal {{name}}.
    for (const which of ['worker', 'reviewer'] as const) {
      const text = renderBrief(FLOW_ROOT, which, vars[which]);
      expect(text, which).not.toMatch(/\{\{|\}\}/);
      for (const name of BRIEF_VARS[which]) expect(text, `${which} ${name}`).toContain(`<${name}>`);
    }
    const reviewer = renderBrief(FLOW_ROOT, 'reviewer', vars.reviewer);
    expect(reviewer).toMatch(
      /flow report <identifier> verdict --sha <sha> --token <token> --clean/
    );
    const worker = renderBrief(FLOW_ROOT, 'worker', vars.worker);
    for (const verb of ['flow checkpoint', 'flow report', 'flow pr', 'flow stage', 'flow done']) {
      expect(worker, verb).toContain(verb);
    }
    expect(worker).not.toMatch(/gh pr create/);
  });

  it('refuse a missing value, an unused value and a malformed placeholder', () => {
    // Purpose: the renderer must fail loudly rather than ship a hole or drop a fact.
    const { title: _title, ...missing } = vars.worker;
    expect(() => renderBrief(FLOW_ROOT, 'worker', missing)).toThrow(/no value for \{\{title\}\}/);
    expect(() => renderTemplate('a {{x}}', { x: '1', y: '2' })).toThrow(/no placeholder for y/);
    expect(() => renderTemplate('a {{x-y}}', {})).toThrow(/malformed placeholder/);
    expect(renderTemplate('{{x}}', { x: '{{y}}' })).toBe('{{y}}');
  });
});
