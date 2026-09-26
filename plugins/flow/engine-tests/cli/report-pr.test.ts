/**
 * `flow report` and `flow pr` (spec `flow-handoff-dispatch` §4.5, §4.6, task
 * 3.2): driven through `main` with the shipped verb table against a real temp
 * git project with a bare `origin`, a fake forge that records every call, and
 * the fake tracker. Only `git remote get-url origin` is answered by the test
 * (a GitHub address), so the forge resolves while every other git call is real.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { main } from '../../scripts/flow.ts';
import type { CreatePrInput, Forge, ForgePr, ForgeTarget } from '../../scripts/forge/types.ts';
import { createFakeAdapter, type FakeTracker } from '../fixtures/cli/fake-adapter/adapter.ts';
import { item, makeProject, type WriteProject } from './write-harness.ts';

const TOKEN = '0123456789abcdef0123456789abcdef';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

let project: WriteProject;
let origin: string;

/** Run git in the project with a fixed identity. */
function git(...args: string[]): string {
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
    { cwd: project.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

/** Commit an empty change and return the new HEAD. */
function commit(message: string): string {
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** A fake forge recording its calls. */
function fakeForge(opts: { existing?: ForgePr | null; armed?: boolean } = {}) {
  const calls: { method: string; arg?: unknown }[] = [];
  const targets: ForgeTarget[] = [];
  const forge: Forge = {
    repo: 'acme/app',
    async branchHead() {
      return null;
    },
    async prForBranch(branch) {
      calls.push({ method: 'prForBranch', arg: branch });
      return opts.existing ?? null;
    },
    async createPr(input: CreatePrInput) {
      calls.push({ method: 'createPr', arg: input });
      return { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: null };
    },
    async prStatus(pr) {
      calls.push({ method: 'prStatus', arg: pr });
      return {
        state: 'open',
        failing: [],
        armed: opts.armed ?? false,
        queued: false,
        headSha: 'x',
        base: 'main',
      };
    },
    async arm(pr, sha) {
      calls.push({ method: 'arm', arg: [pr, sha] });
    },
    async disarm(pr) {
      calls.push({ method: 'disarm', arg: pr });
    },
    async recentGroupFailures() {
      return [];
    },
  };
  return { forge, calls, targets, factory: (t: ForgeTarget) => (targets.push(t), forge) };
}

/** Real git, except `remote get-url origin` answers a GitHub address. */
const runner: ProcessRunner = async (cmd, args, opts) => {
  if (cmd === 'git' && args.join(' ') === 'remote get-url origin') {
    return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' };
  }
  return realProcessRunner(cmd, args, opts);
};

/** Run `flow <argv> --json` in the project. */
async function flow(
  argv: string[],
  forge = fakeForge(),
  tracker: FakeTracker = createFakeAdapter({ items: [claimedItem()] })
) {
  let out = '';
  let err = '';
  const code = await main([...argv, '--json'], {
    env: { FLOW_SESSION_ID: 'session-abcdef123456', CLAUDECODE: '1' },
    cwd: project.dir,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    createAdapter: async () => tracker.adapter,
    runProcess: runner,
    createForge: forge.factory,
  });
  return { code, json: JSON.parse(out) as Record<string, unknown>, stderr: err, forge, tracker };
}

function claimedItem() {
  return item('ACME-12', {
    stateCategory: 'started',
    stateName: 'In Progress',
    labels: ['type/task', 'agent/claimed'],
    agentDisposition: 'claimed',
  });
}

function drain(overrides: Partial<DrainState> = {}): DrainState {
  return {
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
    ...overrides,
  };
}

function reviewer(sha: string) {
  return {
    host: 'cli' as const,
    sessionId: 'rev-1',
    account: null,
    cwd: '/tmp/review',
    sha,
    worktree: '/tmp/review',
    tokenHash: TOKEN_HASH,
  };
}

/** Write the ACME-12 run with this drain and checkpoint. */
function writeRun(d: DrainState, checkpointSha?: string): void {
  const run: FlowRun = {
    issueId: 'id-ACME-12',
    identifier: 'ACME-12',
    sessionId: 'session-abcdef123456',
    worktreePath: project.dir,
    branch: 'work',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: -1,
    startedAt: '2026-09-26T10:00:00.000Z',
    host: 'cli',
    ...(checkpointSha ? { checkpointSha, checkpointAt: '2026-09-26T11:00:00.000Z' } : {}),
    drain: d,
  };
  project.writeRuns({ 'id-ACME-12': run });
}

function stored(): DrainState {
  return project.runs()['id-ACME-12'].drain as DrainState;
}

beforeEach(() => {
  project = makeProject();
  origin = `${project.dir}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'work', origin]);
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'work');
  git('fetch', '-q', 'origin');
  git('remote', 'set-head', 'origin', 'work');
});

afterEach(() => {
  project.cleanup();
  execFileSync('rm', ['-rf', origin]);
});

describe('flow report pushed', () => {
  // A commit that is not on origin is refused: the reviewer would review nothing.
  it('refuses an unpushed SHA', async () => {
    const sha = commit('local only');
    writeRun(drain(), sha);
    const r = await flow(['report', 'ACME-12', 'pushed']);
    expect(r.code).toBe(EXIT.precondition);
    expect(r.stderr).toContain('push first');
    expect(stored()).toMatchObject({ pushedSha: null, rev: 3 });
  });

  // A pushed commit with no checkpoint at it is refused, naming both checkpoint triggers.
  it('refuses a SHA without a checkpoint', async () => {
    const old = git('rev-parse', 'HEAD');
    commit('pushed');
    git('push', '-q', 'origin', 'work');
    writeRun(drain(), old);
    const r = await flow(['report', 'ACME-12', 'pushed']);
    expect(r.code).toBe(EXIT.precondition);
    expect(r.stderr).toContain('--trigger task');
    expect(r.stderr).toContain('--trigger fix');
    expect(stored().rev).toBe(3);
  });

  // A pushed, checkpointed commit is recorded and rev bumps by one.
  it('records the push and bumps rev', async () => {
    const sha = commit('pushed');
    git('push', '-q', 'origin', 'work');
    writeRun(drain(), sha);
    const r = await flow(['report', 'ACME-12', 'pushed']);
    expect(r.code).toBe(0);
    expect(stored()).toMatchObject({ pushedSha: sha, rev: 4 });
    expect(r.forge.calls).toEqual([]);
  });

  // A push onto an armed PR disarms it, so unreviewed commits cannot merge.
  it('disarms an armed PR', async () => {
    const sha = commit('fix');
    git('push', '-q', 'origin', 'work');
    const pr = { repo: 'acme/app', number: 7, url: 'u', armed: true, disarmedForReview: false };
    writeRun(drain({ phase: 'watching', pr }), sha);
    const r = await flow(['report', 'ACME-12', 'pushed']);
    expect(r.code).toBe(0);
    expect(r.forge.calls).toEqual([{ method: 'disarm', arg: 7 }]);
    expect(r.forge.targets).toEqual([{ host: 'github.com', repo: 'acme/app' }]);
    expect(stored().pr).toMatchObject({ armed: false, disarmedForReview: true });
    expect(stored().rev).toBe(4);
  });
});

describe('flow report verdict', () => {
  let sha: string;
  beforeEach(() => {
    sha = commit('reviewed');
    git('push', '-q', 'origin', 'work');
  });

  // Without the token, or with the wrong one, no verdict is recorded (exit 5).
  it('refuses a missing or wrong token', async () => {
    writeRun(drain({ phase: 'reviewing', pushedSha: sha, reviewer: reviewer(sha) }), sha);
    for (const token of [[], ['--token', 'not-the-token']]) {
      const r = await flow(['report', 'ACME-12', 'verdict', '--sha', sha, ...token, '--clean']);
      expect(r.code).toBe(EXIT.precondition);
    }
    expect(stored()).toMatchObject({ verdict: null, rev: 3 });
  });

  // No reviewer slot means no token can match.
  it('refuses when no review is running', async () => {
    writeRun(drain({ phase: 'reviewing', pushedSha: sha }), sha);
    const r = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      sha,
      '--token',
      TOKEN,
      '--clean',
    ]);
    expect(r.code).toBe(EXIT.precondition);
  });

  // A verdict on an older push is stale: warned, exit 0, nothing written.
  it('ignores a stale verdict', async () => {
    const older = git('rev-parse', 'HEAD~1');
    writeRun(drain({ phase: 'reviewing', pushedSha: sha, reviewer: reviewer(older) }), sha);
    const before = readFileSync(path.join(project.dir, '.dork/flow/flow-state.json'), 'utf8');
    const r = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      older,
      '--token',
      TOKEN,
      '--clean',
    ]);
    expect(r.code).toBe(0);
    expect(r.json.stale).toBe(true);
    expect(r.stderr).toContain('stale');
    expect(readFileSync(path.join(project.dir, '.dork/flow/flow-state.json'), 'utf8')).toBe(before);
  });

  // A clean verdict records verdict, reviewedSha, the next round, and bumps rev.
  it('records a clean verdict', async () => {
    writeRun(drain({ phase: 'reviewing', pushedSha: sha, reviewer: reviewer(sha) }), sha);
    const r = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      sha,
      '--token',
      TOKEN,
      '--clean',
    ]);
    expect(r.code).toBe(0);
    expect(stored()).toMatchObject({ verdict: 'clean', reviewedSha: sha, reviewRound: 1, rev: 4 });
  });

  // --changes copies the findings into the worker's worktree under the round and short SHA.
  it('copies findings for --changes', async () => {
    writeRun(
      drain({ phase: 'reviewing', pushedSha: sha, reviewer: reviewer(sha), reviewRound: 1 }),
      sha
    );
    const findings = path.join(project.dir, 'findings.md');
    writeFileSync(findings, '1. Handle the empty case.\n');
    const r = await flow([
      'report',
      'ACME-12',
      'verdict',
      '--sha',
      sha,
      '--token',
      TOKEN,
      '--changes',
      '--findings-file',
      findings,
    ]);
    expect(r.code).toBe(0);
    const copy = path.join(project.dir, `.dork/flow/drain/reviews/2-${sha.slice(0, 7)}.md`);
    expect(readFileSync(copy, 'utf8')).toBe('1. Handle the empty case.\n');
    expect(stored()).toMatchObject({ verdict: 'changes', reviewRound: 2, rev: 4 });
  });
});

describe('flow report blocked', () => {
  // The question goes to the tracker as a signed comment with the needs-input label, and the run parks.
  it('posts, labels and parks', async () => {
    writeRun(drain());
    writeFileSync(path.join(project.dir, 'q.md'), 'Which export format?\n\nCSV or TSV.\n');
    const r = await flow(['report', 'ACME-12', 'blocked', '--question-file', 'q.md']);
    expect(r.code).toBe(0);
    expect(r.tracker.calls.map((c) => c.method)).toEqual(['comment', 'applyWorkState']);
    const [comment, write] = r.tracker.calls as unknown as [{ body: string }, { change: object }];
    expect(comment.body).toMatch(/^Which export format\?[\s\S]*<!-- agent:provenance \{.*\} -->$/);
    expect(write.change).toEqual({ agentLabel: 'agent/needs-input' });
    expect(stored()).toMatchObject({
      phase: 'parked',
      parkedReason: 'the worker asked a question: Which export format?',
      rev: 4,
    });
  });
});

describe('flow pr', () => {
  let head: string;
  beforeEach(() => {
    head = commit('work');
    git('push', '-q', 'origin', 'work');
    writeFileSync(path.join(project.dir, 'body.md'), 'Adds CSV export.\n');
  });
  const args = ['pr', 'ACME-12', '--title', 'Export CSV', '--body-file', 'body.md'];

  // No verdict, or a CHANGES verdict, opens nothing.
  it('refuses without a clean verdict', async () => {
    for (const verdict of [null, 'changes'] as const) {
      writeRun(drain({ pushedSha: head, reviewedSha: head, verdict }), head);
      const r = await flow(args);
      expect(r.code).toBe(EXIT.precondition);
      expect(r.stderr).toContain('no CLEAN review');
      expect(r.forge.calls).toEqual([]);
    }
  });

  // A clean verdict on a commit that is no longer origin's head opens nothing.
  it('refuses when the head moved after the verdict', async () => {
    writeRun(drain({ pushedSha: head, reviewedSha: head, verdict: 'clean' }), head);
    commit('after review');
    git('push', '-q', 'origin', 'work');
    const r = await flow(args);
    expect(r.code).toBe(EXIT.precondition);
    expect(r.forge.calls).toEqual([]);
    expect(stored().pr).toBeNull();
  });

  // A clean verdict at the head opens the PR into origin's default branch, signed, and records it.
  it('opens and records the PR', async () => {
    writeRun(
      drain({ phase: 'pr-ready', pushedSha: head, reviewedSha: head, verdict: 'clean' }),
      head
    );
    const r = await flow(args);
    expect(r.code).toBe(0);
    const create = r.forge.calls.find((c) => c.method === 'createPr')?.arg as CreatePrInput;
    expect(create).toMatchObject({ head: 'work', base: 'work', title: 'Export CSV' });
    expect(create.body).toMatch(
      /^Adds CSV export\.\n\n<!-- agent:provenance .*"sessionId":"session-"/
    );
    expect(create.body).not.toContain('"host"');
    expect(r.forge.calls.some((c) => c.method === 'arm')).toBe(false);
    expect(stored().pr).toEqual({
      repo: 'acme/app',
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      armed: false,
      disarmedForReview: false,
    });
    expect(stored().rev).toBe(4);
  });

  // --arm arms the new PR and records it armed.
  it('arms with --arm', async () => {
    writeRun(drain({ pushedSha: head, reviewedSha: head, verdict: 'clean' }), head);
    const r = await flow([...args, '--arm']);
    expect(r.code).toBe(0);
    // Tied to the reviewed commit, the head it checked.
    expect(r.forge.calls.filter((c) => c.method === 'arm')).toEqual([
      { method: 'arm', arg: [7, head] },
    ]);
    expect(stored().pr?.armed).toBe(true);
  });

  // A PR already open for the branch is recorded, not duplicated, and the verb exits 5 naming it.
  it('records an existing PR on a retry', async () => {
    writeRun(drain({ pushedSha: head, reviewedSha: head, verdict: 'clean' }), head);
    const forge = fakeForge({
      existing: { number: 9, url: 'https://github.com/acme/app/pull/9', headSha: head },
      armed: true,
    });
    const r = await flow(args, forge);
    expect(r.code).toBe(EXIT.precondition);
    expect(r.stderr).toContain('https://github.com/acme/app/pull/9');
    expect(forge.calls.some((c) => c.method === 'createPr')).toBe(false);
    expect(stored().pr).toMatchObject({ number: 9, armed: true });
    expect(stored().rev).toBe(4);
  });
});

describe('both verbs leave other drains alone', () => {
  // A drain written by a newer flow is refused, never rewritten.
  it('refuses a newer drain', async () => {
    const sha = commit('x');
    git('push', '-q', 'origin', 'work');
    writeRun({ v: 2 } as unknown as DrainState, sha);
    const r = await flow(['report', 'ACME-12', 'pushed']);
    expect(r.code).toBe(EXIT.precondition);
    expect(r.stderr).toContain('newer flow');
    expect(existsSync(path.join(project.dir, '.dork/flow/flow-state.json'))).toBe(true);
    expect(project.runs()['id-ACME-12'].drain).toEqual({ v: 2 });
  });
});
