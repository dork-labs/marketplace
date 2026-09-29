/**
 * `flow review <identifier>` (spec `flow-multiproject` §7.5): record a verdict
 * at the review gate, the check before finished work ships.
 *
 * `--approve [--by person | reviewer-agent]`:
 *
 * 1. Comments on the item: from a person, as the person (no agent marker),
 *    "Shipped from DorkOS."; from the reviewer agent, signed, "Shipped: the
 *    reviewer agent approved it (clean review at <sha7>)."
 * 2. With an open PR and a person's approval: approves it on the forge (when
 *    the signed-in account did not write it; else the tracker comment is the
 *    approval of record). The reviewer agent never approves on the forge.
 * 3. When `gates.review.mergeOnApproval` is on, arms the PR at its head, so it
 *    merges when its checks pass. Otherwise a person merges it.
 * 4. Journals `operator.wait` end (a person) or `review.approved` (the reviewer
 *    agent).
 *
 * `--by reviewer-agent` is refused unless the project's "Ship finished work"
 * stop is not Ask me first, `review.adversarial` is on, a token-bound clean
 * verdict exists at the branch's head on the forge (`flow report verdict`,
 * drain or VERIFY), and the PR's checks pass. A verdict written any other way
 * is not a verdict.
 *
 * `--changes (--note <text> | --note-file <file>)`: comments "Sent back: <note>"
 * as the person, requests changes on the PR (a plain comment when the forge
 * refuses a review of one's own PR), and sends the work back: a drain run gets a
 * CHANGES verdict with the note as its finding, so the drain hands it to its
 * worker; any other run moves to `execute` and keeps its session. Nothing is
 * closed, released or reassigned.
 *
 * It refuses (exit 5) an item that is not at the review gate.
 *
 * @module @dorkos/flow/cli/review
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { stopInForce } from '../autonomy.ts';
import { ConfigError, PreconditionError, UsageError } from '../errors.ts';
import type { FlowRun } from '../flow-run.ts';
import type { Forge, ReviewOutcome } from '../forge/types.ts';
import { reviewFindingsPath } from '../drain/messages.ts';
import { MAX_ANSWER_LENGTH } from '../question.ts';
import { projectionFor } from '../work-state.ts';
import { recordEvent } from './auto-journal.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { isWritableDrain, originForge, short, writeDrain } from './drain-run.ts';
import { signBody } from './provenance.ts';
import {
  applyAndVerify,
  requireOpen,
  requireStored,
  runFor,
  sessionProvenance,
  setupWrite,
} from './work-write.ts';

/** Who approves at the review gate. */
type Approver = 'person' | 'reviewer-agent';

/** The drain phases in which a drain run's work waits at the review gate (a clean review, a PR). */
const GATE_PHASES = new Set(['pr-ready', 'watching']);

/** A string flag's value, if given. */
function flag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether a run waits at the review gate: its stage is `review`, or it is a
 * drain run whose work passed its review and has a PR (or is about to).
 *
 * @param run - The run.
 * @returns `true` at the gate.
 */
export function atReviewGate(run: FlowRun): boolean {
  if (run.stage === 'review') return true;
  return run.drain !== undefined && GATE_PHASES.has(run.drain.phase);
}

/**
 * The commit a token-bound clean verdict covers, or `null` when there is none:
 * a drain run's reviewer (`drain.verdict`) or VERIFY's (`review.verdict`),
 * both recorded only through `flow report verdict` with the reviewer's token.
 *
 * @param run - The run.
 * @returns The reviewed commit of a clean verdict, or `null`.
 */
export function cleanVerdictSha(run: FlowRun): string | null {
  if (run.drain?.verdict === 'clean' && run.drain.reviewedSha) return run.drain.reviewedSha;
  if (run.review?.verdict === 'clean' && run.review.reviewedSha) return run.review.reviewedSha;
  return null;
}

/** The note from `--note` or `--note-file`. */
function noteOf(ctx: VerbContext): string {
  const note = flag(ctx, 'note');
  const file = flag(ctx, 'note-file');
  if ((note === undefined) === (file === undefined)) {
    throw new UsageError('say what should change with exactly one of --note or --note-file');
  }
  let value = note;
  if (file !== undefined) {
    try {
      value = readFileSync(path.resolve(ctx.cwd, file), 'utf8');
    } catch {
      throw new UsageError(`cannot read --note-file ${file}`);
    }
  }
  const trimmed = (value ?? '').trim();
  if (trimmed === '') throw new UsageError('the note is empty: say what should change');
  if (trimmed.length > MAX_ANSWER_LENGTH) {
    throw new UsageError(`the note is longer than ${MAX_ANSWER_LENGTH} characters`);
  }
  return trimmed;
}

