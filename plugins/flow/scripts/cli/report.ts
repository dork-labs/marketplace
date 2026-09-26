/**
 * `flow report <identifier> <pushed | verdict | blocked>` (spec
 * `flow-handoff-dispatch` §4.5): how a drain's worker and reviewer tell the
 * supervisor what happened. Every claim is checked against git before it is
 * recorded, and every record bumps `drain.rev` in the same locked write.
 *
 * - `pushed [--sha <sha>]` (worker): the SHA must be the branch head on origin
 *   and the run's last checkpoint. An armed PR is disarmed first, since the new
 *   commits are not reviewed yet.
 * - `verdict --sha <sha> --token <t> (--clean | --changes --findings-file <f>)`
 *   (reviewer): the token's SHA-256 must equal `drain.reviewer.tokenHash`, so
 *   only the reviewer whose brief carried the token can record a verdict. A
 *   verdict on a SHA other than the last push is stale: warned, not recorded.
 * - `blocked --question-file <f>` (worker): posts the question as a signed
 *   comment, applies the needs-input projection through the tracker adapter,
 *   and parks the run.
 *
 * @module @dorkos/flow/cli/report
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { PreconditionError, UsageError } from '../errors.ts';
import { openFlowStateFile } from '../flow-state-file.ts';
import { projectionFor } from '../work-state.ts';
import type { VerbContext, VerbResult } from './context.ts';
import {
  findDrainRun,
  git,
  originForge,
  originHead,
  short,
  writeDrain,
  type DrainRun,
} from './drain-run.ts';
import { signBody, unsignedBody } from './provenance.ts';
import { applyAndVerify, sessionProvenance, setupWrite } from './work-write.ts';

/** The report kinds, in help order. */
export const REPORT_KINDS = ['pushed', 'verdict', 'blocked'] as const;

/** How many of the latest comments are checked for an earlier post of the question. */
const RECENT_COMMENTS = 10;

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Refuse flags that belong to another report kind. */
function onlyFlags(ctx: VerbContext, kind: string, allowed: readonly string[]): void {
  const common = ['project', 'session'];
  for (const name of Object.keys(ctx.args.flags)) {
    if (!allowed.includes(name) && !common.includes(name)) {
      throw new UsageError(`"flow report ${kind}" does not take --${name}`);
    }
  }
}

/** Read a file named by a flag, relative to the working directory. */
function readFlagFile(ctx: VerbContext, name: string): string {
  const value = flag(ctx, name);
  if (value === undefined) throw new UsageError(`--${name} <file> is required`);
  try {
    return readFileSync(path.resolve(ctx.cwd, value), 'utf8');
  } catch {
    throw new UsageError(`cannot read --${name} ${value}`);
  }
}

/**
 * The SHA-256 of a verdict token, hex. The supervisor stores only this; the
 * token itself lives only in the reviewer's brief.
 *
 * @param token - The plaintext token.
 * @returns Its hash, lowercase hex.
 */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether `token` hashes to `expected`, compared in constant time. */
