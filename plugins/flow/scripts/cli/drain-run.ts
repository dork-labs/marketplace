/**
 * What `flow report` and `flow pr` share (spec `flow-handoff-dispatch` §4.3,
 * §4.5, §4.6): finding the drain run an identifier names, reading the branch
 * on origin, building the forge for the worktree's origin, and the one locked
 * write that records a report and bumps `drain.rev`.
 *
 * Needs `zod` (through the run store), so it is only reached through a verb's
 * dynamic import.
 *
 * @module @dorkos/flow/cli/drain-run
 */

import type { DrainState } from '../drain/state.ts';
import { PreconditionError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import type { FlowStateFile } from '../flow-state-file.ts';
import { forgeTargetFor, type Forge } from '../forge/types.ts';
import type { ProcessResult, VerbContext } from './context.ts';

/** How long one `git ls-remote` may take. */
const LS_REMOTE_TIMEOUT_MS = 30_000;

/** A drain run this version of flow can write: a version-1 drain with a numeric `rev`. */
export type DrainRun = FlowRun & { drain: DrainState };

/**
 * Whether a run carries a drain this version understands. A newer flow's drain
 * is its writer's: never rewritten here.
 *
 * @param run - A run record.
 * @returns `true` for a `v: 1` drain with a numeric `rev`.
 */
export function isWritableDrain(run: FlowRun | undefined): run is DrainRun {
  return run?.drain?.v === 1 && typeof run.drain.rev === 'number';
}

/**
 * The drain run for `identifier`.
 *
 * @param store - The run store.
 * @param identifier - The item, e.g. `ACME-12`.
 * @param verb - The verb, for the message.
 * @returns The run.
 * @throws {PreconditionError} When no run carries a drain, or its drain is from a newer flow.
 */
export function findDrainRun(store: FlowStateFile, identifier: string, verb: string): DrainRun {
  const runs = Object.values(store.read()).filter(
    (run) => run.identifier === identifier && run.drain !== undefined
  );
  if (runs.length === 0) {
    throw new PreconditionError(
      `${identifier} has no drain run in ${store.path}; "flow ${verb}" records reports for runs "flow drain" started`
    );
  }
  const run = runs.find(isWritableDrain);
  if (run === undefined) {
    throw new PreconditionError(
      `the drain state of ${identifier} was written by a newer flow; update flow before running "flow ${verb}"`
    );
  }
  return run;
}

/**
 * Run git in `cwd`; a git that cannot start reads as a failed command.
 *
 * @param ctx - The verb context.
 * @param cwd - Where to run it.
 * @param args - git's arguments.
 * @param timeoutMs - The timeout, when not the default.
 * @returns The result.
 */
export async function git(
  ctx: VerbContext,
  cwd: string,
  args: readonly string[],
  timeoutMs?: number
): Promise<ProcessResult> {
  try {
    return await ctx.runProcess('git', args, { cwd, timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: -1, stdout: '', stderr: message };
  }
}

/**
 * The branch's head on origin (`git ls-remote origin refs/heads/<branch>`).
 *
 * @param ctx - The verb context.
 * @param worktree - The worktree to run git in.
 * @param branch - The branch.
 * @returns The SHA, or `null` when origin has no such branch.
 * @throws {PreconditionError} When origin cannot be read.
 */
export async function originHead(
  ctx: VerbContext,
  worktree: string,
  branch: string
): Promise<string | null> {
  const result = await git(
    ctx,
    worktree,
    ['ls-remote', 'origin', `refs/heads/${branch}`],
    LS_REMOTE_TIMEOUT_MS
  );
  if (result.code !== 0) {
    throw new PreconditionError(
      `could not read ${branch} from origin in ${worktree}: ${result.stderr.trim() || `git exited ${result.code}`}`
    );
  }
  return result.stdout.trim().split(/\s+/)[0] || null;
}

/**
 * The forge the worktree's `origin` lives on.
 *
 * @param ctx - The verb context.
 * @param worktree - The worktree to read `origin` from.
 * @returns The forge.
 * @throws {PreconditionError} When the worktree has no `origin`.
 * @throws {ConfigError} When origin is not on GitHub (exit 3).
 */
export async function originForge(ctx: VerbContext, worktree: string): Promise<Forge> {
  const result = await git(ctx, worktree, ['remote', 'get-url', 'origin']);
  if (result.code !== 0 || result.stdout.trim() === '') {
    throw new PreconditionError(`${worktree} has no origin remote`);
  }
  return ctx.forge(forgeTargetFor(result.stdout.trim(), ctx.env));
}

/**
 * A short SHA for messages.
 *
 * @param sha - A SHA, or `null`.
 * @returns Its first 7 characters, or `nothing` for `null`.
 */
export function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : 'nothing';
}

/**
 * Record a report on a drain run in one locked write, bumping `drain.rev` in
 * the same write (the supervisor's compare-and-set depends on it).
 *
 * `change` sees the drain as it is on disk under the lock and returns the new
 * drain, or `undefined` to write nothing (a report that turned stale between
 * the check and the write). It must be pure: it can run again on a retry.
 *
 * @param store - The run store.
 * @param run - The run, as read before the write.
 * @param change - The drain update.
 * @param retry - What to tell the person when the lock was busy.
 * @returns Whether the change was written.
 * @throws {PreconditionError} When the run lost its drain, or the lock stayed busy.
 */
export async function writeDrain(
  store: FlowStateFile,
  run: DrainRun,
  change: (drain: DrainState, current: DrainRun) => DrainState | undefined,
  retry: string
): Promise<boolean> {
  let outcome = 'gone' as 'written' | 'skipped' | 'gone';
  const result = await store.updateRun(run.issueId, (current) => {
    if (!isWritableDrain(current)) {
      outcome = 'gone';
      return current;
    }
    const next = change(current.drain, current);
    if (next === undefined) {
      outcome = 'skipped';
      return current;
    }
    outcome = 'written';
    return { ...current, drain: { ...next, rev: current.drain.rev + 1 } };
  });
  if (result.status === 'dropped') {
    throw new PreconditionError(
      `${store.path} stayed locked by another flow command, so nothing was recorded; ${retry}`
    );
  }
  if (outcome === 'gone') {
    throw new PreconditionError(
      `the run for ${run.identifier} no longer carries a drain this flow can write; nothing was recorded`
    );
  }
  return outcome === 'written';
}