/** The forge for the run's repository, or `null` with the reason when there is none. */
async function forgeFor(
  ctx: VerbContext,
  run: FlowRun
): Promise<{ forge: Forge; why: null } | { forge: null; why: string }> {
  const worktree = run.worktreePath !== '' ? run.worktreePath : ctx.projectDir;
  try {
    return { forge: await originForge(ctx, worktree), why: null };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PreconditionError) {
      return { forge: null, why: error.message };
    }
    throw error;
  }
}

/**
 * Run `flow review`.
 *
 * @param ctx - The verb's context.
 * @returns What was recorded, commented and done on the forge.
 * @throws {UsageError} On wrong flags or an empty note (exit 2).
 * @throws {PreconditionError} When the item is not at the review gate, or the
 *   reviewer agent may not answer it (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [identifier] = ctx.args.positionals;
  const approve = ctx.args.flags.approve === true;
  const changes = ctx.args.flags.changes === true;
  if (approve === changes) throw new UsageError('pass exactly one of --approve or --changes');
  const byFlag = flag(ctx, 'by') ?? 'person';
  if (byFlag !== 'person' && byFlag !== 'reviewer-agent') {
    throw new UsageError(`--by must be person or reviewer-agent, not "${byFlag}"`);
  }
  const by = byFlag as Approver;
  if (changes && by !== 'person') {
    throw new UsageError(
      'only a person sends work back with flow review; the reviewer agent reports its findings with flow report verdict'
    );
  }
  if (approve && (flag(ctx, 'note') !== undefined || flag(ctx, 'note-file') !== undefined)) {
    throw new UsageError('--note and --note-file go with --changes');
  }
  const note = changes ? noteOf(ctx) : null;

  const setup = await setupWrite(ctx, ['getItem', 'applyWorkState', 'comment']);
  const { loaded, stages, adapter, store } = setup;
  const { config } = loaded;
  const item = await adapter.getItem(identifier);
  requireOpen(item, 'review');
  const existing = runFor(store, item);
  if (existing === undefined || !atReviewGate(existing)) {
    throw new PreconditionError(
      `${identifier} is not waiting at the review gate${existing === undefined ? ' (it has no run on this machine)' : ` (it is at ${existing.stage})`}, so there is nothing to ship or send back`
    );
  }

  const target = await forgeFor(ctx, existing);
  const pr = target.forge === null ? null : await target.forge.prForBranch(existing.branch);
  const marker = config.identity.marker;

  if (approve) {
    let head: string | null = null;
    let sha: string | null = null;
    if (by === 'reviewer-agent') {
      const read = loaded.autonomy;
      const stop =
        read === null
          ? 'ask'
          : stopInForce(read, 'ship', { reviewerAgent: config.review.adversarial });
      if (stop === 'ask') {
        throw new PreconditionError(
          config.review.adversarial
            ? `this project's settings ask you before finished work ships (Ship finished work: Ask me first), so the reviewer agent cannot ship ${identifier}`
            : `no reviewer agent checks this repo's work (review.adversarial is off), so only a person can ship ${identifier}`
        );
      }
      if (target.forge === null) {
        throw new PreconditionError(
          `the reviewer agent can only ship a branch it can check on the forge: ${target.why}`
        );
      }
      head = await target.forge.branchHead(existing.branch);
      sha = cleanVerdictSha(existing);
      if (head === null || sha === null || sha.toLowerCase() !== head.toLowerCase()) {
        throw new PreconditionError(
          `${identifier} has no clean review recorded with the reviewer's token at the branch head (${short(head)}); the reviewer agent ships only work it checked`
        );
      }
      // Only checks that passed: none failing, none still running, and a PR
      // whose checks the forge can read at all.
      if (pr === null) {
        throw new PreconditionError(
          `${identifier} has no open PR, so there are no checks the reviewer agent can see pass`
        );
      }
      const status = await target.forge.prStatus(pr.number);
      if (status.failing.length > 0) {
        throw new PreconditionError(
          `${identifier}'s PR has failing checks (${status.failing.map((c) => c.name).join(', ')}), so the reviewer agent does not ship it`
        );
      }
      if (status.pendingChecks !== 0) {
        throw new PreconditionError(
          `${identifier}'s PR has checks that have not passed yet${status.pendingChecks === undefined ? '' : ` (${status.pendingChecks} still running)`}, so the reviewer agent waits`
        );
      }
    }

    // What to arm: the commit that was approved, never whatever the head is now.
    // The reviewer agent approved the head it checked; a drain run's person
    // approves its reviewed commit; any other run, the head the person names
    // with --head. A PR whose head moved since is refused before anything is posted.
    let armAt: string | null = null;
    const willArm = pr !== null && target.forge !== null && config.gates.review.mergeOnApproval;
    if (willArm && pr !== null && target.forge !== null) {
      armAt =
        by === 'reviewer-agent'
          ? head
          : isWritableDrain(existing)
            ? existing.drain.reviewedSha
            : (flag(ctx, 'head') ?? null);
      if (armAt !== null) {
        const now = (await target.forge.prStatus(pr.number)).headSha;
        if (!now.toLowerCase().startsWith(armAt.toLowerCase()) && now !== armAt) {
          throw new PreconditionError(
            `${identifier}'s PR moved to ${short(now)} since ${short(armAt)} was approved; review the new commits, then ship again`
          );
        }
        armAt = now;
      }
    }

    const body =
      by === 'person'
        ? 'Shipped from DorkOS.'
        : signBody(
            `Shipped: the reviewer agent approved it (clean review at ${short(sha)}).`,
            marker,
            sessionProvenance(ctx, existing.host)
          );
    let forgeReview: ReviewOutcome | null = null;
    let armed = false;
    if (!ctx.dryRun) {
      await adapter.comment(item, body);
      if (pr !== null && target.forge !== null) {
        if (by === 'person') {
          forgeReview = await target.forge.review(pr.number, {
            event: 'approve',
            body: 'Shipped from DorkOS.',
          });
        }
        if (armAt !== null) {
          await target.forge.arm(pr.number, armAt);
          armed = true;
        }
      }
      recordEvent(
        ctx,
        by === 'person'
          ? { kind: 'operator.wait', phase: 'end', item: identifier }
          : {
              kind: 'review.approved',
              by: 'reviewer-agent',
              ...(sha !== null && /^[0-9a-f]{7}/.test(sha) ? { sha7: sha.slice(0, 7) } : {}),
              item: identifier,
            }
      );
    }
    const armText = armed
      ? ` Armed PR #${pr?.number} to merge when its checks pass.`
      : pr !== null && !config.gates.review.mergeOnApproval
        ? ` PR #${pr.number} waits for a person to merge it.`
        : willArm
          ? ` PR #${pr?.number} was not armed: flow does not know which commit you approved (pass --head <sha>), so a person merges it.`
          : '';
    return {
      json: {
        ok: true,
        dryRun: ctx.dryRun,
        identifier,
        verdict: 'approved',
        by,
        pr: pr === null ? null : { number: pr.number, url: pr.url },
        forgeReview,
        armed,
        forgeSkipped: target.forge === null ? target.why : null,
      },
      text: `${ctx.dryRun ? 'Would ship' : 'Shipped'} ${identifier}${by === 'reviewer-agent' ? ' (the reviewer agent approved it)' : ''}.${armText}`,
    };
  }

  // --changes: a person sends the work back.
  const text = note as string;
  let forgeReview: ReviewOutcome | null = null;
  const sentBackTo: 'drain' | 'execute' = isWritableDrain(existing) ? 'drain' : 'execute';
  if (isWritableDrain(existing) && existing.drain.pushedSha === null) {
    throw new PreconditionError(
      `${identifier}'s drain run has pushed nothing yet, so there is no work to send back`
    );
  }
  if (!ctx.dryRun) {
    await adapter.comment(item, `Sent back: ${text}`);
    if (pr !== null && target.forge !== null) {
      forgeReview = await target.forge.review(pr.number, { event: 'request-changes', body: text });
    }
    if (isWritableDrain(existing)) {
      const pushed = existing.drain.pushedSha as string;
      if (existing.drain.pr?.armed && target.forge !== null) {
        await target.forge.disarm(existing.drain.pr.number);
      }
      const round = existing.drain.reviewRound + 1;
      const findings = path.join(existing.worktreePath, reviewFindingsPath(round, pushed));
      mkdirSync(path.dirname(findings), { recursive: true });
      writeFileSync(findings, `# Sent back by a person\n\n${text}\n`);
      await writeDrain(
        store,
        existing,
        (drain) => ({
          ...drain,
          // Through the drain's own transition: `reviewing` with a CHANGES
          // verdict at the pushed commit sends the worker the findings.
          phase: 'reviewing',
          verdict: 'changes',
          reviewedSha: pushed,
          reviewRound: drain.reviewRound + 1,
          pr:
            drain.pr !== null && drain.pr.armed
              ? { ...drain.pr, armed: false, disarmedForReview: true }
              : drain.pr,
        }),
        `run the same "flow review ${identifier} --changes" again (the note is posted)`
      );
    } else {
      await applyAndVerify(
        adapter,
        item,
        projectionFor({ type: 'stage', stage: 'execute' }, { stages })
      );
      const written = await store.setRunStage(item.id, 'execute');
      requireStored(written.status, store.path, `run "flow stage ${identifier} execute"`);
    }
  }
  return {
    json: {
      ok: true,
      dryRun: ctx.dryRun,
      identifier,
      verdict: 'changes',
      by: 'person',
      pr: pr === null ? null : { number: pr.number, url: pr.url },
      forgeReview,
      sentBackTo,
      forgeSkipped: target.forge === null ? target.why : null,
    },
    text: `${ctx.dryRun ? 'Would send' : 'Sent'} ${identifier} back with your note. Nothing was closed.`,
  };
}