function tokenMatches(token: string, expected: string | undefined): boolean {
  if (expected === undefined) return false;
  const actual = Buffer.from(tokenHash(token), 'utf8');
  const wanted = Buffer.from(expected.toLowerCase(), 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** `flow report pushed`. */
async function pushed(ctx: VerbContext, run: DrainRun): Promise<VerbResult> {
  onlyFlags(ctx, 'pushed', ['sha']);
  const worktree = run.worktreePath;
  const asked = flag(ctx, 'sha') ?? 'HEAD';
  const resolved = await git(ctx, worktree, ['rev-parse', '--verify', `${asked}^{commit}`]);
  if (resolved.code !== 0) {
    throw new PreconditionError(`${asked} is not a commit in ${worktree}`);
  }
  const sha = resolved.stdout.trim();
  const remote = await originHead(ctx, worktree, run.branch);
  if (remote !== sha) {
    throw new PreconditionError(
      `push first: origin has ${run.branch} at ${short(remote)}, not ${short(sha)}`
    );
  }
  if (run.checkpointSha !== sha) {
    throw new PreconditionError(
      `write a checkpoint at this commit first: flow checkpoint ${run.identifier} --trigger task --task <task>, or --trigger fix for a review or CI fix (the last checkpoint is at ${short(run.checkpointSha)})`
    );
  }

  // Disarm before recording: an armed PR could merge commits nobody reviewed.
  const pr = run.drain.pr;
  const disarm = pr !== null && pr.armed;
  if (disarm) await (await originForge(ctx, worktree)).disarm(pr.number);

  await writeDrain(
    openFlowStateFile(ctx.projectDir),
    run,
    (drain) => ({
      ...drain,
      pushedSha: sha,
      pr:
        disarm && drain.pr !== null && drain.pr.number === pr.number
          ? { ...drain.pr, armed: false, disarmedForReview: true }
          : drain.pr,
    }),
    `run "flow report ${run.identifier} pushed" again`
  );
  return {
    json: { ok: true, identifier: run.identifier, report: 'pushed', sha, disarmed: disarm },
    text: `Recorded the push of ${short(sha)} for ${run.identifier}${disarm ? `; disarmed auto-merge on #${pr.number} until it is reviewed` : ''}.`,
  };
}

/** `flow report verdict`. */
async function verdict(ctx: VerbContext, run: DrainRun): Promise<VerbResult> {
  onlyFlags(ctx, 'verdict', ['sha', 'token', 'clean', 'changes', 'findings-file']);
  const sha = flag(ctx, 'sha')?.toLowerCase();
  if (sha === undefined) throw new UsageError('--sha <sha> is required: the commit you reviewed');
  const clean = ctx.args.flags.clean === true;
  const changes = ctx.args.flags.changes === true;
  if (clean === changes) throw new UsageError('pass exactly one of --clean or --changes');
  if (clean && flag(ctx, 'findings-file') !== undefined) {
    throw new UsageError('--findings-file goes with --changes, not --clean');
  }
  const findings = changes ? readFlagFile(ctx, 'findings-file') : undefined;
  const token = flag(ctx, 'token');
  const refuse = () =>
    new PreconditionError(
      `this verdict's token does not match the review flow started for ${run.identifier}; only the reviewer's brief carries it`
    );
  if (token === undefined || !tokenMatches(token, run.drain.reviewer?.tokenHash)) throw refuse();

  const staleResult = (pushedSha: string | null): VerbResult => {
    ctx.warn(
      `the review of ${short(sha)} is stale: the last push is ${short(pushedSha)}, so the verdict was not recorded`
    );
    return {
      json: { ok: true, identifier: run.identifier, report: 'verdict', sha, stale: true },
      text: `Ignored a stale verdict on ${short(sha)} for ${run.identifier}.`,
    };
  };
  if (sha !== run.drain.pushedSha) return staleResult(run.drain.pushedSha);

  const round = run.drain.reviewRound + 1;
  let findingsPath: string | null = null;
  if (findings !== undefined) {
    findingsPath = path.join(
      run.worktreePath,
      '.dork',
      'flow',
      'drain',
      'reviews',
      `${round}-${sha.slice(0, 7)}.md`
    );
    mkdirSync(path.dirname(findingsPath), { recursive: true });
    copyFileSync(path.resolve(ctx.cwd, flag(ctx, 'findings-file') as string), findingsPath);
  }

  let tokenGone = false;
  let pushedNow: string | null = run.drain.pushedSha;
  const written = await writeDrain(
    openFlowStateFile(ctx.projectDir),
    run,
    (drain) => {
      // Re-checked under the lock: a new review or push may have landed since the read.
      tokenGone = !tokenMatches(token, drain.reviewer?.tokenHash);
      pushedNow = drain.pushedSha;
      if (tokenGone || drain.pushedSha !== sha) return undefined;
      return {
        ...drain,
        verdict: clean ? 'clean' : 'changes',
        reviewedSha: sha,
        reviewRound: drain.reviewRound + 1,
      };
    },
    `run the same "flow report ${run.identifier} verdict" again`
  );
  if (tokenGone) throw refuse();
  if (!written) return staleResult(pushedNow);
  return {
    json: {
      ok: true,
      identifier: run.identifier,
      report: 'verdict',
      sha,
      verdict: clean ? 'clean' : 'changes',
      round,
      findings: findingsPath,
    },
    text: `Recorded a ${clean ? 'CLEAN' : 'CHANGES'} verdict on ${short(sha)} for ${run.identifier} (round ${round}).`,
  };
}

/** The first line of the question, for `parkedReason`. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const trimmed = line.trim().replace(/^#+\s*/, '');
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/** `flow report blocked`. */
async function blocked(ctx: VerbContext, run: DrainRun): Promise<VerbResult> {
  onlyFlags(ctx, 'blocked', ['question-file']);
  const question = readFlagFile(ctx, 'question-file').trimEnd();
  if (question.trim() === '') throw new UsageError('the question file is empty');

  const { loaded, stages, adapter, store } = await setupWrite(ctx, [
    'getItem',
    'applyWorkState',
    'comment',
  ]);
  const item = await adapter.getItem(run.identifier, { comments: RECENT_COMMENTS });
  const body = signBody(question, loaded.config.identity.marker, sessionProvenance(ctx, run.host));
  const unsigned = unsignedBody(body);
  const alreadyPosted = (item.comments ?? [])
    .slice(-RECENT_COMMENTS)
    .some((comment) => unsignedBody(comment.body) === unsigned);
  if (!alreadyPosted) await adapter.comment(item, body);
  await applyAndVerify(adapter, item, projectionFor({ type: 'needs-input' }, { stages }));

  const reason = `the worker asked a question: ${firstLine(question)}`;
  await writeDrain(
    store,
    run,
    (drain) => ({
      ...drain,
      phase: 'parked',
      parkedReason: reason,
      parkedFrom: drain.phase === 'parked' ? (drain.parkedFrom ?? null) : drain.phase,
    }),
    `run "flow report ${run.identifier} blocked" again (the question is posted, so it will not be posted twice)`
  );
  return {
    json: {
      ok: true,
      identifier: run.identifier,
      report: 'blocked',
      commented: !alreadyPosted,
      parkedReason: reason,
    },
    text: `Posted the question on ${run.identifier} and parked the run until a person answers.`,
  };
}

/**
 * Run `flow report`.
 *
 * @param ctx - The verb's context.
 * @returns What was recorded.
 * @throws {UsageError} On an unknown kind or wrong flags (exit 2).
 * @throws {PreconditionError} When the claim does not hold (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier, kind] = ctx.args.positionals;
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`the report must be one of ${REPORT_KINDS.join(', ')}, not "${kind}"`);
  }
  const drainRun = findDrainRun(openFlowStateFile(ctx.projectDir), identifier, 'report');
  if (kind === 'pushed') return pushed(ctx, drainRun);
  if (kind === 'verdict') return verdict(ctx, drainRun);
  return blocked(ctx, drainRun);
}
