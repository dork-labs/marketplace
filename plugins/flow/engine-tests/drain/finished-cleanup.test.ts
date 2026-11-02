/**
 * The drain's cleanup of a finished run's worker worktree (DOR-2469). The
 * folder goes only when it is the one the drain made for this item, on the
 * item's branch; no session may still run in it; it holds no uncommitted
 * change; and no commit in it would be lost. It is never forced.
 *
 * Real git in temp folders (a checkout and a bare origin); the sessions' host
 * is a fake launcher.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcessRunner } from '../../scripts/cli/context.ts';
import {
  planWorkerWorktree,
  removeWorkerWorktree,
  type CleanupDeps,
} from '../../scripts/drain/finished-cleanup.ts';
import type { DrainState, DrainWorkerHandle } from '../../scripts/drain/state.ts';
import { workspacesDir } from '../../scripts/drain/worktree.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import type { Launcher, SessionState } from '../../scripts/launchers/types.ts';

const BRANCH = 'ACME-1-title';

let root: string;
let checkout: string;
let dorkHome: string;
let target: string;
let head: string;

/** git in `cwd`. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();

/** Commit a file in `cwd`; its SHA. */
function commit(cwd: string, file: string): string {
  writeFileSync(path.join(cwd, file), `${file}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-cleanup-')));
  const origin = path.join(root, 'origin.git');
  checkout = path.join(root, 'app');
  dorkHome = path.join(root, 'dork');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(checkout);
  git(checkout, 'init', '-q', '-b', 'main');
  commit(checkout, 'a');
  git(checkout, 'remote', 'add', 'origin', origin);
  git(checkout, 'push', '-q', 'origin', 'main');
  target = path.join(workspacesDir(dorkHome, 'app'), BRANCH);
  mkdirSync(path.dirname(target), { recursive: true });
  git(checkout, 'worktree', 'add', '-q', '-b', BRANCH, target, 'main');
  head = commit(target, 'work');
  git(target, 'push', '-q', 'origin', BRANCH);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const WORKER: DrainWorkerHandle = {
  host: 'cli',
  runtime: 'claude-code',
  sessionId: 'w-1',
  account: null,
  cwd: '',
};

/** A finished drain run whose worker worked in `worktree`. */
function finished(over: Partial<DrainState> = {}, run: Partial<FlowRun> = {}) {
  return {
    issueId: 'id-ACME-1',
    identifier: 'ACME-1',
    sessionId: 'w-1',
    worktreePath: target,
    branch: BRANCH,
    stage: 'done',
    status: 'complete',
    attemptCount: 0,
    workerPid: -1,
    startedAt: '2026-09-26T00:00:00.000Z',
    drain: {
      v: 1,
      rev: 9,
      phase: 'closing',
      worker: null,
      reviewer: null,
      pushedSha: head,
      reviewedSha: head,
      verdict: 'clean',
      reviewRound: 1,
      pr: { repo: 'o/app', number: 7, url: 'u', armed: true, disarmedForReview: false },
      rearmedFor: null,
      nudges: 0,
      wakeAfter: null,
      handoffs: [],
      parkedReason: null,
      cleanup: { status: 'pending', worker: { ...WORKER, cwd: target } },
      ...over,
    } as DrainState,
    ...run,
  } as FlowRun & { drain: DrainState };
}

/** Deps whose host reports `state` for every session; `asked` lists the session ids. */
function deps(state: SessionState) {
  const asked: string[] = [];
  const d: CleanupDeps = {
    runProcess: realProcessRunner,
    mainCheckout: checkout,
    dorkHome,
    repoName: 'app',
    launcher: () =>
      ({
        state: async (h: { sessionId: string }) => {
          asked.push(h.sessionId);
          return state;
        },
      }) as unknown as Launcher,
  };
  return { asked, d };
}

const EXITED: SessionState = { kind: 'exited', code: 0 };

describe('planWorkerWorktree', () => {
  it('removes a clean worktree at its pushed head once the worker exited', async () => {
    const { d, asked } = deps(EXITED);
    const plan = await planWorkerWorktree(d, finished());
    expect(plan).toEqual({ action: 'remove', path: target });
    expect(asked).toEqual(['w-1']);
    expect(await removeWorkerWorktree(d, plan as { action: 'remove'; path: string })).toEqual({
      removed: true,
      reason: 'removed',
    });
    expect(existsSync(target)).toBe(false);
    // The branch stays; only the folder goes.
    expect(git(checkout, 'branch', '--list', BRANCH)).toContain(BRANCH);
  });

  it('counts a DorkOS worker the drain left idle, or one DorkOS forgot, as stopped', async () => {
    // DorkOS's stop leaves a session idle; it never reads exited.
    expect((await planWorkerWorktree(deps({ kind: 'idle' }).d, finished())).action).toBe('remove');
    const gone: SessionState = { kind: 'unknown', reason: 'r', gone: true };
    expect((await planWorkerWorktree(deps(gone).d, finished())).action).toBe('remove');
  });

  it.each<[string, SessionState]>([
    ['busy', { kind: 'busy' }],
    ['limited', { kind: 'limited', window: null, resetsAt: null }],
    ['unknown', { kind: 'unknown', reason: 'no answer' }],
  ])('waits while the worker is %s', async (_name, state) => {
    expect(await planWorkerWorktree(deps(state).d, finished())).toMatchObject({
      action: 'wait',
      path: target,
    });
    expect(existsSync(target)).toBe(true);
  });

  it('waits on a worker whose start was never confirmed', async () => {
    const run = finished({
      cleanup: { status: 'pending', worker: { ...WORKER, cwd: target, pending: true } },
    });
    expect((await planWorkerWorktree(deps(EXITED).d, run)).action).toBe('wait');
  });

  it('waits on a VERIFY reviewer started in the same folder until it exited (idle is not enough)', async () => {
    const run = finished({}, {
      review: {
        tokenHash: 'x',
        sha: head,
        verdict: 'clean',
        reviewedSha: head,
        reviewer: { host: 'cli', runtime: 'claude-code', sessionId: 'v-1', cwd: target },
      },
    } as Partial<FlowRun>);
    const idle = deps({ kind: 'idle' });
    // The worker reads idle (fine for a worker the drain stopped); the reviewer reads idle too.
    expect((await planWorkerWorktree(idle.d, run)).action).toBe('wait');
    expect(idle.asked).toContain('v-1');
    expect((await planWorkerWorktree(deps(EXITED).d, run)).action).toBe('remove');
  });

  it('waits while the run still records a live session', async () => {
    const run = finished({ worker: { ...WORKER, cwd: target } });
    expect((await planWorkerWorktree(deps(EXITED).d, run)).action).toBe('wait');
  });

  it('keeps a folder that is not the one the drain made for this item', async () => {
    const elsewhere = path.join(root, 'mine');
    git(checkout, 'worktree', 'add', '-q', '-b', 'other', elsewhere, 'main');
    const plan = await planWorkerWorktree(
      deps(EXITED).d,
      finished({}, { worktreePath: elsewhere })
    );
    expect(plan).toEqual({
      action: 'keep',
      path: elsewhere,
      reason: 'not the worktree flow made for this item',
    });
    expect(existsSync(elsewhere)).toBe(true);
  });

  it('keeps a folder at the right path that git does not list as a worktree', async () => {
    git(checkout, 'worktree', 'remove', target);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'notes.txt'), 'mine\n');
    expect(await planWorkerWorktree(deps(EXITED).d, finished())).toEqual({
      action: 'keep',
      path: target,
      reason: 'not a worktree of this checkout',
    });
  });

  it('keeps a worktree someone moved to another branch', async () => {
    git(target, 'switch', '-q', '-c', 'someone-else');
    expect(await planWorkerWorktree(deps(EXITED).d, finished())).toEqual({
      action: 'keep',
      path: target,
      reason: 'no longer on its branch',
    });
  });

  it('keeps a worktree with uncommitted changes, untracked files included', async () => {
    writeFileSync(path.join(target, 'pr-body.md'), 'draft\n');
    expect(await planWorkerWorktree(deps(EXITED).d, finished())).toEqual({
      action: 'keep',
      path: target,
      reason: 'it has 1 uncommitted change',
    });
  });

  it('keeps a worktree with a commit on no remote', async () => {
    commit(target, 'local-only');
    expect(await planWorkerWorktree(deps(EXITED).d, finished())).toEqual({
      action: 'keep',
      path: target,
      reason: 'it has 1 commit not on any remote',
    });
  });

  it('removes one whose branch origin deleted after a squash merge, at the pushed head', async () => {
    git(checkout, 'push', '-q', 'origin', '--delete', BRANCH);
    git(checkout, 'fetch', '-q', '--prune', 'origin');
    expect((await planWorkerWorktree(deps(EXITED).d, finished())).action).toBe('remove');
    // The same commits past the recorded head would be lost: kept.
    expect(
      await planWorkerWorktree(deps(EXITED).d, finished({ pushedSha: null, reviewedSha: null }))
    ).toMatchObject({ action: 'keep', reason: 'it has 1 commit not on any remote' });
  });

  it('says a folder already gone is gone', async () => {
    git(checkout, 'worktree', 'remove', target);
    expect(await planWorkerWorktree(deps(EXITED).d, finished())).toEqual({
      action: 'gone',
      path: target,
    });
  });
});

describe('removeWorkerWorktree', () => {
  it('never forces: a change that lands after the plan keeps the folder', async () => {
    const { d } = deps(EXITED);
    const plan = await planWorkerWorktree(d, finished());
    writeFileSync(path.join(target, 'late.txt'), 'late\n');
    git(target, 'add', 'late.txt');
    const out = await removeWorkerWorktree(d, plan as { action: 'remove'; path: string });
    expect(out.removed).toBe(false);
    expect(existsSync(path.join(target, 'late.txt'))).toBe(true);
  });
});
