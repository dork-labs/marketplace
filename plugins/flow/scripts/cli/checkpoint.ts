/**
 * `flow checkpoint <identifier> --trigger <t> --body-file <f> [--task <id>]
 * [--spec <path>] [--stage <stage>]` (spec `flow-handoff-dispatch` §1).
 *
 * Writes the item's `HANDOFF.md` in the worktree at `--project` (default the
 * current folder): the agent supplies the body, and the verb measures the
 * header from git, the flags and the run record, so no fact in it can drift
 * from the worktree. When a run record exists, the verb then sets its
 * `checkpointAt` and `checkpointSha` and, for a drain run, bumps `drain.rev`,
 * all in one locked write.
 *
 * No tracker is read: the title line carries the identifier alone until the
 * code adapter can supply the item's title (see {@link titleFor}).
 *
 * @module @dorkos/flow/cli/checkpoint
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CHECKPOINT_TRIGGERS,
  checkBody,
  ensureCheckpointExcludes,
  renderCheckpoint,
  writeCheckpointFile,
  type CheckpointHeader,
  type CheckpointTrigger,
} from '../drain/checkpoint.ts';
import { PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun, FlowStage } from '../flow-run.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import { FlowRunSchema } from '../flow-state.ts';
import type { ProcessResult, VerbContext, VerbResult } from './context.ts';

/** How long `git ls-remote` may take before the pushed SHA is recorded as unknown. */
const LS_REMOTE_TIMEOUT_MS = 30_000;

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Run git in `cwd`; a git that cannot start reads as a failed command. */
async function git(
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

/** The worktree's top-level folder, or a precondition error. */
async function worktreeRoot(ctx: VerbContext): Promise<string> {
  const result = await git(ctx, ctx.projectDir, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0 || result.stdout.trim() === '') {
    throw new PreconditionError(
      `${ctx.projectDir} is not a git worktree; run flow checkpoint in the item's worktree, or pass --project`
    );
  }
  return result.stdout.trim();
}

/** The measured git facts for the header. */
interface GitFacts {
  branch: string;
  headSha: string;
  pushedSha: string | null;
  dirty: boolean;
}

/** Measure branch, HEAD, the pushed SHA on origin and whether the tree is dirty. */
async function gitFacts(ctx: VerbContext, root: string): Promise<GitFacts> {
  const head = await git(ctx, root, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    throw new PreconditionError(`${root} has no commit yet; commit before writing a checkpoint`);
  }
  const branch = (await git(ctx, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const status = await git(ctx, root, ['status', '--porcelain']);
  if (status.code !== 0) {
    throw new PreconditionError(`git status failed in ${root}: ${status.stderr.trim()}`);
  }
  const remote = await git(
    ctx,
    root,
    ['ls-remote', 'origin', `refs/heads/${branch}`],
    LS_REMOTE_TIMEOUT_MS
  );
  let pushedSha: string | null = null;
  if (remote.code === 0) {
    pushedSha = remote.stdout.trim().split(/\s+/)[0] || null;
  } else {
    ctx.warn(
      `could not read the branch from origin (${remote.stderr.trim() || `git exited ${remote.code}`}); the checkpoint records it as not pushed`
    );
  }
  return { branch, headSha: head.stdout.trim(), pushedSha, dirty: status.stdout.trim() !== '' };
}

/**
 * The run record for `identifier`, preferring the one whose worktree is this
 * one when a project holds more than one.
 */
function findRun(
  runs: Record<string, FlowRun>,
  identifier: string,
  root: string
): FlowRun | undefined {
  const matches = Object.values(runs).filter((run) => run.identifier === identifier);
  return matches.find((run) => path.resolve(run.worktreePath) === root) ?? matches[0];
}

/**
 * The item's title for the `# Handoff:` line. This is the seam for the
 * tracker: once the code adapter lands, the title comes from its `getItem`
 * when the tracker is reachable. Until then there is no title source, and the
 * line carries the identifier alone.
 */
function titleFor(): string | null {
  return null;
}

/**
 * Run `flow checkpoint`.
 *
 * @param ctx - The verb context.
 * @returns `{ path, header }` for `--json`, and one line of text.
 * @throws {UsageError} On a missing or unknown flag value (exit 2).
 * @throws {PreconditionError} Outside a git worktree, or for a body that breaks a rule (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const identifier = ctx.args.positionals[0];
  const trigger = flag(ctx, 'trigger');
  if (trigger === undefined || !(CHECKPOINT_TRIGGERS as readonly string[]).includes(trigger)) {
    throw new UsageError(`--trigger must be one of: ${CHECKPOINT_TRIGGERS.join(', ')}`);
  }
  const task = flag(ctx, 'task') ?? null;
  if (trigger === 'task' && task === null) {
    throw new UsageError('--trigger task needs --task <id>: the task this checkpoint follows');
  }
  const stageFlag = flag(ctx, 'stage');
  if (stageFlag !== undefined && !FlowRunSchema.shape.stage.safeParse(stageFlag).success) {
    throw new UsageError(`--stage "${stageFlag}" is not a flow stage`);
  }
  const bodyFlag = flag(ctx, 'body-file');
  if (bodyFlag === undefined) {
    throw new UsageError(
      '--body-file is required: the Done, Next, Open questions and Next command sections'
    );
  }
  let body: string;
  try {
    body = readFileSync(path.resolve(ctx.projectDir, bodyFlag), 'utf8');
  } catch {
    throw new UsageError(`cannot read --body-file ${bodyFlag}`);
  }
  const checked = checkBody(body);
  if (!checked.ok) throw new PreconditionError(`checkpoint refused: ${checked.message}`);

  const root = await worktreeRoot(ctx);
  const store = openFlowStateFile(root);
  const existing = findRun(store.read(), identifier, root);
  const stage = (stageFlag as FlowStage | undefined) ?? existing?.stage;
  if (stage === undefined) {
    throw new UsageError(
      `there is no run record for ${identifier}; pass --stage <stage> to say where the next session resumes`
    );
  }

  // Before measuring: an excluded HANDOFF.md must not count as a dirty tree.
  ensureCheckpointExcludes(root);
  const facts = await gitFacts(ctx, root);
  const header: CheckpointHeader = {
    v: 1,
    identifier,
    stage,
    trigger: trigger as CheckpointTrigger,
    writtenAt: ctx.now().toISOString(),
    sessionId: ctx.sessionId ?? existing?.sessionId ?? null,
    account: existing?.account ?? null,
    host: existing?.host ?? null,
    branch: facts.branch,
    headSha: facts.headSha,
    pushedSha: facts.pushedSha,
    dirty: facts.dirty,
    spec: flag(ctx, 'spec') ?? null,
    task,
    pr: existing?.drain?.pr?.url ?? null,
    reviewRound: existing?.drain?.reviewRound ?? null,
  };
  const rendered = renderCheckpoint(header, titleFor(), body);
  if (!rendered.ok) throw new PreconditionError(`checkpoint refused: ${rendered.message}`);
  const file = writeCheckpointFile(root, rendered.text);

  if (existing !== undefined) {
    const result = await store.updateRun(existing.issueId, (current) => ({
      ...current,
      checkpointAt: header.writtenAt,
      checkpointSha: header.headSha,
      // Bump rev only on a drain this version understands; a newer drain's
      // fields are its writer's, never NaN-ed here.
      ...(current.drain?.v === 1 && typeof current.drain.rev === 'number'
        ? { drain: { ...current.drain, rev: current.drain.rev + 1 } }
        : {}),
    }));
    for (const warning of result.warnings) ctx.warn(warning.message);
    if (result.status === 'dropped') {
      ctx.warn(
        `the checkpoint is written, but the run record for ${identifier} was not updated; run flow checkpoint again`
      );
    }
  }

  const short = header.headSha.slice(0, 7);
  const dirty = header.dirty ? ', with uncommitted changes' : '';
  return {
    json: { path: file, header },
    text: `Wrote ${path.relative(root, file)} for ${identifier} (${trigger}, at ${short}${dirty}).`,
  };
}
