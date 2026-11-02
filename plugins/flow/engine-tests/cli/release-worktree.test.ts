/**
 * `flow release` and a reviewer worktree the drain kept (DOR-3704). The lane
 * supervisor parks a quiet reviewer instead of restarting it, so its detached
 * review worktree outlives the review. Releasing the item removes that folder,
 * but only one flow made for this item's review, only once its session is
 * confirmed stopped or gone, and only clean unless `--discard-review-changes`.
 *
 * Real git in temp folders; the session's host is a fake launcher.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REVIEWER_MAY_RUN } from '../../scripts/cli/release-worktree.ts';
import { reviewWorktreePath } from '../../scripts/drain/worktree.ts';
import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import type { Launcher, SessionState } from '../../scripts/launchers/types.ts';
import { item, makeProject, runFlow, type WriteProject } from './write-harness.ts';

let project: WriteProject;
let dorkHome: string;
let sha: string;
let target: string;

/** git in `cwd`. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

beforeEach(() => {
  project = makeProject();
  dorkHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-release-home-')));
  sha = git(project.dir, 'rev-parse', 'HEAD');
  target = reviewWorktreePath(dorkHome, path.basename(project.dir), 'FAKE-1', sha);
  mkdirSync(path.dirname(target), { recursive: true });
  git(project.dir, 'worktree', 'add', '-q', '--detach', target, sha);
});

afterEach(() => {
  project.cleanup();
  rmSync(dorkHome, { recursive: true, force: true });
});

const ENV = () => ({
  FLOW_SESSION_ID: 'session-abc',
  CLAUDECODE: '1',
  CLAUDE_CONFIG_DIR: '/home/someone/.claude-work',
  DORK_HOME: dorkHome,
});

/** A parked run whose reviewer works in `worktree` at `reviewSha`. */
function parkedRun(worktree = target, reviewSha = sha): Record<string, FlowRun> {
  return {
    'id-FAKE-1': {
      issueId: 'id-FAKE-1',
      identifier: 'FAKE-1',
      sessionId: 'w-1',
      worktreePath: '/w',
      branch: 'b',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: -1,
      startedAt: '2026-09-26T00:00:00.000Z',
      host: 'dorkos',
      drain: {
        v: 1,
        rev: 3,
        phase: 'parked',
        worker: {
          host: 'dorkos',
          runtime: 'claude-code',
          sessionId: 'w-1',
          account: null,
          cwd: '/w',
        },
        reviewer: {
          host: 'dorkos',
          runtime: 'claude-code',
          sessionId: 'r-1',
          account: null,
          cwd: worktree,
          sha: reviewSha,
          worktree,
          tokenHash: 'sha256:x',
        },
        pushedSha: reviewSha,
        reviewedSha: null,
        verdict: null,
        reviewRound: 0,
        pr: null,
        rearmedFor: null,
        nudges: 0,
        wakeAfter: null,
        handoffs: [],
        parkedReason: 'the reviewer wrote nothing for 60 minutes',
      },
    } as FlowRun,
  };
}

/** A launcher factory whose host reports `state` for every session; `asked` lists the session ids. */
function host(state: SessionState) {
  const asked: string[] = [];
  const createLauncher = () =>
    ({
      state: async (h: { sessionId: string }) => {
        asked.push(h.sessionId);
        return state;
      },
    }) as unknown as Launcher;
  return { asked, createLauncher };
}

const GONE: SessionState = { kind: 'unknown', reason: 'DorkOS no longer knows it', gone: true };

/** `flow release FAKE-1 ...` with the session in `state`. */
function release(state: SessionState, ...extra: string[]) {
  return runFlow(
    project,
    {
      items: [item('FAKE-1', { stateCategory: 'started', labels: ['type/task', 'agent/claimed'] })],
    },
    ['release', 'FAKE-1', ...extra],
    { env: ENV(), createLauncher: host(state).createLauncher }
  );
}

