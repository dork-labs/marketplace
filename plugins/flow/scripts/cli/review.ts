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
 * drain or VERIFY), and no check fails. A verdict written any other way is not
 * a verdict.
 *
 * With `gates.review.mergeOnApproval` off nothing is armed, so the reviewer
 * agent's approval is the last check before a person merges, and every check
 * must have passed. When they have not finished, it ships nothing and returns
 * at once (exit 5, `verdict: "pending"`), saving the run's `shipWait`: the
 * retry point the drain's tick re-checks with the same command. One long
 * blocking call outlived an agent's command timeout and handed the gate to a
 * person (DOR-2535). `--wait [--wait-minutes n]` still waits in one call, for
 * a person at a terminal. A PR no check ever reports on counts as passed
 * `gates.review.noChecksPassAfterMinutes` after the first look, only when the
 * base branch requires no checks; the approval then says no checks ran.
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
import type { FlowRun, RunShipWait } from '../flow-run.ts';
import type { FlowStateFile } from '../flow-state-file.ts';
import { ForgeError, type Forge, type ReviewOutcome } from '../forge/types.ts';
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

/** How often `--wait` looks at the PR's checks again. */
const CHECK_POLL_MS = 60_000;

/** `--wait [minutes]`: how long the reviewer agent waits for checks to finish (0 without it). */
function waitMinutes(ctx: VerbContext): number {
  const value = ctx.args.flags['wait-minutes'];
  if (typeof value === 'string') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 24 * 60) {
      throw new UsageError('--wait-minutes must be a whole number of minutes, at most 1440');
    }
    return n;
  }
  return ctx.args.flags.wait === true ? 120 : 0;
}

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
 * What the reviewer agent found on the PR's checks:
 *
 * - `passed` — every check finished without failing (or the PR will be armed,
 *   and the forge's auto-merge waits for the required ones).
 * - `none` — no check ever reported on the head, the base requires none, and
 *   `gates.review.noChecksPassAfterMinutes` went by since the reviewer agent
 *   first looked: counted as passed, and said so in `note`.
 * - `pending` — not yet: `why` says what is awaited, `since` when the wait
 *   began, `recorded` whether the run's retry point was saved.
 */
export type ShipChecks =
  | { kind: 'passed' }
  | { kind: 'none'; note: string }
  | {
      kind: 'pending';
      pending: number | undefined;
      why: string;
      since: string;
      recorded: boolean;
    };

/** What {@link awaitChecks} needs. */
interface AwaitChecksInput {
  forge: Forge;
  pr: number;
  identifier: string;
  /** The branch head the reviewer agent checked. */
  head: string;
  /** `true` with `mergeOnApproval` off: every check must have passed. */
  needsPassed: boolean;
  /** `gates.review.noChecksPassAfterMinutes`. */
  noChecksPassAfterMinutes: number | null;
  /** The run's saved wait, if any. */
  prior: RunShipWait | undefined;
  /** Save the wait on the run; resolves `false` when the store stayed locked. */
  record(wait: RunShipWait): Promise<boolean>;
}

/** `n minutes`, singular for one. */
function minutes(n: number): string {
  return `${n} minute${n === 1 ? '' : 's'}`;
}

/**
 * Read the PR's checks for the reviewer agent's ship, and with `--wait` keep
 * reading until they settle or the wait runs out. Without `--wait` it reads
 * once and returns at once, so an agent's command timeout never kills it.
 *
 * Every `pending` answer saves the run's {@link RunShipWait} first (not on a
 * dry run), so a `--wait` killed midway still leaves the retry point for the
 * drain's next tick. The no-checks clock starts at the saved wait's `since` when
 * it is for the same commit, so it keeps running across ticks.
 *
 * @param ctx - The verb's context (clock, sleep, dry run, `--wait` flags).
 * @param input - The forge, PR, head and settings.
 * @returns What the checks say.
 * @throws {PreconditionError} When a check is failing (exit 5).
 */
export async function awaitChecks(ctx: VerbContext, input: AwaitChecksInput): Promise<ShipChecks> {
  const { forge, pr, identifier, head } = input;
  const waitMs = waitMinutes(ctx) * 60_000;
  const startedAt = ctx.now();
  const priorSince =
    input.prior !== undefined && input.prior.sha.toLowerCase() === head.toLowerCase()
      ? Date.parse(input.prior.since)
      : Number.NaN;
  const since = Number.isNaN(priorSince) ? startedAt : new Date(priorSince);
  let required: string[] | null | undefined;
  let requiredWhy = '';
  let waited = 0;
  for (;;) {
    const status = await forge.prStatus(pr);
    if (status.failing.length > 0) {
      throw new PreconditionError(
        `${identifier}'s PR has failing checks (${status.failing.map((c) => c.name).join(', ')}), so the reviewer agent does not ship it`
      );
    }
    if (!input.needsPassed || status.pendingChecks === 0) return { kind: 'passed' };

    let why = `${status.pendingChecks === undefined ? 'its checks have' : `${status.pendingChecks} of its checks have`} not finished on PR #${pr}`;
    if (status.checksReported === 0) {
      const grace = input.noChecksPassAfterMinutes;
      if (grace === null) {
        why = `no checks have reported on PR #${pr}, and this project never counts that as passed (gates.review.noChecksPassAfterMinutes is null)`;
      } else {
        if (required === undefined) {
          try {
            required =
              forge.requiredChecks === undefined ? null : await forge.requiredChecks(status.base);
          } catch (error) {
            if (!(error instanceof ForgeError)) throw error;
            required = null;
            requiredWhy = ` (${error.message})`;
          }
        }
        if (required === null) {
          why = `no checks have reported on PR #${pr}, and flow cannot tell whether ${status.base || 'its base branch'} requires any${requiredWhy}`;
        } else if (required.length > 0) {
          why = `${required.length === 1 ? 'a required check has' : 'required checks have'} not started on PR #${pr} (${required.join(', ')})`;
        } else {
          const elapsed = Math.max(
            ctx.now().getTime() - since.getTime(),
            startedAt.getTime() - since.getTime() + waited
          );
          if (elapsed >= grace * 60_000) {
            return {
              kind: 'none',
              note: `No checks ran on PR #${pr}, and ${status.base || 'its base branch'} requires none, so flow counted that as passed after ${minutes(grace)}.`,
            };
          }
          const left = Math.max(1, Math.ceil((grace * 60_000 - elapsed) / 60_000));
          why = `no checks have reported on PR #${pr} yet; none are required, so flow counts that as passed in about ${minutes(left)}`;
        }
      }
    }

    const recorded = ctx.dryRun
      ? false
      : await input.record({
          sha: head,
          since: since.toISOString(),
          checkedAt: ctx.now().toISOString(),
        });
    if (waited >= waitMs) {
      return {
        kind: 'pending',
        pending: status.pendingChecks,
        why: waitMs > 0 ? `${why}, after ${minutes(waitMinutes(ctx))} of waiting` : why,
        since: since.toISOString(),
        recorded,
      };
    }
    await ctx.io.sleep(CHECK_POLL_MS);
    waited += CHECK_POLL_MS;
  }
}

/**
 * Save or clear the run's {@link RunShipWait}.
 *
 * @param store - The run store.
 * @param issueId - The run's key.
 * @param wait - The wait to save, or `undefined` to clear it.
 * @returns `false` when the store stayed locked by another flow command.
 */
async function setShipWait(
  store: FlowStateFile,
  issueId: string,
  wait: RunShipWait | undefined
): Promise<boolean> {
  const result = await store.updateRun(issueId, (current) => {
    if (wait !== undefined) return { ...current, shipWait: wait };
    const { shipWait: _cleared, ...rest } = current;
    return rest;
  });
  return result.status !== 'dropped';
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
    let noChecksNote: string | null = null;
    if (by === 'reviewer-agent') {
      let checked: ShipChecks;
      try {
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
        if (pr === null) {
          throw new PreconditionError(
            `${identifier} has no open PR, so there are no checks the reviewer agent can see`
          );
        }
        checked = await awaitChecks(ctx, {
          forge: target.forge,
          pr: pr.number,
          identifier,
          head,
          needsPassed: !config.gates.review.mergeOnApproval,
          noChecksPassAfterMinutes: config.gates.review.noChecksPassAfterMinutes,
          prior: existing.shipWait,
          record: (wait) => setShipWait(store, existing.issueId, wait),
        });
      } catch (error) {
        // A refusal ends the wait: the drain stops re-checking, and the caller
        // hands the gate to a person.
        // (The wait may have been saved by this very call, before a check failed.)
        if (error instanceof PreconditionError && !ctx.dryRun) {
          await setShipWait(store, existing.issueId, undefined);
        }
        throw error;
      }
      if (checked.kind === 'pending') {
        return {
          exitCode: 5,
          json: {
            ok: false,
            dryRun: ctx.dryRun,
            identifier,
            verdict: 'pending',
            by,
            pr: pr === null ? null : { number: pr.number, url: pr.url },
            checks: {
              state: 'pending',
              pending: checked.pending ?? null,
              why: checked.why,
              waitingSince: checked.since,
            },
            retryRecorded: checked.recorded,
          },
          text: `Not shipped yet: ${checked.why}. Nothing was posted. Run the same command again later${checked.recorded ? '; a drain tick does that by itself' : ''}.`,
        };
      }
      noChecksNote = checked.kind === 'none' ? checked.note : null;
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
          : (flag(ctx, 'head') ??
            (isWritableDrain(existing)
              ? existing.drain.reviewedSha
              : existing.review?.verdict === 'clean'
                ? existing.review.reviewedSha
                : null));
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
      if (existing.shipWait !== undefined || by === 'reviewer-agent') {
        await setShipWait(store, existing.issueId, undefined);
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
    const checksText = noChecksNote === null ? '' : ` ${noChecksNote}`;
    const armText = armed
      ? ` Armed PR #${pr?.number} to merge when its checks pass.`
      : pr !== null && !config.gates.review.mergeOnApproval
        ? ` PR #${pr.number} waits for a person to merge it.`
        : willArm
          ? " Approved. Merge it yourself; flow didn't turn on auto-merge because it couldn't tell which commit you approved."
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
        note: `${checksText}${armText}`.trim() === '' ? null : `${checksText}${armText}`.trim(),
        checks: noChecksNote === null ? null : 'none',
        forgeSkipped: target.forge === null ? target.why : null,
      },
      text: `${ctx.dryRun ? 'Would ship' : 'Shipped'} ${identifier}${by === 'reviewer-agent' ? ' (the reviewer agent approved it)' : ''}.${checksText}${armText}`,
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
    if (existing.shipWait !== undefined) await setShipWait(store, existing.issueId, undefined);
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
