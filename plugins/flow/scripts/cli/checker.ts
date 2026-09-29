/**
 * The session that checks a floor question's pick (spec `flow-multiproject`
 * §7.5): stopping it, and removing its worktree, on every path that ends it.
 * The drain stops it once the question is settled or the checker stopped
 * without answering (it declined); `flow release`, `flow done` and a new `flow
 * ask` stop it too, so neither a session nor a worktree outlives its question.
 *
 * @module @dorkos/flow/cli/checker
 */

import { removeWorktree } from '../drain/worktree.ts';
import type { RunQuestion } from '../flow-run.ts';
import type { FlowStateFile } from '../flow-state-file.ts';
import { realLauncher } from '../launchers/real.ts';
import type { HostName, RuntimeName, SessionHandle } from '../launchers/types.ts';
import type { VerbContext } from './context.ts';

/** A recorded checker. */
export type Checker = NonNullable<RunQuestion['checker']>;

/**
 * Stop a checker session and remove its worktree. Never throws: a session
 * already gone is fine, and a failure is only warned about.
 *
 * @param ctx - The verb's context (its launcher factory, process runner, warnings).
 * @param mainCheckout - The project's main checkout, which owns the worktree.
 * @param checker - The recorded checker.
 */
export async function stopChecker(
  ctx: VerbContext,
  mainCheckout: string,
  checker: Checker
): Promise<void> {
  const host = checker.host as HostName;
  const handle: SessionHandle = {
    host,
    runtime: checker.runtime as RuntimeName,
    sessionId: checker.sessionId,
    account: checker.account ?? null,
    cwd: checker.cwd,
    ...(checker.pid === undefined ? {} : { pid: checker.pid }),
  };
  try {
    const launcher = ctx.createLauncher?.(host) ?? realLauncher(host, ctx.env, ctx.io.osHome);
    await launcher.stop(handle);
  } catch (error) {
    ctx.warn(`could not stop the pick checker ${checker.sessionId}: ${(error as Error).message}`);
  }
  const failed = await removeWorktree(ctx.runProcess, mainCheckout, checker.cwd);
  if (failed !== null) ctx.warn(`could not remove the pick checker's worktree: ${failed}`);
}

/**
 * Stop the run's checker, if it has one, and drop it from the question. The
 * check's token hash stays, so a declined check is not handed out again: the
 * question then waits for a person.
 *
 * @param ctx - The verb's context.
 * @param store - The run store.
 * @param mainCheckout - The project's main checkout.
 * @param issueId - The run's key.
 */
export async function retireChecker(
  ctx: VerbContext,
  store: FlowStateFile,
  mainCheckout: string,
  issueId: string
): Promise<void> {
  const checker = store.read()[issueId]?.question?.checker;
  if (checker === undefined) return;
  await stopChecker(ctx, mainCheckout, checker);
  await store.updateRun(issueId, (current) => {
    const q = current.question;
    if (q?.checker?.sessionId !== checker.sessionId) return current;
    const { checker: _gone, ...rest } = q;
    return { ...current, question: rest };
  });
}
