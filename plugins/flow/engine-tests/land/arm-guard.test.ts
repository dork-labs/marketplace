/**
 * The arm guard end to end (DOR-3262): the `land` config read from
 * `origin/main` and never from the PR, the `land.preArm` entries in both forms,
 * and the guard's promise to only refuse. A real temp repository with a bare
 * `origin` stands behind every git call; the forge is a fake that records what
 * it was asked, and `run` entries go to a recording runner rather than a real
 * program.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';
import type { ArmFacts, Forge, WorkflowRun } from '../../scripts/forge/types.ts';
import { guardArm, refusalSticksToCommit } from '../../scripts/land/arm-guard.ts';
import { readBaseLand } from '../../scripts/land/base-config.ts';
import { setFreeze } from '../../scripts/land/freeze.ts';
import {
  entryTouched,
  runWorkflow,
  splitCommand,
  WORKFLOW_POLL_MS,
} from '../../scripts/land/pre-arm.ts';
import { FIXED_PATH } from '../../scripts/land/isolated-git.ts';
import { isBranchName, isFullSha, isNonce, isWorkflowName } from '../../scripts/land/validate.ts';

// Each case builds real repositories and verified scratch copies with git; on
// a loaded machine that outlasts vitest's 5-second default.
vi.setConfig({ testTimeout: 60_000 });

const NONCE = '0123456789abcdef0123456789abcdef';

let root: string;
let repo: string;
let origin: string;
let head: string;

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

/** Write a file in the repo and commit it on the current branch. */
function commitFile(file: string, text: string, message = file): string {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Commit `land` as main's committed flow config and push main. */
function baseLand(land: unknown): void {
  git(repo, 'checkout', '-q', 'main');
  commitFile('.agents/flow/config.json', JSON.stringify({ land }, null, 2), 'main config');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', 'feature');
  git(repo, 'rebase', '-q', 'main');
  head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', '-f', 'origin', 'feature');
}

interface ForgeOptions {
  facts?: Partial<ArmFacts>;
  runs?: (call: number) => WorkflowRun[];
  branchHead?: (call: number) => string | null;
  required?: string[] | null;
}

/** A fake forge recording every call. */
function fakeForge(opts: ForgeOptions = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let runsCall = 0;
  let headCall = 0;
  const forge: Forge = {
    repo: 'acme/app',
    async branchHead(...args) {
      calls.push({ method: 'branchHead', args });
      headCall += 1;
      return opts.branchHead ? opts.branchHead(headCall) : head;
    },
    async prForBranch() {
      return null;
    },
    async createPr() {
      throw new Error('not here');
    },
    async prStatus() {
      throw new Error('not here');
    },
    async arm(...args) {
      calls.push({ method: 'arm', args });
    },
    async disarm(...args) {
      calls.push({ method: 'disarm', args });
    },
    async review(...args) {
      calls.push({ method: 'review', args });
      return 'reviewed';
    },
    async recentGroupFailures() {
      return [];
    },
    async requiredChecks() {
      return opts.required === undefined ? ['flow plugin'] : opts.required;
    },
    async armFacts(...args) {
      calls.push({ method: 'armFacts', args });
      return {
        state: 'OPEN',
        isDraft: false,
        labels: [],
        reviewDecision: 'APPROVED',
        checks: [{ name: 'flow plugin', bucket: 'pass' }],
        headRefOid: head,
        headRefName: 'feature',
        baseRefName: 'main',
        isCrossRepository: false,
        files: ['src/app.ts'],
        ...opts.facts,
      };
    },
    async comment(...args) {
      calls.push({ method: 'comment', args });
    },
    async dispatchWorkflow(...args) {
      calls.push({ method: 'dispatchWorkflow', args });
    },
    async workflowRuns(...args) {
      calls.push({ method: 'workflowRuns', args });
      runsCall += 1;
      return opts.runs ? opts.runs(runsCall) : [];
    },
  };
  return { forge, calls };
}

/** Real git; every other program is recorded and answered by `answer`. */
function recordingRunner(
  answer: (
    cmd: string,
    args: readonly string[],
    cwd: string | undefined
  ) => { code: number; stdout?: string; stderr?: string } | 'throw' = () => ({ code: 0 })
) {
  const ran: {
    cmd: string;
    args: readonly string[];
    cwd?: string;
    env?: Readonly<Record<string, string | undefined>>;
  }[] = [];
  const runner: ProcessRunner = async (cmd, args, opts) => {
    if (cmd === 'git') return realProcessRunner(cmd, args, opts);
    ran.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
    const result = answer(cmd, args, opts?.cwd);
    if (result === 'throw') throw new Error('timed out');
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { runner, ran };
}

/** A clock that only moves when the guard sleeps. */
function virtualTime() {
  let t = Date.parse('2026-10-24T12:00:00.000Z');
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    title: `preArm ${NONCE}`,
    headSha: head,
    completed: true,
    conclusion: 'success',
    url: 'https://github.com/acme/app/actions/runs/1',
    ...overrides,
  };
}

async function guard(
  forge: Forge,
  runner: ProcessRunner = recordingRunner().runner,
  reviewedSha: string | null = head
) {
  const time = virtualTime();
  return guardArm(
    { forge, pr: 7, reviewedSha, worktree: repo, mainCheckout: repo },
    { runProcess: runner, now: time.now, sleep: time.sleep, nonce: () => NONCE }
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-arm-guard-')));
  repo = path.join(root, 'repo');
  origin = path.join(root, 'origin.git');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  commitFile('README.md', 'hi\n');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature');
  head = commitFile('src/app.ts', 'export {};\n');
  git(repo, 'push', '-q', 'origin', 'feature');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the land config the guard obeys', () => {
  it("is read from origin/main: a PR that edits preArm still runs main's entry", async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check-main --strict' }] });
    commitFile(
      '.agents/flow/config.json',
      JSON.stringify({ land: { preArm: [{ paths: ['src/**'], run: 'check-pr' }] } }),
      'PR edits preArm'
    );
    head = git(repo, 'rev-parse', 'HEAD');
    const { runner, ran } = recordingRunner();
    const { forge } = fakeForge({
      facts: {
        files: ['src/app.ts', '.agents/flow/config.json'],
        labels: [{ name: 'security-reviewed' }],
      },
    });
    const result = await guard(forge, runner);
    expect(result.ok).toBe(true);
    expect(ran.map((r) => [r.cmd, ...r.args])).toEqual([['check-main', '--strict']]);
    // In a fresh checkout of the reviewed head, never the worker's worktree.
    expect(ran[0].cwd).not.toBe(repo);
  });

  it('is read from the remote, not a stale local main', async () => {
    // Another clone moves origin/main past this checkout's local ref.
    const other = path.join(root, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    mkdirSync(path.join(other, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(other, '.agents', 'flow', 'config.json'),
      JSON.stringify({ land: { preArm: [{ paths: ['src/**'], run: 'remote-check' }] } })
    );
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'config on the remote');
    git(other, 'push', '-q', 'origin', 'main');
    const base = await readBaseLand(realProcessRunner, repo);
    expect(base.ok && base.land.preArm).toEqual([
      { paths: ['src/**'], run: 'remote-check', timeout: 30 },
    ]);
  });

  it('ignores config.local.json and the working tree', async () => {
    mkdirSync(path.join(repo, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(repo, '.agents', 'flow', 'config.local.json'),
      JSON.stringify({ land: { preArm: [{ paths: ['**'], run: 'local-check' }] } })
    );
    const { runner, ran } = recordingRunner();
    expect((await guard(fakeForge().forge, runner)).ok).toBe(true);
    expect(ran).toEqual([]);
  });

  it('a main with no committed config means no checks', async () => {
    const base = await readBaseLand(realProcessRunner, repo);
    expect(base).toMatchObject({ ok: true, committed: false, land: { preArm: [] } });
  });

  it('an invalid land block on main refuses, naming the field', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'a && b' }] });
    const result = await guard(fakeForge().forge);
    expect(result).toMatchObject({ ok: false, reason: 'config-unreadable' });
    expect(!result.ok && result.detail).toMatch(/land\.preArm\.0/);
  });

  it('a config on main that is not JSON refuses', async () => {
    git(repo, 'checkout', '-q', 'main');
    commitFile('.agents/flow/config.json', '{ nope');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', 'feature');
    expect(await guard(fakeForge().forge)).toMatchObject({
      ok: false,
      reason: 'config-unreadable',
    });
  });

  it('a security list on main is the one the guard uses', async () => {
    baseLand({ securityPaths: { globs: ['src/**'] } });
    expect(await guard(fakeForge().forge)).toMatchObject({
      ok: false,
      reason: 'security-path-unlabelled',
    });
    baseLand({ securityPaths: { globs: ['src/**'], label: 'sec-ok' } });
    const labelled = fakeForge({ facts: { labels: [{ name: 'sec-ok' }] } });
    expect((await guard(labelled.forge)).ok).toBe(true);
  });
});

