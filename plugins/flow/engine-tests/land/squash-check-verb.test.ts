/**
 * `flow squash-check` (DOR-3262) through `main`, on a real project with a bare
 * `origin`: the squash commit comes from the forge, the reviewed head from the
 * run record, and a failure is reported on the PR to its author and the
 * security reviewer. Nothing is reverted.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner, type ProcessRunner } from '../../scripts/cli/context.ts';
import type { DrainState } from '../../scripts/drain/state.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { main } from '../../scripts/flow.ts';
import type { Forge, MergeInfo } from '../../scripts/forge/types.ts';
import { createFakeAdapter } from '../fixtures/cli/fake-adapter/adapter.ts';
import { makeProject, type WriteProject } from '../cli/write-harness.ts';
import { squashSettled } from '../../scripts/cli/squash-check.ts';
import type { SquashVerdict } from '../../scripts/land/squash-verify.ts';

let project: WriteProject;
let origin: string;
let reviewed: string;

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

function commitFile(file: string, text: string, message: string): string {
  mkdirSync(path.dirname(path.join(project.dir, file)), { recursive: true });
  writeFileSync(path.join(project.dir, file), text);
  git('add', file);
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Squash the reviewed head onto main, optionally slipping in `extra`, and push main. */
function squash(extra?: string): string {
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', reviewed);
  if (extra !== undefined) {
    writeFileSync(path.join(project.dir, 'extra.txt'), extra);
    git('add', 'extra.txt');
  }
  git('commit', '-q', '-m', 'squash');
  git('push', '-q', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'work');
  return sha;
}

function fakeForge(info: MergeInfo) {
  const comments: [number, string][] = [];
  const forge = {
    repo: 'acme/app',
    async mergeInfo() {
      return info;
    },
    async comment(pr: number, body: string) {
      comments.push([pr, body]);
    },
  } as unknown as Forge;
  return { forge, comments };
}

