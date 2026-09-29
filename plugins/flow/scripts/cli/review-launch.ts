/**
 * `flow report <identifier> review-launch --sha <sha>` (spec
 * `flow-multiproject` §7.5): VERIFY starts its adversarial reviewer as a
 * session of its own, the way `flow drain` starts its code reviewer, so the
 * reviewer's verdict is token-bound and comes from a session other than the
 * one that wrote the code.
 *
 * It mints the review's token, stores only its hash on the run (`review`),
 * adds a detached worktree at `sha` for the reviewer (never the author's), writes
 * the reviewer's brief there (the only place the token appears), and starts the
 * session through the launcher. The caller gets the session's id, never the
 * token. A launch that fails leaves nothing behind: the review claim and the
 * worktree are removed, and the command exits with the reason.
 *
 * What it does not close: the author could read the brief from the reviewer's
 * worktree. The spec records that residual (§7.5).
 *
 * @module @dorkos/flow/cli/review-launch
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { findConfigRoots } from '../config-files.ts';
import { loadConfig } from '../config-load.ts';
import { renderBrief } from '../drain/briefs.ts';
import { removeWorktree, reviewBase, reviewWorktreePath } from '../drain/worktree.ts';
import { FlowError, PreconditionError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import { parseOriginRepo, resolveDorkHome } from '../fleet/accounts.ts';
import { realLauncher } from '../launchers/real.ts';
import { hostPreference, resolveHost } from '../launchers/resolve.ts';
import {
  HOST_NAMES,
  LaunchError,
  type HostName,
  type LaunchPermissionMode,
  type ProbeResult,
  type RuntimeName,
} from '../launchers/types.ts';
import { resolveMainCheckout } from '../main-checkout.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { tokenHash } from './report.ts';

/** Where the VERIFY reviewer's brief goes inside its own worktree. */
export const VERIFY_BRIEF_PATH = path.join('.dork', 'flow', 'review', 'brief.md');

/** Where the VERIFY reviewer writes its findings inside its own worktree. */
export const VERIFY_FINDINGS_PATH = path.join('.dork', 'flow', 'review', 'findings.md');

/**
 * Start VERIFY's reviewer in a session of its own.
 *
 * @param ctx - The verb's context.
 * @param run - The run (not a drain run).
 * @param sha - The full commit to review.
 * @returns The started session.
 * @throws {PreconditionError} When the worktree cannot be added or the session does not start.
 */
export async function reviewLaunch(
  ctx: VerbContext,
  run: FlowRun,
  sha: string
): Promise<VerbResult> {
  const { config } = loadConfig(findConfigRoots(ctx.projectDir, ctx.flowRoot), ctx.env, {
    now: () => ctx.now(),
  });
  const mainCheckout = resolveMainCheckout(ctx.projectDir);
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const origin = await ctx.runProcess('git', ['remote', 'get-url', 'origin'], {
    cwd: mainCheckout,
  });
  const repo = origin.code === 0 ? parseOriginRepo(origin.stdout) : null;
  const repoName = repo?.split('/').pop() ?? path.basename(mainCheckout);
  const target = reviewWorktreePath(dorkHome, repoName, run.identifier, sha);
  const runtime = (run.runtime ?? 'claude-code') as RuntimeName;

  const token = randomBytes(16).toString('hex');
  const hash = tokenHash(token);
  const store = openFlowStateFile(ctx.projectDir, { now: ctx.now });
  const claimed = await store.updateRun(run.issueId, (current) => ({
    ...current,
    review: { tokenHash: hash, sha, verdict: null, reviewedSha: null },
  }));
  if (claimed.status === 'dropped') {
    throw new PreconditionError(
      `${store.path} stayed locked by another flow command, so no review was started; run the same command again`
    );
  }
  const flow = `node --experimental-strip-types ${path.join(ctx.flowRoot, 'scripts', 'flow.ts')}`;
  // Only a worktree this call adds is removed on failure: one that was already
  // there (an earlier launch's, a live reviewer's) is someone else's.
  let created = false;
  try {
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      const added = await ctx.runProcess(
        'git',
        ['worktree', 'add', '-q', '--detach', target, sha],
        { cwd: mainCheckout }
      );
      if (added.code !== 0) {
        throw new PreconditionError(
          `could not add the reviewer's worktree at ${target}: ${added.stderr.trim()}`
        );
      }
      created = true;
    }
    const findingsFile = path.join(target, VERIFY_FINDINGS_PATH);
    const brief = renderBrief(ctx.flowRoot, 'reviewer', {
      identifier: run.identifier,
      sha,
      base: await reviewBase(ctx.runProcess, target, sha),
      deltaFrom: 'This is the VERIFY review of this item, before its pull request opens.',
      rubric: config.review.rubric,
      flow,
      findingsFile,
      token,
    });
    const promptFile = path.join(target, VERIFY_BRIEF_PATH);
    mkdirSync(path.dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, brief);

    const pref = hostPreference(undefined, config.drain.host);
    const probes = {} as Record<HostName, ProbeResult>;
    const launcherFor = (host: HostName) =>
      ctx.createLauncher?.(host) ?? realLauncher(host, ctx.env, ctx.io.osHome);
    for (const name of HOST_NAMES) {
      const made = launcherFor(name);
      const support = made.supports(runtime);
      probes[name] = support.ok ? await made.probe(runtime) : support;
    }
    const host = resolveHost(pref, ctx.env, probes, runtime).host;
    const reviewModel = config.models.bindings[config.models.tiers.review];
    const handle = await launcherFor(host).start({
      role: 'reviewer',
      runtime,
      identifier: run.identifier,
      account: null,
      cwd: target,
      promptFile,
      sessionId: randomUUID(),
      ...(reviewModel ? { model: reviewModel } : {}),
      permissionMode: config.drain.permissionMode as LaunchPermissionMode,
      title: `${run.identifier} VERIFY reviewer`,
    });
    await store.updateRun(run.issueId, (current) =>
      current.review?.tokenHash !== hash
        ? current
        : {
            ...current,
            review: {
              ...current.review,
              reviewer: {
                host: handle.host,
                runtime: handle.runtime,
                sessionId: handle.sessionId,
                account: handle.account,
                ...(handle.pid === undefined ? {} : { pid: handle.pid }),
                cwd: target,
              },
            },
          }
    );
    return {
      json: {
        ok: true,
        identifier: run.identifier,
        report: 'review-launch',
        sha,
        host: handle.host,
        session: handle.sessionId,
        worktree: target,
      },
      text: `Started an independent reviewer of ${sha.slice(0, 7)} for ${run.identifier} in its own session (${handle.host}); it records its verdict with flow report verdict.`,
    };
  } catch (error) {
    // Nothing is left behind: the review is not started, and the next try starts anew.
    await store.updateRun(run.issueId, (current) => {
      if (current.review?.tokenHash !== hash) return current;
      const { review: _review, ...rest } = current;
      return rest;
    });
    if (created) await removeWorktree(ctx.runProcess, mainCheckout, target);
    if (error instanceof LaunchError || error instanceof FlowError) {
      throw new PreconditionError(
        `the reviewer did not start (${error.message}); nothing was recorded, so run the same command again`
      );
    }
    throw error;
  }
}