describe('the guard only refuses', () => {
  it('never arms, comments, labels or reviews, whatever it answers', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], wait: 'workflow', workflow: 'shards.yml' }] });
    const passing = fakeForge({
      runs: () => [run()],
      facts: { labels: [{ name: 'security-reviewed' }] },
    });
    expect((await guard(passing.forge)).ok).toBe(true);
    const refusing = fakeForge({ facts: { isCrossRepository: true } });
    expect((await guard(refusing.forge)).ok).toBe(false);
    for (const { calls } of [passing, refusing]) {
      expect(
        calls
          .map((c) => c.method)
          .filter(
            (m) => !['armFacts', 'branchHead', 'dispatchWorkflow', 'workflowRuns'].includes(m)
          )
      ).toEqual([]);
    }
  });

  it('refuses during a release freeze', async () => {
    setFreeze(repo, 'cutting 1.2', new Date());
    const result = await guard(fakeForge().forge);
    expect(result).toMatchObject({ ok: false, reason: 'freeze' });
    expect(!result.ok && result.detail).toContain('cutting 1.2');
  });

  it('refuses when the head moved after the review', async () => {
    const old = head;
    head = commitFile('src/later.ts', 'x\n');
    expect(await guard(fakeForge().forge, undefined, old)).toMatchObject({
      ok: false,
      reason: 'head-moved',
    });
  });

  it('refuses with no reviewed commit', async () => {
    expect(await guard(fakeForge().forge, undefined, null)).toMatchObject({
      ok: false,
      reason: 'unreviewed',
    });
  });

  it('takes the checks main requires from the forge, and counts every check when it cannot say', async () => {
    const red = { checks: [{ name: 'optional', bucket: 'fail' }] };
    expect((await guard(fakeForge({ facts: red, required: ['flow plugin'] }).forge)).ok).toBe(true);
    expect(await guard(fakeForge({ facts: red, required: null }).forge)).toMatchObject({
      ok: false,
      reason: 'failing-checks',
    });
  });

  it('a forge that cannot be read refuses', async () => {
    const { forge } = fakeForge();
    forge.armFacts = async () => {
      throw new Error('HTTP 502');
    };
    expect(await guard(forge)).toMatchObject({ ok: false, reason: 'forge-unreadable' });
  });

  it('decides again after its pre-arm checks: a freeze set meanwhile still refuses', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'slow-suite' }] });
    const { runner, ran } = recordingRunner(() => {
      setFreeze(repo, 'release started mid-check', new Date());
      return { code: 0 };
    });
    const result = await guard(fakeForge().forge, runner);
    expect(ran).toHaveLength(1);
    // About the PR's state, not the checks: asked again once the freeze lifts.
    expect(result).toMatchObject({ ok: false, reason: 'freeze', ranPreArm: false });
    expect(!result.ok && result.detail).toMatch(/after its pre-arm checks passed/);
    expect(!result.ok && refusalSticksToCommit(result)).toBe(false);
  });

  it('decides again after its pre-arm checks: a hold label added meanwhile still refuses', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'slow-suite' }] });
    let held = false;
    const { forge } = fakeForge();
    const plain = forge.armFacts.bind(forge);
    forge.armFacts = async (pr) => ({
      ...(await plain(pr)),
      labels: held ? [{ name: 'hold' }] : [],
    });
    const { runner } = recordingRunner(() => {
      held = true;
      return { code: 0 };
    });
    expect(await guard(forge, runner)).toMatchObject({ ok: false, reason: 'held-by-label' });
  });
});