const runner: ProcessRunner = async (cmd, args, opts) => {
  if (cmd === 'git' && args.join(' ') === 'remote get-url origin') {
    return { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' };
  }
  return realProcessRunner(cmd, args, opts);
};

async function flow(argv: string[], forge: Forge) {
  let out = '';
  let err = '';
  const code = await main([...argv, '--json'], {
    env: { FLOW_SESSION_ID: 'session-abcdef123456', CLAUDECODE: '1' },
    cwd: project.dir,
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    createAdapter: async () => createFakeAdapter({ items: [] }).adapter,
    runProcess: runner,
    createForge: () => forge,
  });
  return { code, json: JSON.parse(out) as Record<string, unknown>, stderr: err };
}

function writeRun(drain: Partial<DrainState> | null): void {
  const run: FlowRun = {
    issueId: 'id-ACME-12',
    identifier: 'ACME-12',
    sessionId: 'session-abcdef123456',
    worktreePath: project.dir,
    branch: 'work',
    stage: 'review',
    status: 'running',
    attemptCount: 0,
    workerPid: -1,
    startedAt: '2026-10-24T10:00:00.000Z',
    ...(drain === null
      ? {}
      : {
          drain: {
            v: 1,
            rev: 1,
            phase: 'closing',
            worker: null,
            reviewer: null,
            pushedSha: reviewed,
            reviewedSha: reviewed,
            verdict: 'clean',
            reviewRound: 1,
            pr: {
              repo: 'acme/app',
              number: 7,
              url: 'https://github.com/acme/app/pull/7',
              armed: true,
              disarmedForReview: false,
            },
            rearmedFor: null,
            nudges: 0,
            wakeAfter: null,
            handoffs: [],
            parkedReason: null,
            ...drain,
          } as DrainState,
        }),
  };
  project.writeRuns({ 'id-ACME-12': run });
}

beforeEach(() => {
  project = makeProject();
  origin = `${project.dir}-origin.git`;
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git('remote', 'add', 'origin', origin);
  git('branch', 'main');
  git('push', '-q', 'origin', 'main');
  reviewed = commitFile('src/app.ts', 'export const x = 1;\n', 'the reviewed work');
  writeFileSync(
    path.join(project.dir, '.agents', 'flow', 'config.local.json'),
    JSON.stringify({ land: { securityPaths: { reviewer: 'acme-security' } } })
  );
});

afterEach(() => {
  project.cleanup();
  rmSync(origin, { recursive: true, force: true });
});

describe('flow squash-check', () => {
  it('passes a clean squash and posts nothing', async () => {
    const sha = squash();
    writeRun({});
    const { forge, comments } = fakeForge({ state: 'merged', mergeCommit: sha, author: 'octocat' });
    const r = await flow(['squash-check', 'ACME-12'], forge);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, verdict: { verdict: 'pass', check: 'tree' } });
    expect(comments).toEqual([]);
  });

  it('fails a squash with a change slipped in, and reports it to the author and Security', async () => {
    const sha = squash('slipped in\n');
    writeRun({});
    const { forge, comments } = fakeForge({ state: 'merged', mergeCommit: sha, author: 'octocat' });
    const r = await flow(['squash-check', 'ACME-12'], forge);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      ok: false,
      reported: true,
      verdict: { verdict: 'fail', files: ['extra.txt'] },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0][0]).toBe(7);
    expect(comments[0][1]).toMatch(/^@octocat @acme-security: \*\*Squash check failed\.\*\*/);
    expect(comments[0][1]).toContain('```text\nextra.txt\n');
  });

  it('a dry run reports nothing', async () => {
    const sha = squash('slipped in\n');
    writeRun({});
    const { forge, comments } = fakeForge({ state: 'merged', mergeCommit: sha, author: 'octocat' });
    const r = await flow(['squash-check', 'ACME-12', '--dry-run'], forge);
    expect(r.code).toBe(1);
    expect(comments).toEqual([]);
  });

  it('is held to the head recorded at review, even when the PR merged a later one', async () => {
    const later = commitFile('src/app.ts', 'export const x = 2;\n', 'pushed after the review');
    git('push', '-q', 'origin', 'work');
    const recorded = reviewed;
    reviewed = later;
    const sha = squash();
    reviewed = recorded;
    writeRun({});
    const { forge } = fakeForge({ state: 'merged', mergeCommit: sha, author: 'octocat' });
    expect((await flow(['squash-check', 'ACME-12'], forge)).code).toBe(1);
  });

  it('refuses (exit 5) a PR that has not merged', async () => {
    writeRun({});
    const open = fakeForge({ state: 'open', mergeCommit: null, author: null });
    expect((await flow(['squash-check', 'ACME-12'], open.forge)).code).toBe(EXIT.precondition);
    expect(open.comments).toEqual([]);
  });

  it('a merge with no clean review at its head fails loudly', async () => {
    writeRun({ verdict: 'changes' });
    const merged = fakeForge({ state: 'merged', mergeCommit: squash(), author: 'octocat' });
    const r = await flow(['squash-check', 'ACME-12'], merged.forge);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'unreviewed', reported: true });
    expect(merged.comments[0][1]).toMatch(
      /^@octocat @acme-security: \*\*Squash check failed\.\*\* #7 merged with no clean review/
    );
  });

  it('a check that could not run says so on the PR', async () => {
    writeRun({});
    const { forge, comments } = fakeForge({
      state: 'merged',
      mergeCommit: 'f'.repeat(40),
      author: null,
    });
    const r = await flow(['squash-check', 'ACME-12'], forge);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ verdict: { verdict: 'unverified' }, reported: true });
    expect(comments[0][1]).toMatch(/^@acme-security: \*\*Squash check could not run\.\*\*/);
  });

  it('needs --pr for a run with no PR recorded, and takes only a number', async () => {
    writeRun(null);
    const { forge } = fakeForge({ state: 'merged', mergeCommit: squash(), author: null });
    expect((await flow(['squash-check', 'ACME-12'], forge)).code).toBe(EXIT.precondition);
    expect((await flow(['squash-check', 'ACME-12', '--pr', '7; rm'], forge)).code).toBe(EXIT.usage);
  });
});

describe('squashSettled', () => {
  const fail: SquashVerdict = {
    verdict: 'fail',
    reason: 'r',
    squash: 'a'.repeat(40),
    reviewed: 'b'.repeat(40),
    squashTree: null,
    reviewedTree: null,
    files: [],
    patchIdMatch: false,
  };
  it('settles a pass, and a failure only once it was reported', () => {
    const pass = {
      verdict: 'pass',
      check: 'tree',
      patchIdMatch: true,
      squash: 'a',
      reviewed: 'b',
    } as const;
    expect(squashSettled({ status: 'checked', verdict: pass, reported: false })).toBe(true);
    expect(squashSettled({ status: 'checked', verdict: fail, reported: true })).toBe(true);
    expect(
      squashSettled({ status: 'checked', verdict: fail, reported: false, reportError: 'HTTP 502' })
    ).toBe(false);
    expect(squashSettled({ status: 'checked', verdict: fail, reported: false }, true)).toBe(true);
    expect(
      squashSettled({ status: 'unreviewed', why: 'w', reported: false, reportError: 'x' })
    ).toBe(false);
    expect(squashSettled({ status: 'unknown', why: 'w', reported: true })).toBe(false);
  });
});
