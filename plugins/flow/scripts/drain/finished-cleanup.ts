/**
 * The worker worktree `flow drain` removes once a run is finished (DOR-2469).
 * The pass that stops a finished worker marks the folder (`drain.cleanup`,
 * `pending`); a later part of a pass removes it, under four rules:
 *
 * 1. Only the folder the drain made for this item: exactly
 *    `<workspaces>/<repo>/<branch>`, listed by git as a worktree of this
 *    checkout, on the run's branch. Anything else is kept.
 * 2. Only once no session may still run in it. The worker the drain stopped
 *    counts as stopped when its host says it exited or is gone, or, on DorkOS
 *    only, is idle (DorkOS's stop leaves a session idle, and this worker
 *    already ran DONE).
 *    A VERIFY reviewer started in the same folder must have exited or be gone,
 *    the rule `flow release` uses. Until then it waits for a later pass.
 * 3. Only with no uncommitted change, untracked files included.
 * 4. Only when no commit would be lost: its head is the head the run reported
 *    pushed or had reviewed (after a squash merge origin usually deletes the
 *    branch), or every commit in it is on a remote.
 *
 * It is never forced, so git refuses a change that lands after the plan. The
 * branch stays. Ignored files go with the folder, the cli launcher's session
 * logs among them.
 *
 * @module @dorkos/flow/drain/finished-cleanup
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { ProcessRunner } from '../cli/context.ts';
import type { FlowRun } from '../flow-run.ts';
import type { HostName, Launcher } from '../launchers/types.ts';
import type { DrainState } from './state.ts';
import { workspacesDir } from './worktree.ts';
import {
  folderSessionState,
  listedWorktree,
  real,
  sessionDone,
  uncommittedChanges,
} from './worktree-safety.ts';

/** What the cleanup reads and runs. */
export interface CleanupDeps {
  /** Runs git (no shell). */
  runProcess: ProcessRunner;
  /** The launcher for a host. */
  launcher(host: HostName): Launcher;
  /** The main checkout, which owns the worktree. */
  mainCheckout: string;
  /** The resolved DorkOS home. */
  dorkHome: string;
  /** The repository's name, for the worktree folder. */
  repoName: string;
}

/** What the cleanup decided about a finished run's worker worktree. */
export type WorkerWorktreePlan =
  /** Remove it. */
  | { action: 'remove'; path: string }
  /** Leave it for good, and say why once. */
  | { action: 'keep'; path: string; reason: string }
  /** A session may still run in it: ask again next pass. */
  | { action: 'wait'; path: string; reason: string }
  /** Nothing is there any more. */
  | { action: 'gone'; path: string };

/** What a wait says. */
const MAY_RUN = 'a session may still be running in it';

/** `n thing` or `n things`. */
function count(n: number, thing: string): string {
  return `${n} ${thing}${n === 1 ? '' : 's'}`;
}

/** How many commits reachable from `head` are on no remote; `null` when git cannot say. */
async function unpushed(
  run: ProcessRunner,
  checkout: string,
  head: string
): Promise<number | null> {
  const out = await run('git', ['rev-list', '--count', head, '--not', '--remotes'], {
    cwd: checkout,
  });
  if (out.code !== 0) return null;
  const n = Number.parseInt(out.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide what to do with a finished run's worker worktree. Reads only.
 *
 * @param deps - The process runner, launchers and where the drain's worktrees live.
 * @param run - A complete drain run whose `drain.cleanup` is `pending`.
 * @returns The plan.
 */
export async function planWorkerWorktree(
  deps: CleanupDeps,
  run: FlowRun & { drain: DrainState }
): Promise<WorkerWorktreePlan> {
  const target = run.worktreePath;
  const expected = path.join(workspacesDir(deps.dorkHome, deps.repoName), run.branch);
  if (path.resolve(target) !== path.resolve(expected)) {
    return { action: 'keep', path: target, reason: 'not the worktree flow made for this item' };
  }
  if (!existsSync(target)) return { action: 'gone', path: target };
  const entry = await listedWorktree(deps.runProcess, deps.mainCheckout, target);
  if (entry === null) {
    return { action: 'keep', path: target, reason: 'not a worktree of this checkout' };
  }
  if (entry.branch !== run.branch) {
    return { action: 'keep', path: target, reason: 'no longer on its branch' };
  }

  if (run.drain.worker !== null || run.drain.reviewer !== null) {
    return { action: 'wait', path: target, reason: MAY_RUN };
  }
  const worker = run.drain.cleanup?.worker ?? null;
  if (worker !== null) {
    const state = await folderSessionState(deps.launcher, worker);
    // Idle counts only on DorkOS, whose stop leaves a session idle; elsewhere
    // the stop ends the process, so idle means the stop failed.
    const stopped =
      state !== null &&
      (state.kind === 'exited' ||
        (state.kind === 'idle' && worker.host === 'dorkos') ||
        (state.kind === 'unknown' && state.gone === true));
    if (!stopped) return { action: 'wait', path: target, reason: MAY_RUN };
  }
  const verify = run.review?.reviewer;
  if (
    verify !== undefined &&
    real(verify.cwd) === real(target) &&
    !(await sessionDone(deps.launcher, verify))
  ) {
    return { action: 'wait', path: target, reason: MAY_RUN };
  }

  const changes = await uncommittedChanges(deps.runProcess, target);
  if (changes === null) {
    return { action: 'keep', path: target, reason: 'git could not read its changes' };
  }
  if (changes > 0) {
    return {
      action: 'keep',
      path: target,
      reason: `it has ${count(changes, 'uncommitted change')}`,
    };
  }

  const head = entry.head;
  if (head === null) return { action: 'keep', path: target, reason: 'git printed no head for it' };
  if (head !== run.drain.pushedSha && head !== run.drain.reviewedSha) {
    const missing = await unpushed(deps.runProcess, deps.mainCheckout, head);
    if (missing === null) {
      return {
        action: 'keep',
        path: target,
        reason: 'git could not tell whether its commits are on a remote',
      };
    }
    if (missing > 0) {
      return {
        action: 'keep',
        path: target,
        reason: `it has ${count(missing, 'commit')} not on any remote`,
      };
    }
  }
  return { action: 'remove', path: target };
}

/**
 * Remove the worktree a plan cleared, never forced. Never throws.
 *
 * @param deps - The process runner and the main checkout.
 * @param plan - A `remove` plan from {@link planWorkerWorktree}.
 * @returns Whether it went, and why not when it did not.
 */
export async function removeWorkerWorktree(
  deps: Pick<CleanupDeps, 'runProcess' | 'mainCheckout'>,
  plan: Extract<WorkerWorktreePlan, { action: 'remove' }>
): Promise<{ removed: boolean; reason: string }> {
  try {
    const out = await deps.runProcess('git', ['worktree', 'remove', plan.path], {
      cwd: deps.mainCheckout,
    });
    if (out.code === 0) return { removed: true, reason: 'removed' };
    return { removed: false, reason: out.stderr.trim() || `git exited ${out.code}` };
  } catch (error) {
    return { removed: false, reason: (error as Error).message };
  }
}