describe('preArm: defer (flow pr, flow review)', () => {
  async function deferred(forge: Forge, runner: ProcessRunner = recordingRunner().runner) {
    const time = virtualTime();
    return guardArm(
      { forge, pr: 7, reviewedSha: head, worktree: repo, mainCheckout: repo, preArm: 'defer' },
      { runProcess: runner, now: time.now, sleep: time.sleep, nonce: () => NONCE }
    );
  }

  it('leaves a touched entry to the drain, running nothing', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], wait: 'workflow', workflow: 'shards.yml' }] });
    const { runner, ran } = recordingRunner();
    const { forge, calls } = fakeForge();
    const result = await deferred(forge, runner);
    expect(result).toMatchObject({ ok: false, reason: 'pre-arm-deferred', ranPreArm: false });
    expect(!result.ok && result.detail).toMatch(/workflow shards\.yml.*only in the drain/);
    expect(ran).toEqual([]);
    expect(calls.some((c) => c.method === 'dispatchWorkflow')).toBe(false);
  });

  it('arms at once when no entry applies', async () => {
    baseLand({ preArm: [{ paths: ['apps/client/**'], run: 'browser-tests' }] });
    expect(await deferred(fakeForge().forge)).toMatchObject({ ok: true });
  });

  it('still refuses on the PR itself first', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'browser-tests' }] });
    expect(await deferred(fakeForge({ facts: { isCrossRepository: true } }).forge)).toMatchObject({
      ok: false,
      reason: 'fork',
    });
  });
});