describe('flow release: the kept reviewer worktree', () => {
  it('removes a clean one whose session is gone, and says so', async () => {
    project.writeRuns(parkedRun());
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(false);
    expect(git(project.dir, 'worktree', 'list')).not.toContain(path.basename(target));
    expect(result.json.reviewWorktree).toMatchObject({ path: target, removed: true });
    expect(project.runs()).toEqual({});
  });

  it('removes it when the session exited', async () => {
    project.writeRuns(parkedRun());
    const result = await release({ kind: 'exited', code: 0 });
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    ['busy', { kind: 'busy', activityAt: '2026-09-26T11:00:00.000Z' } as SessionState],
    ['idle (alive, no turn running)', { kind: 'idle' } as SessionState],
    ['unreachable', { kind: 'unknown', reason: 'connect ECONNREFUSED' } as SessionState],
    [
      'one the host cannot describe',
      { kind: 'unknown', reason: 'no status', cannotTell: true } as SessionState,
    ],
    ['limited', { kind: 'limited', window: 'five_hour', resetsAt: null } as SessionState],
  ])('refuses, keeping the folder and the run, while the session is %s', async (_name, state) => {
    project.writeRuns(parkedRun());
    const result = await release(state);
    expect(result.code).toBe(EXIT.precondition);
    expect(String((result.json.error as { message: string }).message)).toContain(REVIEWER_MAY_RUN);
    expect(existsSync(target)).toBe(true);
    expect(result.tracker.calls).toEqual([]);
    expect(Object.keys(project.runs())).toEqual(['id-FAKE-1']);
  });

  it('refuses while a start of the reviewer is not yet confirmed (pending)', async () => {
    const runs = parkedRun();
    runs['id-FAKE-1']!.drain!.reviewer!.pending = true;
    project.writeRuns(runs);
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.precondition);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses while a VERIFY review of this commit is starting (no session recorded yet)', async () => {
    const runs = parkedRun();
    runs['id-FAKE-1']!.review = { tokenHash: 'sha256:y', sha, verdict: null, reviewedSha: null };
    project.writeRuns(runs);
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.precondition);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses while a VERIFY reviewer in the same folder may still run', async () => {
    const runs = parkedRun();
    runs['id-FAKE-1']!.review = {
      tokenHash: 'sha256:y',
      sha,
      verdict: null,
      reviewedSha: null,
      reviewer: { host: 'dorkos', runtime: 'claude-code', sessionId: 'v-1', cwd: target },
    };
    project.writeRuns(runs);
    const states: Record<string, SessionState> = { 'r-1': GONE, 'v-1': { kind: 'busy' } };
    const result = await runFlow(
      project,
      {
        items: [
          item('FAKE-1', { stateCategory: 'started', labels: ['type/task', 'agent/claimed'] }),
        ],
      },
      ['release', 'FAKE-1'],
      {
        env: ENV(),
        createLauncher: () =>
          ({
            state: async (h: { sessionId: string }) => states[h.sessionId] ?? GONE,
          }) as unknown as Launcher,
      }
    );
    expect(result.code).toBe(EXIT.precondition);
    expect(String((result.json.error as { message: string }).message)).toContain(REVIEWER_MAY_RUN);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses a folder with uncommitted changes, writing nothing', async () => {
    project.writeRuns(parkedRun());
    writeFileSync(path.join(target, 'notes.txt'), 'left behind\n');
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.precondition);
    expect(String((result.json.error as { message: string }).message)).toMatch(
      /uncommitted.*--discard-review-changes/
    );
    expect(existsSync(path.join(target, 'notes.txt'))).toBe(true);
    expect(Object.keys(project.runs())).toEqual(['id-FAKE-1']);
  });

  it('removes a folder with uncommitted changes only with --discard-review-changes', async () => {
    project.writeRuns(parkedRun());
    writeFileSync(path.join(target, 'notes.txt'), 'left behind\n');
    const result = await release(GONE, '--discard-review-changes');
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(false);
    expect(result.json.reviewWorktree).toMatchObject({ removed: true });
  });

  it('never touches a folder flow did not name for this review, and still releases', async () => {
    const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-not-review-')));
    rmSync(other, { recursive: true });
    git(project.dir, 'worktree', 'add', '-q', '--detach', other, sha);
    try {
      project.writeRuns(parkedRun(other));
      const result = await release(GONE);
      expect(result.code).toBe(EXIT.ok);
      expect(existsSync(other)).toBe(true);
      expect(result.json.reviewWorktree).toMatchObject({ path: other, removed: false });
      expect(String((result.json.reviewWorktree as { reason: string }).reason)).toMatch(
        /not the review folder flow made/
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('never touches a folder git does not list as a worktree of this checkout', async () => {
    git(project.dir, 'worktree', 'remove', '--force', target);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'mine.txt'), 'x');
    project.writeRuns(parkedRun());
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(path.join(target, 'mine.txt'))).toBe(true);
    expect(String((result.json.reviewWorktree as { reason: string }).reason)).toMatch(
      /not a worktree of this checkout/
    );
  });

  it('never touches a worktree that is no longer at the reviewed commit', async () => {
    git(
      target,
      '-c',
      'user.email=t@example.test',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'moved'
    );
    project.writeRuns(parkedRun());
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(true);
    expect(String((result.json.reviewWorktree as { reason: string }).reason)).toMatch(
      /no longer at the reviewed commit/
    );
  });

  it('says a folder already gone is gone, and releases', async () => {
    git(project.dir, 'worktree', 'remove', '--force', target);
    project.writeRuns(parkedRun());
    const result = await release(GONE);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json.reviewWorktree).toMatchObject({ removed: false, reason: 'already gone' });
  });

  it('removes nothing under --dry-run, and says what it would remove', async () => {
    project.writeRuns(parkedRun());
    const result = await release(GONE, '--dry-run');
    expect(result.code).toBe(EXIT.ok);
    expect(existsSync(target)).toBe(true);
    expect(result.json.reviewWorktree).toMatchObject({ path: target, removed: false });
    expect(String((result.json.reviewWorktree as { reason: string }).reason)).toMatch(
      /would remove/
    );
  });

  it('asks nothing of a host when the run has no reviewer', async () => {
    const runs = parkedRun();
    runs['id-FAKE-1']!.drain!.reviewer = null;
    project.writeRuns(runs);
    const h = host(GONE);
    const result = await runFlow(
      project,
      {
        items: [
          item('FAKE-1', { stateCategory: 'started', labels: ['type/task', 'agent/claimed'] }),
        ],
      },
      ['release', 'FAKE-1'],
      { env: ENV(), createLauncher: h.createLauncher }
    );
    expect(result.code).toBe(EXIT.ok);
    expect(h.asked).toEqual([]);
    expect(result.json.reviewWorktree).toBeNull();
    expect(existsSync(target)).toBe(true);
  });
});