describe('which refusals stick to the commit', () => {
  it.each([
    ['pre-arm-failed', true, true],
    ['fork', false, true],
    ['base-not-main', false, true],
    ['freeze', false, false],
    ['security-path-unlabelled', false, false],
    ['failing-checks', false, false],
    ['pre-arm-deferred', false, false],
  ] as const)('%s sticks: %s', (reason, ranPreArm, sticks) => {
    expect(refusalSticksToCommit({ ok: false, reason, detail: '', ranPreArm, preArm: [] })).toBe(
      sticks
    );
  });
});

describe('land.preArm run entries', () => {
  it('no entries: nothing runs and it arms as before', async () => {
    const { runner, ran } = recordingRunner();
    expect(await guard(fakeForge().forge, runner)).toEqual({ ok: true, preArm: [] });
    expect(ran).toEqual([]);
  });

  // S3b: a case-insensitive disk (APFS) opens SRC/App.ts as src/app.ts, so a
  // preArm entry's paths match in any case, Unicode-folded.
  it.each([['SRC/app.ts'], ['Src/App.ts'], ['src/app.ts']])(
    'a preArm entry matches %s whatever its case',
    (file) => {
      expect(entryTouched({ paths: ['src/**'], run: 'check', timeout: 30 }, [file])).toBe(true);
    }
  );

  it('a preArm entry matches a Kelvin-sign spelling of its path', () => {
    expect(
      entryTouched({ paths: ['pkg/**'], run: 'check', timeout: 30 }, ['p\u212Ag/index.ts'])
    ).toBe(true);
  });

  it('a preArm entry matches ß and ẞ as ss, the way APFS does', () => {
    for (const file of ['app/styles.c\u00DF', 'app/styles.C\u1E9E']) {
      expect(entryTouched({ paths: ['**/*.css'], run: 'check', timeout: 30 }, [file]), file).toBe(
        true
      );
    }
  });

  it('folding never narrows a match: a fullwidth slash stays part of the name', () => {
    expect(entryTouched({ paths: ['src/*'], run: 'check', timeout: 30 }, ['src/a\uFF0Fb.ts'])).toBe(
      true
    );
    expect(
      entryTouched({ paths: ['docs/*.md'], run: 'check', timeout: 30 }, ['docs/x\uFF0Fy.md'])
    ).toBe(true);
  });

  it('a case variant of a touched path runs the entry', async () => {
    baseLand({ preArm: [{ paths: ['SRC/**'], run: 'check' }] });
    const { runner, ran } = recordingRunner();
    expect((await guard(fakeForge().forge, runner)).ok).toBe(true);
    expect(ran.map((r) => r.cmd)).toEqual(['check']);
  });

  it('an entry whose paths the PR does not touch is skipped', async () => {
    baseLand({ preArm: [{ paths: ['apps/client/**'], run: 'browser-tests' }] });
    const { runner, ran } = recordingRunner();
    const result = await guard(fakeForge().forge, runner);
    expect(result).toEqual({
      ok: true,
      preArm: [{ entry: 'run "browser-tests"', result: 'skipped' }],
    });
    expect(ran).toEqual([]);
  });

  it('an unreadable file list sends every entry', async () => {
    baseLand({ preArm: [{ paths: ['apps/client/**'], run: 'browser-tests' }] });
    const { runner, ran } = recordingRunner();
    const { forge } = fakeForge({
      facts: { files: null, labels: [{ name: 'security-reviewed' }] },
    });
    // An unknown file list may hold a lockfile, so the queue is read too.
    forge.dependencyQueue = async () => [];
    expect((await guard(forge, runner)).ok).toBe(true);
    expect(ran).toHaveLength(1);
  });

  // One dependency PR at a time (follow-up to DOR-3262).
  it('refuses a lockfile PR while another is queued, and arms it once the queue is clear', async () => {
    const files = ['pnpm-lock.yaml'];
    const busy = fakeForge({ facts: { files, labels: [{ name: 'security-reviewed' }] } });
    busy.forge.dependencyQueue = async () => [
      { number: 5, queued: true, armed: false, files: ['package-lock.json'] },
    ];
    expect(await guard(busy.forge)).toMatchObject({
      ok: false,
      reason: 'dependency-queue-busy',
      detail: 'another dependency PR is in the queue: #5; arm this after it lands',
      ranPreArm: false,
    });
    const clear = fakeForge({ facts: { files, labels: [{ name: 'security-reviewed' }] } });
    clear.forge.dependencyQueue = async () => [];
    expect((await guard(clear.forge)).ok).toBe(true);
  });

  it('a forge that cannot read the queue refuses a lockfile PR (fails closed)', async () => {
    const { forge } = fakeForge({
      facts: { files: ['yarn.lock'], labels: [{ name: 'security-reviewed' }] },
    });
    expect(await guard(forge)).toMatchObject({ ok: false, reason: 'dependency-queue-unreadable' });
    forge.dependencyQueue = async () => {
      throw new Error('HTTP 502');
    };
    expect(await guard(forge)).toMatchObject({ ok: false, reason: 'dependency-queue-unreadable' });
  });

  it('checks the queue again after the pre-arm checks: a dependency PR armed meanwhile still refuses', async () => {
    baseLand({ preArm: [{ paths: ['**'], run: 'slow-suite' }] });
    let armedMeanwhile = false;
    const { forge } = fakeForge({
      facts: { files: ['pnpm-lock.yaml'], labels: [{ name: 'security-reviewed' }] },
    });
    forge.dependencyQueue = async () =>
      armedMeanwhile ? [{ number: 5, queued: false, armed: true, files: ['yarn.lock'] }] : [];
    const { runner } = recordingRunner(() => {
      armedMeanwhile = true;
      return { code: 0 };
    });
    expect(await guard(forge, runner)).toMatchObject({
      ok: false,
      reason: 'dependency-queue-busy',
      ranPreArm: false,
    });
  });

  it('a code PR never reads the queue', async () => {
    const { forge } = fakeForge();
    let asked = false;
    forge.dependencyQueue = async () => {
      asked = true;
      return null;
    };
    expect((await guard(forge)).ok).toBe(true);
    expect(asked).toBe(false);
  });

  it('a failing command refuses, with its output', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'npm run "test browser"' }] });
    const { runner, ran } = recordingRunner(() => ({
      code: 1,
      stdout: 'ran 3',
      stderr: '1 test failed: login',
    }));
    const result = await guard(fakeForge().forge, runner);
    expect(ran.map((r) => [r.cmd, ...r.args])).toEqual([['npm', 'run', 'test browser']]);
    expect(result).toMatchObject({ ok: false, reason: 'pre-arm-failed', ranPreArm: true });
    expect(!result.ok && result.detail).toContain('1 test failed: login');
  });

  it('a command that times out refuses', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'slow', timeout: 1 }] });
    const { runner } = recordingRunner(() => 'throw');
    const result = await guard(fakeForge().forge, runner);
    expect(result).toMatchObject({ ok: false, reason: 'pre-arm-failed' });
    expect(!result.ok && result.detail).toMatch(/within 1 minutes/);
  });

  // Security (DOR-3262): a run entry runs in a fresh, clean checkout of the
  // reviewed head, never in the worker's worktree, with a minimal environment,
  // and the checkout is removed afterwards.
  it("runs in a fresh checkout of the reviewed head: untracked, ignored and changed files in the worker's worktree cannot reach it", async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(path.join(repo, 'ignored.txt'), 'a steered worker wrote this\n');
    writeFileSync(path.join(repo, 'untracked.txt'), 'and this\n');
    writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const tampered = true;\n');
    let seen: Record<string, unknown> = {};
    const { runner, ran } = recordingRunner((_cmd, _args, cwd) => {
      const dir = cwd as string;
      seen = {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
        app: readFileSync(path.join(dir, 'src', 'app.ts'), 'utf8'),
        ignored: existsSync(path.join(dir, 'ignored.txt')),
        untracked: existsSync(path.join(dir, 'untracked.txt')),
        gitignore: existsSync(path.join(dir, '.gitignore')),
      };
      return { code: 0 };
    });
    const result = await guard(fakeForge().forge, runner);
    expect(result.ok).toBe(true);
    expect(seen).toEqual({
      head,
      app: 'export {};\n',
      ignored: false,
      untracked: false,
      gitignore: false,
    });
    // The checkout is gone, and the project's repository gained no worktree.
    expect(existsSync(ran[0].cwd as string)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  // Review of the isolation change: the checkout must come from a repository
  // the worker cannot configure, not from the worker's own settings.
  it.each([
    [
      'a sparse checkout',
      () => {
        git(repo, 'sparse-checkout', 'set', '--no-cone', '/README.md');
      },
    ],
    [
      'a git replace of the reviewed commit',
      () => {
        writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const evil = true;\n');
        git(repo, 'add', '-A');
        git(repo, 'commit', '-q', '-m', 'not reviewed');
        const evil = git(repo, 'rev-parse', 'HEAD');
        git(repo, 'reset', '-q', '--hard', head);
        git(repo, 'replace', head, evil);
      },
    ],
    [
      'a smudge filter in .git/info/attributes and the repo config',
      () => {
        mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
        writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.ts filter=evil\n');
        git(repo, 'config', 'filter.evil.smudge', 'sed s/{}/{evil}/');
      },
    ],
  ])("a worker's %s cannot change what the command sees", async (_name, plant) => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    plant();
    let app: string | null = null;
    const { runner } = recordingRunner((_cmd, _args, cwd) => {
      const file = path.join(cwd as string, 'src', 'app.ts');
      app = existsSync(file) ? readFileSync(file, 'utf8') : null;
      return { code: 0 };
    });
    expect((await guard(fakeForge().forge, runner)).ok).toBe(true);
    expect(app).toBe('export {};\n');
  });

  it('an overwritten object in the project never reaches the command', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    const blob = git(repo, 'rev-parse', `${head}:src/app.ts`);
    const file = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    const evil = Buffer.from('export const evil = true;\n');
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])));
    let app: string | null = null;
    const { runner } = recordingRunner((_cmd, _args, cwd) => {
      app = readFileSync(path.join(cwd as string, 'src', 'app.ts'), 'utf8');
      return { code: 0 };
    });
    const result = await guard(fakeForge().forge, runner);
    // The copy is verified, so the swap fails the checkout: refused, and the
    // command never ran on content nobody reviewed.
    expect(result.ok).toBe(false);
    expect(app).toBeNull();
  });

  // Security S1: a checkout only flow controls. A tracked file edited (and
  // put back) in the worker's worktree while the command runs never reaches it.
  it("a tracked file edited and restored in the worker's worktree mid-run does not reach the command", async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    const original = readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8');
    let seen: string | null = null;
    let where: string | undefined;
    const { runner } = recordingRunner((_cmd, _args, cwd) => {
      where = cwd;
      writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const swapped = true;\n');
      seen = readFileSync(path.join(cwd as string, 'src', 'app.ts'), 'utf8');
      writeFileSync(path.join(repo, 'src', 'app.ts'), original);
      return { code: 0 };
    });
    expect((await guard(fakeForge().forge, runner)).ok).toBe(true);
    expect(seen).toBe('export {};\n');
    // A detached checkout of its own, outside the worker's worktree.
    expect(path.relative(repo, where as string).startsWith('..')).toBe(true);
    expect(
      execFileSync('git', ['status', '--porcelain', '--branch'], { cwd: repo, encoding: 'utf8' })
    ).toMatch(/^## feature/);
  });

  it("a command on the agent's PATH but not the fixed one cannot run", async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'flow-evil-bin-'));
    writeFileSync(path.join(bin, 'evil-check'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    baseLand({ preArm: [{ paths: ['src/**'], run: 'evil-check' }] });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${saved}`;
    try {
      const result = await guard(fakeForge().forge, realProcessRunner);
      expect(result).toMatchObject({ ok: false, reason: 'pre-arm-failed' });
    } finally {
      process.env.PATH = saved;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('scratch copies live in a private folder flow owns', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    let where: string | undefined;
    const { runner } = recordingRunner((_cmd, _args, cwd) => {
      where = cwd;
      return { code: 0 };
    });
    expect((await guard(fakeForge().forge, runner)).ok).toBe(true);
    const root = path.dirname(where as string);
    expect(path.basename(root)).toMatch(/^dorkos-flow-/);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it('removes the checkout when the command fails or times out too', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    for (const answer of [() => ({ code: 1 }), () => 'throw' as const]) {
      const { runner, ran } = recordingRunner(answer);
      expect((await guard(fakeForge().forge, runner)).ok).toBe(false);
      expect(existsSync(ran[0].cwd as string)).toBe(false);
    }
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('the command gets a minimal environment: no tokens, no GH_* or *_TOKEN', async () => {
    baseLand({ preArm: [{ paths: ['src/**'], run: 'check' }] });
    const saved = { ...process.env };
    Object.assign(process.env, {
      GH_TOKEN: 'ghp_secret',
      GITHUB_TOKEN: 'ghs_secret',
      NPM_TOKEN: 'npm_secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      GH_HOST: 'example.invalid',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    try {
      const { runner, ran } = recordingRunner();
      expect((await guard(fakeForge().forge, runner)).ok).toBe(true);
      const env = ran[0].env ?? {};
      expect(Object.keys(env).sort()).toEqual(
        Object.keys(env)
          .filter(
            (k) =>
              ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TZ', 'TERM', 'CI'].includes(k) ||
              k.startsWith('LC_')
          )
          .sort()
      );
      expect(env.CI).toBe('true');
      // A fixed system PATH, never the agent's.
      expect(env.PATH).toBe(FIXED_PATH);
      // A scratch HOME, so the PR's code finds no ~/.config/gh or ~/.npmrc.
      expect(env.HOME).toBeTruthy();
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(JSON.stringify(env)).not.toMatch(/secret|aws|example\.invalid/);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('a real command sees none of the tokens', async () => {
    baseLand({
      preArm: [
        {
          paths: ['src/**'],
          run: 'node -e "process.exit(process.env.GH_TOKEN ? 3 : process.env.MY_SERVICE_TOKEN ? 4 : 0)"',
        },
      ],
    });
    const saved = { ...process.env };
    Object.assign(process.env, { GH_TOKEN: 'ghp_secret', MY_SERVICE_TOKEN: 'x' });
    try {
      // Every program runs for real here, git and node alike.
      expect(await guard(fakeForge().forge, realProcessRunner)).toMatchObject({ ok: true });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('runs entries in order and stops at the first refusal', async () => {
    baseLand({
      preArm: [
        { paths: ['src/**'], run: 'first' },
        { paths: ['src/**'], run: 'second' },
        { paths: ['src/**'], run: 'third' },
      ],
    });
    const { runner, ran } = recordingRunner((cmd) => ({ code: cmd === 'second' ? 2 : 0 }));
    const result = await guard(fakeForge().forge, runner);
    expect(ran.map((r) => r.cmd)).toEqual(['first', 'second']);
    expect(!result.ok && result.preArm.map((o) => o.result)).toEqual(['passed', 'refused']);
  });

  it('splits a command with no shell', () => {
    expect(splitCommand('npm run "test browser" --x=\'a b\'')).toEqual([
      'npm',
      'run',
      'test browser',
      '--x=a b',
    ]);
    expect(splitCommand('a  b')).toEqual(['a', 'b']);
    expect(splitCommand('a "b')).toBeNull();
    expect(splitCommand('a; b')).toBeNull();
    expect(splitCommand('a $(b)')).toBeNull();
    expect(splitCommand('a `b`')).toBeNull();
    expect(splitCommand('a\\ b')).toBeNull();
    expect(splitCommand('   ')).toBeNull();
  });
});

describe('land.preArm wait: workflow entries', () => {
  beforeEach(() => {
    baseLand({
      preArm: [{ paths: ['src/**'], wait: 'workflow', workflow: 'shards.yml', timeout: 5 }],
    });
  });

  it('dispatches exactly gh workflow run <workflow> --ref <branch> -f sha=<reviewed> -f nonce=<random>, and passes on its run', async () => {
    const { forge, calls } = fakeForge({ runs: () => [run()] });
    expect((await guard(forge)).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'dispatchWorkflow')).toEqual([
      { method: 'dispatchWorkflow', args: ['shards.yml', 'feature', { sha: head, nonce: NONCE }] },
    ]);
  });

  it("waits only on the run carrying its nonce at the reviewed head; another dispatch's run is ignored", async () => {
    const theirs = run({
      id: 2,
      title: 'preArm ffffffffffffffffffffffffffffffff',
      conclusion: 'success',
    });
    const wrongSha = run({ id: 3, headSha: 'f'.repeat(40), conclusion: 'success' });
    const { forge } = fakeForge({
      runs: (n) =>
        n < 3 ? [theirs, wrongSha] : [theirs, wrongSha, run({ id: 4, conclusion: 'failure' })],
    });
    const result = await guard(forge);
    expect(result).toMatchObject({ ok: false, reason: 'pre-arm-failed' });
    expect(!result.ok && result.detail).toMatch(/finished failure/);
  });

  it('waits while its run is in progress', async () => {
    const { forge, calls } = fakeForge({
      runs: (n) => [run({ completed: n >= 3, conclusion: n >= 3 ? 'success' : '' })],
    });
    expect((await guard(forge)).ok).toBe(true);
    expect(calls.filter((c) => c.method === 'workflowRuns')).toHaveLength(3);
  });

  it('a red run refuses', async () => {
    const { forge } = fakeForge({ runs: () => [run({ conclusion: 'cancelled' })] });
    expect(await guard(forge)).toMatchObject({ ok: false, reason: 'pre-arm-failed' });
  });

  it('no matching run before the timeout refuses', async () => {
    const { forge, calls } = fakeForge({ runs: () => [] });
    const result = await guard(forge);
    expect(!result.ok && result.detail).toMatch(/no run of shards\.yml .* within 5 minutes/);
    // 5 minutes at one look every WORKFLOW_POLL_MS, plus the first.
    expect(calls.filter((c) => c.method === 'workflowRuns')).toHaveLength(
      (5 * 60_000) / WORKFLOW_POLL_MS + 1
    );
  });

  it('the branch moving during the run refuses', async () => {
    const { forge } = fakeForge({
      branchHead: (n) => (n <= 2 ? head : 'e'.repeat(40)),
      runs: () => [run({ completed: false, conclusion: '' })],
    });
    const result = await guard(forge);
    expect(!result.ok && result.detail).toMatch(/feature moved to eeeeeee while shards\.yml ran/);
  });

  it('the branch moving after the run finished refuses too', async () => {
    const { forge } = fakeForge({
      branchHead: (n) => (n === 1 ? head : 'e'.repeat(40)),
      runs: () => [run()],
    });
    expect(await guard(forge)).toMatchObject({ ok: false, reason: 'pre-arm-failed' });
  });

  it('a branch that already moved is refused before anything is dispatched', async () => {
    const { forge, calls } = fakeForge({ branchHead: () => 'e'.repeat(40) });
    expect((await guard(forge)).ok).toBe(false);
    expect(calls.some((c) => c.method === 'dispatchWorkflow')).toBe(false);
  });

  it('a workflow name the base config does not name is refused', async () => {
    const { forge, calls } = fakeForge({ runs: () => [run()] });
    const time = virtualTime();
    const refusal = await runWorkflow(
      'deploy.yml',
      ['shards.yml'],
      5,
      { worktree: repo, branch: 'feature', reviewedSha: head, files: [] },
      { runProcess: realProcessRunner, forge, ...time, nonce: () => NONCE }
    );
    expect(refusal).toMatch(/not a land\.preArm entry/);
    expect(calls).toEqual([]);
  });

  it.each([
    ['-x', 'head'],
    ['a..b', 'head'],
    ['feature;rm', 'head'],
    ['feature', 'short'],
    ['feature', 'upper'],
  ])('refuses branch %s with the %s sha before calling the forge', async (branch, which) => {
    const sha =
      which === 'short' ? head.slice(0, 7) : which === 'upper' ? head.toUpperCase() : head;
    const { forge, calls } = fakeForge();
    const time = virtualTime();
    const refusal = await runWorkflow(
      'shards.yml',
      ['shards.yml'],
      5,
      { worktree: repo, branch, reviewedSha: sha, files: [] },
      { runProcess: realProcessRunner, forge, ...time, nonce: () => NONCE }
    );
    expect(refusal).not.toBeNull();
    expect(calls).toEqual([]);
  });

  it("makes .github/workflows a security path, since --ref runs the PR's copy of the workflow", async () => {
    const { forge } = fakeForge({
      facts: { files: ['src/app.ts', '.github/workflows/shards.yml'] },
      runs: () => [run()],
    });
    expect(await guard(forge)).toMatchObject({ ok: false, reason: 'security-path-unlabelled' });
  });
});

describe('whole-string validation', () => {
  it('accepts only what it claims', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true);
    expect(isFullSha('A'.repeat(40))).toBe(false);
    expect(isFullSha(`${'a'.repeat(40)}\n`)).toBe(false);
    expect(isNonce(NONCE)).toBe(true);
    expect(isNonce(`${NONCE}0`)).toBe(false);
    for (const ok of ['shards.yml', 'browser-shards.yaml', 'ci'])
      expect(isWorkflowName(ok)).toBe(true);
    for (const bad of ['--repo', '-x', 'a b', 'a/b.yml', '', 'a\nb'])
      expect(isWorkflowName(bad)).toBe(false);
    for (const ok of ['feature', 'dor-3262-flow-arm-guard', 'user/topic', 'v1.2_x'])
      expect(isBranchName(ok)).toBe(true);
    for (const bad of [
      '-f',
      '.hidden',
      '/x',
      'x/',
      'a..b',
      'a//b',
      'a/.b',
      'x.lock',
      'a b',
      'a;b',
      'a\nb',
      'x.',
    ])
      expect(isBranchName(bad), bad).toBe(false);
  });
});
