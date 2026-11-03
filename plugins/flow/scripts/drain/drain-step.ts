/**
 * The parallel drain as a pure reducer (spec `flow-handoff-dispatch` §4.4):
 * one run's drain state plus what a pass observed, in; the next state and the
 * actions to take, out.
 *
 * The runner gathers {@link DrainFacts}, calls {@link drainStep}, and applies the
 * returned {@link DrainAction}s in order. Actions are data, so a pass that dies
 * midway repeats safely, and `flow drain --dry-run` can print them.
 *
 * **No action here creates a pull request.** Only `flow pr` does, and it checks
 * the clean review at the origin head itself (§4.6). The reducer's part is to
 * send `open-pr` only in that state, and to park a run whose branch grew a PR
 * before a clean review.
 *
 * **Counting stops.** `nudges` counts "you stopped without reporting" messages
 * sent in the current phase; in `reviewing` it also counts reviewer restarts at
 * the current SHA (the worker is not nudged while its commit is under review,
 * so the two never share a phase in practice). Every phase change, and every
 * reviewer started at a new SHA, resets it to 0.
 *
 * **While `run.limit` is set** the handoff reducer (§5.2) owns the worker: this
 * one records the reports, never nudges, and drops any step that would send the
 * worker a message (the step repeats once the limit clears).
 *
 * Pure and dependency-free (type imports and local zero-dependency modules
 * only), so it runs before `npm install`.
 *
 * @module @dorkos/flow/drain/drain-step
 */

import type { FlowRun } from '../flow-run.ts';
import { handleRuntime, type SessionHandle, type SessionState } from '../launchers/types.ts';
import {
  reviewFindingsPath,
  type FailingCheck,
  type MessageContexts,
  type MessageKind,
} from './messages.ts';
import { liveKey } from './live-count.ts';
import type { DrainPullRequest, DrainState, DrainWorkerHandle } from './state.ts';

/** An open pull request found on the run's branch (the forge's `prForBranch`). */
export interface BranchPullRequest {
  /** `owner/name`. */
  repo: string;
  /** The PR number. */
  number: number;
  /** The PR's web address. */
  url: string;
  /** Its head commit, when the forge reported it. */
  headSha: string | null;
}

/** The forge's view of the run's pull request (`prStatus`, spec §4.6). */
export interface PrStatusFact {
  /** Open, merged, or closed without merging. */
  state: 'open' | 'merged' | 'closed';
  /** The checks failing now. */
  failing: FailingCheck[];
  /** Whether auto-merge is armed. */
  armed: boolean;
  /** Whether it sits in the merge queue. */
  queued: boolean;
  /** The PR's head commit. */
  headSha: string;
  /** The branch it merges into, when known. */
  base?: string;
  /** Whether it conflicts with its base: no checks run and it never merges. */
  conflicting?: boolean;
}

/**
 * The report-owned fields (§4.3) as the pass read them. Only the report and PR
 * verbs write these; the reducer records them on the run it returns.
 */
export type DrainReports = Pick<
  DrainState,
  'pushedSha' | 'verdict' | 'reviewedSha' | 'reviewRound' | 'pr'
>;

/** What one pass observed for one run (§4.2 step 1). */
export interface DrainFacts {
  /** An open PR on the run's branch, gathered while `drain.pr` is null; else `null`. */
  prForBranch: BranchPullRequest | null;
  /** How long the claim or the pending worker intent has waited to start (ms), or `null` when neither applies. */
  queuedAgeMs: number | null;
  /** The worker's state from its launcher, or `null` when there is no started worker. */
  worker: SessionState | null;
  /** The reviewer's state from its launcher, or `null` when there is no started reviewer. */
  reviewer: SessionState | null;
  /** The report-owned fields, re-read this pass. */
  reports: DrainReports;
  /** The run's branch head on origin, or `null` when unknown. */
  originHead: string | null;
  /** The forge's status of `drain.pr`, or `null` while there is none. */
  pr: PrStatusFact | null;
  /**
   * `judgeEjection`'s answer when the PR left the merge queue (it was expected
   * armed and is now neither armed nor queued); `null` when it was not ejected.
   */
  ejection: 'innocent' | 'suspect' | 'unknown' | null;
  /** The tracker item, from one `getItem`. */
  item: {
    /** Closed or cancelled. */
    closed: boolean;
    /** Still carries the agent's claim. */
    claimed: boolean;
    /** Carries `agent/needs-input`: a person has not answered yet. */
    needsInput: boolean;
    /** For a parked run: a pointer to the reply that answered it, when one was found. */
    answer?: string | null;
    /** Its title, for the pull request. */
    title: string;
  };
  /** The run's `status` is `complete` (`flow done` ran). */
  runComplete: boolean;
  /**
   * Signs of progress a session's state does not carry, per session: a cli
   * session's stream-log offset, as a string. `null` or absent: none. The
   * lane supervisor reads a state's own `activityAt` first.
   */
  activity?: { worker: string | null; reviewer: string | null };
}

/** The drain settings the reducer reads. */
export interface DrainStepConfig {
  /** Review verdicts before a run parks (`drain.maxReviewRounds`, default 5). */
  maxReviewRounds: number;
  /** How long a claim or a pending start may wait before adopt-or-release (ms). */
  startTimeoutMs: number;
  /** The full flow command prefix messages spell verbs with. */
  flow: string;
  /**
   * Whether the worker fixes failing checks and merge conflicts on its own
   * (default `true`). `false` when the project's "Retry and fix problems" stop
   * is Ask me first (`autonomy.ts`): the run parks for a person instead.
   */
  fixFailingChecks?: boolean;
  /**
   * How long a lane may show no progress before the supervisor acts (ms,
   * `drain.stallAfterMinutes`, DOR-3263). Absent: the lane supervisor is off.
   */
  stallAfterMs?: number;
}

/** A pull request an action is about. */
export interface PrRef {
  /** `owner/name`. */
  repo: string;
  /** The PR number. */
  number: number;
}

/**
 * A message to the worker, with the context its template renders from. `model`
 * (set only by the handoff reducer's model fallback, spec §5.2a) asks the host
 * to run the session's next turn on that model.
 */
export type SendAction = {
  [K in MessageKind]: { kind: 'send'; message: K; ctx: MessageContexts[K]; model?: string };
}[MessageKind];

/**
 * One thing the runner does. There is no create-PR action: only `flow pr`
 * opens a pull request.
 *
 * - `start-reviewer`: start a fresh reviewer at `sha`; `deltaFrom` is the last
 *   reviewed SHA, for "also read `git diff <deltaFrom> <sha>`".
 * - `stop`: stop that session (its handle, runtime filled in).
 * - `send`: render the message and deliver it to the worker.
 * - `arm` / `disarm`: turn auto-merge on or off. An arm names the reviewed
 *   commit it is for (`sha`); the forge refuses it once the PR's head is
 *   anything else, and the runner re-checks it under the lock first.
 * - `adopt-or-release`: a start never confirmed; adopt the minted session if it
 *   exists, else release the claim (§4.3).
 * - `restart-worker`: the worker's session went away (DOR-3263); start a
 *   fresh one from the checkpoint on an account the ranking picks, or park
 *   when none has room. `reason` is what the checkpoint and report say.
 * - `park`: apply the park; `trackerWrite: false` when the item was taken away,
 *   so the runner writes nothing to the tracker.
 * - `squash-check`: the PR merged; check its squash commit against the head
 *   a clean review recorded (`reviewed`, `null` when there is none, which is
 *   itself reported), and report a failure (DOR-3262). Asked again each pass
 *   until it reaches a verdict, at most {@link SQUASH_CHECK_ATTEMPTS} times;
 *   `final` marks the last, which reports even a check that could not run.
 */
export type DrainAction =
  | { kind: 'start-reviewer'; sha: string; deltaFrom: string | null }
  | { kind: 'stop'; which: 'worker' | 'reviewer'; handle: SessionHandle }
  | SendAction
  | { kind: 'arm'; pr: PrRef; sha: string }
  | { kind: 'disarm'; pr: PrRef }
  | { kind: 'squash-check'; pr: PrRef; reviewed: string | null; final: boolean }
  | { kind: 'adopt-or-release' }
  | { kind: 'restart-worker'; reason: string }
  | { kind: 'park'; reason: string; trackerWrite: boolean };

/** What {@link drainStep} returns. */
export interface DrainStepResult {
  /** The run with its next drain state (unchanged when there was nothing to do). */
  run: FlowRun;
  /** What to do, in order. */
  actions: DrainAction[];
}

/** The park reasons, as the operator reads them. */
export const PARK_REASONS = {
  workerStopped: 'the worker stopped twice without pushing',
  unreportedPush:
    'the branch on origin moved past the reviewed commit twice without a reported push',
  reviewerStopped: 'the reviewer stopped twice without a verdict',
  earlyPr: 'a PR was opened before a clean review',
  prClosed: 'the PR was closed without merging',
  itemTaken: 'the item was closed, or its claim removed, by someone else',
  rounds: (n: number) => `the review did not come back clean after ${n} rounds`,
  checksFailed:
    "the PR's checks failed, and this project's settings ask you before flow fixes failing checks",
  workerQuiet: (minutes: number) =>
    `the worker showed no activity for ${minutes} minutes while it was meant to be working`,
  unreachable: (which: 'worker' | 'reviewer', minutes: number, why: string) =>
    `flow could not reach the ${which}'s session for ${minutes} minutes (${why}), so it may still be running and was not restarted`,
  reviewerQuiet: (minutes: number) =>
    `the reviewer showed no activity for ${minutes} minutes, and flow could not be sure it stopped, so it did not start a second one`,
  workerGone: "the worker's session went away",
  workerGoneAgain: "the worker's session went away again after flow restarted it once",
  noRoomToRestart: "the worker's session went away and no account has room to restart it",
} as const;

/** The phases where the worker writes code before a clean review. */
const PRE_REVIEW_PHASES = new Set<DrainState['phase']>([
  'working',
  'reviewing',
  'fixing',
  'pr-ready',
]);

/** The phases after a clean review, where a new head must go back to review. */
const POST_REVIEW_PHASES = new Set<DrainState['phase']>(['pr-ready', 'watching', 'fixing-ci']);

/** A step under construction: the drain it leads to and its actions. */
interface Step {
  drain: DrainState;
  actions: DrainAction[];
}

/** A handle with its runtime filled in, as a launcher takes it. */
function sessionHandle(handle: DrainWorkerHandle): SessionHandle {
  const { pending: _pending, ...rest } = handle;
  return { ...rest, runtime: handleRuntime(handle) };
}

/** Move to `phase`, resetting the nudge count when the phase changes. */
function toPhase(drain: DrainState, phase: DrainState['phase']): DrainState {
  return phase === drain.phase ? drain : { ...drain, phase, nudges: 0 };
}

/** Stop the reviewer if one is recorded, and clear its slot. */
function stopReviewer(step: Step): Step {
  const reviewer = step.drain.reviewer;
  if (!reviewer) return step;
  return {
    drain: { ...step.drain, reviewer: null },
    actions: [
      ...step.actions,
      { kind: 'stop', which: 'reviewer', handle: sessionHandle(reviewer) },
    ],
  };
}

/**
 * Start a reviewer at `sha` (stopping any recorded one first). `deltaFrom` is
 * the last reviewed SHA when there is one and it differs. A new SHA resets the
 * restart count (see the module comment on counting).
 */
function startReviewer(step: Step, sha: string, facts: DrainFacts): Step {
  const stopped = disarmIfArmed(stopReviewer(step), facts);
  const reviewedSha = stopped.drain.reviewedSha;
  // Replacing a reviewer at another SHA starts a new count; restarting at the
  // same SHA, or filling an empty slot, keeps it.
  const newSha = step.drain.reviewer !== null && step.drain.reviewer.sha !== sha;
  return {
    drain: { ...toPhase(stopped.drain, 'reviewing'), ...(newSha ? { nudges: 0 } : {}) },
    actions: [
      ...stopped.actions,
      {
        kind: 'start-reviewer',
        sha,
        deltaFrom: reviewedSha && reviewedSha !== sha ? reviewedSha : null,
      },
    ],
  };
}

/**
 * Disarm the run's PR when it is armed (as recorded, or as the forge sees it):
 * whatever is about to be reviewed must not merge first.
 */
function disarmIfArmed(step: Step, facts: DrainFacts): Step {
  const pr = step.drain.pr;
  if (pr === null) return step;
  const armed = pr.armed || (facts.pr !== null && facts.pr.state === 'open' && facts.pr.armed);
  if (!armed || step.actions.some((a) => a.kind === 'disarm')) return step;
  return { drain: step.drain, actions: [...step.actions, { kind: 'disarm', pr: ref(pr) }] };
}

/**
 * Whether the reviewed commit is what would merge: a clean verdict at
 * `reviewedSha`, which is also the last reported push, the branch head on
 * origin, and the PR's head.
 */
function reviewedIsHead(
  drain: DrainState,
  facts: DrainFacts
): drain is DrainState & {
  reviewedSha: string;
} {
  const sha = drain.reviewedSha;
  return (
    sha !== null &&
    drain.verdict === 'clean' &&
    drain.pushedSha === sha &&
    facts.originHead === sha &&
    facts.pr !== null &&
    facts.pr.headSha === sha
  );
}

/** Park the run: the reviewer stops; the worker too when the item was taken away. */
function park(step: Step, reason: string, taken = false): Step {
  let next = stopReviewer(step);
  const worker = next.drain.worker;
  if (worker && !worker.pending) {
    // A parked run holds no live session. The handle stays, so an answer (or,
    // for a close that was the run's own merge, the `merged` message) can
    // resume the same session.
    next = {
      drain: next.drain,
      actions: [...next.actions, { kind: 'stop', which: 'worker', handle: sessionHandle(worker) }],
    };
  }
  return {
    drain: {
      ...toPhase(next.drain, 'parked'),
      parkedReason: reason,
      parkedFrom:
        step.drain.phase === 'parked' ? (step.drain.parkedFrom ?? null) : step.drain.phase,
      // Only `flow report blocked` parks on a person; every park here is flow's own.
      parkedFor: 'other',
    },
    actions: [...next.actions, { kind: 'park', reason, trackerWrite: !taken }],
  };
}

/** Send the worker a message. */
function send<K extends MessageKind>(step: Step, message: K, ctx: MessageContexts[K]): Step {
  return {
    drain: step.drain,
    actions: [...step.actions, { kind: 'send', message, ctx } as SendAction],
  };
}

/** The pull request an arm or disarm acts on. */
function ref(pr: DrainPullRequest | BranchPullRequest): PrRef {
  return { repo: pr.repo, number: pr.number };
}

/** A session that ended its turn without reporting: idle, or its process gone. */
function stopped(state: SessionState | null): boolean {
  return state?.kind === 'idle' || state?.kind === 'exited';
}

/**
 * The nudge rule (§4.4 `working` rows): a started worker that stopped gets a
 * `continue` message, twice; the third stop parks the run. Nothing while the
 * worker is busy, not yet started, or limited (the handoff reducer's).
 */
function nudge(
  step: Step,
  run: FlowRun,
  facts: DrainFacts,
  cfg: DrainStepConfig,
  unreportedPush = false
): Step {
  const worker = step.drain.worker;
  if (run.limit || !worker || worker.pending || !stopped(facts.worker)) return step;
  if (step.drain.nudges >= 2) {
    return park(step, unreportedPush ? PARK_REASONS.unreportedPush : PARK_REASONS.workerStopped);
  }
  const next = send(step, 'continue', {
    flow: cfg.flow,
    identifier: run.identifier,
    ...(unreportedPush ? { unreportedPush: true } : {}),
  });
  return { ...next, drain: { ...next.drain, nudges: next.drain.nudges + 1 } };
}

/** The "check" that tells a worker its PR conflicts with its base, and how to fix it. */
function conflictCheck(base: string | undefined, url: string): { name: string; url: string } {
  return {
    name: `a merge conflict with ${base || 'its base branch'}: merge origin/${base || 'main'}, resolve it, push, then report the push`,
    url,
  };
}

/** A push the review has not covered yet: the SHA, or `null`. */
function unreviewedPush(drain: DrainState): string | null {
  return drain.pushedSha !== null && drain.pushedSha !== drain.reviewedSha ? drain.pushedSha : null;
}

/** `reviewing`: wait for a verdict at the pushed SHA, then route it. */
function reviewing(step: Step, run: FlowRun, facts: DrainFacts, cfg: DrainStepConfig): Step {
  const drain = step.drain;
  const sha = drain.pushedSha;
  if (sha === null) return step;
  const verdictHere = drain.reviewedSha === sha && drain.verdict !== null;

  if (!verdictHere) {
    const reviewer = drain.reviewer;
    if (!reviewer || reviewer.sha !== sha) return startReviewer(step, sha, facts);
    if (!reviewer.pending && stopped(facts.reviewer)) {
      if (drain.nudges >= 1) return park(step, PARK_REASONS.reviewerStopped);
      const restarted = startReviewer(step, sha, facts);
      return { ...restarted, drain: { ...restarted.drain, nudges: drain.nudges + 1 } };
    }
    return step;
  }

  if (drain.verdict === 'changes') {
    if (drain.reviewRound >= cfg.maxReviewRounds) {
      return park(step, PARK_REASONS.rounds(drain.reviewRound));
    }
    const next = stopReviewer(step);
    return send({ ...next, drain: toPhase(next.drain, 'fixing') }, 'review-findings', {
      flow: cfg.flow,
      identifier: run.identifier,
      sha,
      round: drain.reviewRound,
      findingsFile: reviewFindingsPath(drain.reviewRound, sha),
    });
  }

  // A clean verdict at the pushed SHA.
  if (facts.originHead === null) return stopReviewer(step);
  if (facts.originHead !== sha) return nudge(stopReviewer(step), run, facts, cfg, true);
  const next = stopReviewer(step);
  if (drain.pr === null) {
    return send({ ...next, drain: toPhase(next.drain, 'pr-ready') }, 'open-pr', {
      flow: cfg.flow,
      identifier: run.identifier,
      sha,
      title: facts.item.title,
    });
  }
  return rearmIfReviewed({ ...next, drain: toPhase(next.drain, 'watching') }, facts);
}

/**
 * Re-arm a PR flow disarmed for a review, once that review came back clean at
 * the commit that would merge ({@link reviewedIsHead}). Until then it stays
 * disarmed, with `disarmedForReview` set, and a later pass tries again.
 */
function rearmIfReviewed(step: Step, facts: DrainFacts): Step {
  const pr = step.drain.pr;
  if (pr === null || !pr.disarmedForReview || !reviewedIsHead(step.drain, facts)) return step;
  if (facts.pr?.armed) return step;
  // A land.preArm check already refused this commit; only a new one is asked.
  if (pr.armRefusedAt != null && pr.armRefusedAt === step.drain.reviewedSha) return step;
  return {
    drain: step.drain,
    actions: [...step.actions, { kind: 'arm', pr: ref(pr), sha: step.drain.reviewedSha }],
  };
}

/**
 * Whether the branch moved past the reviewed commit: origin's head, or the
 * open PR's head, is another commit (or anything at all, before a review).
 */
function headMoved(drain: DrainState, facts: DrainFacts): boolean {
  // With nothing reviewed, any known head is unreviewed.
  const reviewed = drain.reviewedSha;
  return (
    (facts.originHead !== null && facts.originHead !== reviewed) ||
    (facts.pr !== null && facts.pr.state === 'open' && facts.pr.headSha !== reviewed)
  );
}

/**
 * A push the worker never reported, after a clean review: disarm now (it must
 * never stay armed), and once the worker has stopped, ask it to report the
 * push so the new commit is reviewed (twice, then park).
 */
function unreportedPush(step: Step, run: FlowRun, facts: DrainFacts, cfg: DrainStepConfig): Step {
  return nudge(disarmIfArmed(step, facts), run, facts, cfg, true);
}

/** `watching`: follow the PR until it merges, closes, or goes red. */
function watching(step: Step, run: FlowRun, facts: DrainFacts, cfg: DrainStepConfig): Step {
  const drain = step.drain;
  const pr = facts.pr;
  if (!drain.pr) return step;
  const prUrl = drain.pr.url;
  if (pr?.state === 'merged') {
    return send({ ...step, drain: toPhase(drain, 'closing') }, 'merged', {
      flow: cfg.flow,
      identifier: run.identifier,
      prUrl,
    });
  }
  if (pr?.state === 'closed') return park(step, PARK_REASONS.prClosed);
  if (headMoved(drain, facts)) return unreportedPush(step, run, facts, cfg);
  if (!pr) return step;
  const redCtx = { flow: cfg.flow, identifier: run.identifier, prUrl, failing: pr.failing };
  const red = (pr.state === 'open' && pr.conflicting === true) || pr.failing.length > 0;
  if (red && facts.ejection === null && cfg.fixFailingChecks === false) {
    return park(step, PARK_REASONS.checksFailed);
  }
  // A PR that conflicts with its base runs no checks and never merges, so it
  // would wait here for good (found live, 2026-09-27). Tell the worker.
  if (pr.state === 'open' && pr.conflicting === true) {
    return send({ ...step, drain: toPhase(drain, 'fixing-ci') }, 'ci-red', {
      ...redCtx,
      failing: [conflictCheck(pr.base, prUrl)],
    });
  }
  if (pr.failing.length > 0 && facts.ejection === null) {
    return send({ ...step, drain: toPhase(drain, 'fixing-ci') }, 'ci-red', redCtx);
  }
  if (!pr.armed && !pr.queued && facts.ejection !== null) {
    if (
      facts.ejection === 'innocent' &&
      drain.rearmedFor !== pr.headSha &&
      reviewedIsHead(drain, facts)
    ) {
      return {
        drain: { ...drain, rearmedFor: pr.headSha },
        actions: [...step.actions, { kind: 'arm', pr: ref(drain.pr), sha: drain.reviewedSha }],
      };
    }
    return send({ ...step, drain: toPhase(drain, 'fixing-ci') }, 'ci-red', {
      ...redCtx,
      ejected: true,
    });
  }
  return rearmIfReviewed(step, facts);
}

/** How often a lane's progress is written while it keeps moving (ms). */
const PROGRESS_WRITE_MS = 60_000;

/** The phases where the worker is meant to be working; `reviewing` waits on the reviewer. */
const WORKER_PHASES = new Set<DrainState['phase']>(['working', 'fixing', 'fixing-ci', 'pr-ready']);

/** Which session the phase waits on, or `null` when it waits on neither (CI, a park). */
function activeSession(phase: DrainState['phase']): 'worker' | 'reviewer' | null {
  if (phase === 'reviewing') return 'reviewer';
  return WORKER_PHASES.has(phase) ? 'worker' : null;
}

/** The step with the supervisor's clock cleared, so it starts over when it next looks. */
function unclocked(step: Step): Step {
  const d = step.drain;
  if (!d.progressAt && !d.progressMark && !d.waitingSince) return step;
  return { ...step, drain: { ...d, progressAt: null, progressMark: null, waitingSince: null } };
}

/**
 * A park of a session that may still run. On every host but the plain cli
 * (DorkOS never stops a session, and cmux stops only a process flow itself
 * started) it keeps the session's slot ({@link DrainState.heldSlot}) until
 * the session stops or a person answers.
 */
function parkLive(
  step: Step,
  reason: string,
  which: 'worker' | 'reviewer',
  host: string,
  slot: string
): Step {
  const parked = park(step, reason);
  if (host === 'cli') return parked;
  if (which === 'worker') return { ...parked, drain: { ...parked.drain, heldSlot: slot } };
  // Stopping a reviewer removes its worktree; one that may still run keeps
  // both, so an answer watches it again rather than starting a second one.
  return {
    drain: { ...parked.drain, reviewer: step.drain.reviewer, heldSlot: slot },
    actions: parked.actions.filter((a) => !(a.kind === 'stop' && a.which === 'reviewer')),
  };
}

/** Whether a session may still be running: busy, or a host that could not say it is gone. */
function mayRun(state: SessionState | null): boolean {
  return (
    state !== null && (state.kind === 'busy' || (state.kind === 'unknown' && state.gone !== true))
  );
}

/** The step with its progress recorded as seen `now`, and no person waited on. */
function progressed(step: Step, mark: string, now: Date): Step {
  return {
    ...step,
    drain: { ...step.drain, progressAt: now.toISOString(), progressMark: mark, waitingSince: null },
  };
}

/**
 * The lane supervisor (DOR-3263), after the phase table. It watches the
 * session the phase waits on: a fingerprint of what it and the run look like
 * ({@link DrainState.progressMark}) and when that last changed. Any action of
 * the phase table, or a new fingerprint, counts as progress (written at most
 * once a minute). After `stallAfterMs` with the same fingerprint:
 *
 * - waiting on a person: never restarted or parked; `waitingSince` lists it;
 * - a session the host cannot reach: a park, since it may still be running
 *   and a restart could leave two at work;
 * - a busy session whose host reports no activity, or one it can never
 *   describe (`cannotTell`): never judged;
 * - a reviewer that went away (`gone`): restarted at the same commit once,
 *   then the run parks (the same rule as a reviewer that stopped);
 * - a busy reviewer that wrote nothing: a park, never a second reviewer,
 *   since a host may not stop the first (DorkOS leaves it running);
 * - a worker that went away (`gone`): one `restart-worker`, then a park;
 * - a busy worker that wrote nothing: a park.
 *
 * A park of a session that may still run (busy, or unreachable) on a host
 * whose stop can leave it running keeps its slot ({@link DrainState.heldSlot}).
 * Idle and exited sessions are the nudge rule's, and a limited run the
 * handoff machine's; while either holds the run, the clock starts over.
 */
function supervise(
  step: Step,
  run: FlowRun,
  facts: DrainFacts,
  cfg: DrainStepConfig,
  now: Date
): Step {
  const stallAfterMs = cfg.stallAfterMs;
  if (stallAfterMs === undefined || run.limit) return unclocked(step);
  const drain = step.drain;
  const which = activeSession(drain.phase);
  const handle = which === null ? null : drain[which];
  const state = which === null ? null : facts[which];
  if (which === null || handle === null || handle.pending || state === null) {
    return drain.waitingSince ? { ...step, drain: { ...drain, waitingSince: null } } : step;
  }
  // The slot this session holds, as `liveByAccount` counts it.
  const slot =
    which === 'worker'
      ? liveKey(run.runtime, run.account)
      : liveKey(handleRuntime(handle), handle.account);
  const activity =
    (state.kind === 'busy' ? state.activityAt : undefined) ?? facts.activity?.[which] ?? null;
  const waiting = state.kind === 'busy' && state.waiting === 'person';
  const mark = JSON.stringify([
    drain.phase,
    drain.pushedSha,
    drain.reviewedSha,
    drain.verdict,
    drain.reviewRound,
    drain.pr?.number ?? null,
    which,
    handle.sessionId,
    state.kind,
    waiting,
    activity,
  ]);
  if (step.actions.length > 0) return progressed(step, mark, now);
  const since = drain.progressAt ? Date.parse(drain.progressAt) : NaN;
  if (mark !== drain.progressMark || !Number.isFinite(since)) {
    // Moving: record it, but not more than once a minute.
    if (Number.isFinite(since) && now.getTime() - since < PROGRESS_WRITE_MS) return step;
    return progressed(step, mark, now);
  }
  if (now.getTime() - since < stallAfterMs) return step;
  const minutes = Math.round(stallAfterMs / 60_000);

  if (waiting) {
    return drain.waitingSince === drain.progressAt
      ? step
      : { ...step, drain: { ...drain, waitingSince: drain.progressAt ?? null } };
  }
  const gone = state.kind === 'unknown' && state.gone === true;
  // A host that can never describe this session is not an outage: never judged.
  if (state.kind === 'unknown' && state.cannotTell === true) return step;
  // Not proof it stopped: restarting could leave two sessions at work.
  if (state.kind === 'unknown' && !gone) {
    return parkLive(
      step,
      PARK_REASONS.unreachable(which, minutes, state.reason),
      which,
      handle.host,
      slot
    );
  }
  // A host that reports no activity for a busy session is never judged.
  if (state.kind === 'busy' && activity === null) return step;
  if (which === 'reviewer') {
    if (!gone) return parkLive(step, PARK_REASONS.reviewerQuiet(minutes), which, handle.host, slot);
    if (drain.nudges >= 1) return park(step, PARK_REASONS.reviewerStopped);
    const sha = (handle as DrainState['reviewer'] & object).sha;
    const restarted = startReviewer(step, sha, facts);
    return progressed(
      { ...restarted, drain: { ...restarted.drain, nudges: drain.nudges + 1 } },
      mark,
      now
    );
  }
  if (gone) {
    if ((drain.restarts ?? 0) >= 1) return park(step, PARK_REASONS.workerGoneAgain);
    return progressed(
      {
        drain: { ...drain, restarts: (drain.restarts ?? 0) + 1 },
        actions: [...step.actions, { kind: 'restart-worker', reason: PARK_REASONS.workerGone }],
      },
      mark,
      now
    );
  }
  return state.kind === 'busy'
    ? parkLive(step, PARK_REASONS.workerQuiet(minutes), which, handle.host, slot)
    : step;
}

/** The phase table for a run that is live, claimed and past its start. */
function phaseStep(step: Step, run: FlowRun, facts: DrainFacts, cfg: DrainStepConfig): Step {
  const drain = step.drain;
  const pushed = unreviewedPush(drain);
  switch (drain.phase) {
    case 'working':
      return pushed ? startReviewer(step, pushed, facts) : nudge(step, run, facts, cfg);
    case 'reviewing':
      return reviewing(step, run, facts, cfg);
    case 'fixing':
      if (drain.verdict === 'changes' && drain.reviewRound >= cfg.maxReviewRounds) {
        return park(step, PARK_REASONS.rounds(drain.reviewRound));
      }
      return pushed ? startReviewer(step, pushed, facts) : nudge(step, run, facts, cfg);
    case 'fixing-ci':
      if (pushed) return startReviewer(step, pushed, facts);
      return headMoved(drain, facts)
        ? unreportedPush(step, run, facts, cfg)
        : nudge(step, run, facts, cfg);
    case 'pr-ready':
      if (pushed) return startReviewer(step, pushed, facts);
      if (headMoved(drain, facts)) return unreportedPush(step, run, facts, cfg);
      return drain.pr ? { ...step, drain: toPhase(drain, 'watching') } : step;
    case 'watching':
      return pushed ? startReviewer(step, pushed, facts) : watching(step, run, facts, cfg);
    default:
      return step;
  }
}

/**
 * Whether an unrecorded PR on the branch is the one `flow pr` is opening: in
 * `pr-ready`, at the clean reviewed head (`flow pr` creates the PR, then
 * records it, so a pass can land in between). Its head is the forge's, else
 * origin's. Any other head is a PR opened before a clean review.
 */
function isFlowPrsOwn(drain: DrainState, pr: BranchPullRequest, facts: DrainFacts): boolean {
  const head = pr.headSha ?? facts.originHead;
  return (
    drain.phase === 'pr-ready' &&
    drain.verdict === 'clean' &&
    drain.reviewedSha !== null &&
    drain.pushedSha === drain.reviewedSha &&
    head === drain.reviewedSha
  );
}

/**
 * A parked run whose question was answered: its item no longer carries
 * `agent/needs-input` and is still claimed and open. It goes back to the phase
 * it parked from (`working` when unknown) and the worker gets a `continue` that
 * points at the answer. Anything else leaves it parked and unchanged.
 */
function readopt(
  run: FlowRun,
  current: DrainState,
  facts: DrainFacts,
  cfg: DrainStepConfig
): DrainStepResult {
  const item = facts.item;
  if (item.closed || !item.claimed || item.needsInput || run.limit) return { run, actions: [] };
  // A person's answer also gives a lane that went away its one restart back.
  const cleared = {
    parkedReason: null,
    parkedFrom: null,
    parkedAt: null,
    parkedFor: null,
    nudges: 0,
    restarts: 0,
    // The stall clock starts over from the answer, and a held slot is freed.
    progressAt: null,
    progressMark: null,
    waitingSince: null,
    heldSlot: null,
  };
  // A park on failing checks that a person answered: the answer is the go-ahead
  // to fix them (spec flow-multiproject §7.7, retry at Ask me first). Back to
  // watching would meet the same red checks and park again forever.
  if (current.parkedReason === PARK_REASONS.checksFailed && current.pr !== null) {
    return {
      run: { ...run, drain: { ...current, ...facts.reports, phase: 'fixing-ci', ...cleared } },
      actions: [
        {
          kind: 'send',
          message: 'ci-red',
          ctx: {
            flow: cfg.flow,
            identifier: run.identifier,
            prUrl: current.pr.url,
            failing:
              facts.pr?.state === 'open' && facts.pr.conflicting === true
                ? [conflictCheck(facts.pr.base, current.pr.url), ...facts.pr.failing]
                : (facts.pr?.failing ?? []),
            ...(item.answer ? { answer: item.answer } : {}),
          },
        },
      ],
    };
  }
  const from = current.parkedFrom;
  const phase = from && from !== 'parked' ? from : 'working';
  return {
    run: {
      ...run,
      drain: {
        ...current,
        ...facts.reports,
        phase,
        parkedReason: null,
        parkedFrom: null,
        parkedAt: null,
        parkedFor: null,
        nudges: 0,
        restarts: 0,
        progressAt: null,
        progressMark: null,
        waitingSince: null,
        heldSlot: null,
      },
    },
    actions: [
      {
        kind: 'send',
        message: 'continue',
        ctx: {
          flow: cfg.flow,
          identifier: run.identifier,
          answered: true,
          ...(item.answer ? { answer: item.answer } : {}),
        },
      },
    ],
  };
}

/**
 * One reducer step for one drain run (spec §4.4).
 *
 * @param run - The run as the pass read it; a run without `drain`, or a drain
 *   written by a newer flow (`v` above 1), comes back unchanged; a parked run
 *   comes back unchanged until its question is answered ({@link readopt}).
 * @param facts - What the pass observed.
 * @param cfg - The drain settings.
 * @param now - The pass's clock, for `wakeAfter`.
 * @returns The run with its next drain state, and the actions to apply in order.
 */
export function drainStep(
  run: FlowRun,
  facts: DrainFacts,
  cfg: DrainStepConfig,
  now: Date
): DrainStepResult {
  return withSquashCheck(drainStepCore(run, facts, cfg, now), facts);
}

/** How many passes ask for a merged PR's squash check before the last one reports regardless. */
export const SQUASH_CHECK_ATTEMPTS = 5;

/**
 * Once the run's PR merged, ask for the squash check (DOR-3262), whatever the
 * phase: every pass until it reaches a verdict, at most
 * {@link SQUASH_CHECK_ATTEMPTS} times. The attempt is counted here; the
 * runner records the verdict.
 */
function withSquashCheck(result: DrainStepResult, facts: DrainFacts): DrainStepResult {
  const drain = result.run.drain;
  if (!drain || drain.v !== 1 || drain.pr === null || facts.pr?.state !== 'merged') return result;
  const prior = drain.squashCheck ?? { attempts: 0, settled: false };
  if (prior.settled || prior.attempts >= SQUASH_CHECK_ATTEMPTS) return result;
  const attempts = prior.attempts + 1;
  const reviewed = drain.verdict === 'clean' ? drain.reviewedSha : null;
  // The pass that stops a closed run's last session is the last one to look
  // at it, so that check is the final one too, and reports even a check that
  // could not run.
  const lastLook =
    drain.phase === 'closing' &&
    facts.runComplete &&
    drain.worker === null &&
    drain.reviewer === null;
  return {
    run: { ...result.run, drain: { ...drain, squashCheck: { attempts, settled: false } } },
    actions: [
      ...result.actions,
      {
        kind: 'squash-check',
        pr: ref(drain.pr),
        reviewed,
        final: attempts >= SQUASH_CHECK_ATTEMPTS || lastLook,
      },
    ],
  };
}

/** {@link drainStep} without the squash check. */
function drainStepCore(
  run: FlowRun,
  facts: DrainFacts,
  cfg: DrainStepConfig,
  now: Date
): DrainStepResult {
  const current = run.drain;
  if (!current || current.v !== 1) return { run, actions: [] };
  // The run's own PR merged: the tracker closes the item on its `Closes` line,
  // which is expected, not "taken away". Go straight to closing, even from a
  // park that mistook that close for someone else's (found live, 2026-09-27).
  // Not when a person reopened and unclaimed the item after the merge, not
  // while a limit owns the worker, and only with a worker to run DONE.
  if (
    current.pr !== null &&
    facts.pr?.state === 'merged' &&
    (facts.item.closed || facts.item.claimed) &&
    !run.limit &&
    current.worker !== null &&
    (current.phase === 'watching' ||
      (current.phase === 'parked' && current.parkedReason === PARK_REASONS.itemTaken))
  ) {
    const recorded: DrainState = { ...current, ...facts.reports };
    const step = send(
      {
        drain: {
          ...toPhase(recorded, 'closing'),
          parkedReason: null,
          parkedFrom: null,
          parkedAt: null,
          parkedFor: null,
        },
        actions: [],
      },
      'merged',
      { flow: cfg.flow, identifier: run.identifier, prUrl: current.pr.url }
    );
    return { run: { ...run, drain: step.drain }, actions: step.actions };
  }
  if (current.phase === 'parked') {
    // A held slot is freed once neither session may still be running.
    if (current.heldSlot && !mayRun(facts.worker) && !mayRun(facts.reviewer)) {
      const freed = { ...current, heldSlot: null };
      return readopt({ ...run, drain: freed }, freed, facts, cfg);
    }
    return readopt(run, current, facts, cfg);
  }

  // Record the reports first: they are facts whatever else happens.
  const recorded: DrainState = { ...current, ...facts.reports };
  const idle: Step = { drain: recorded, actions: [] };
  const done = (step: Step): DrainStepResult => ({
    run: { ...run, drain: step.drain },
    actions: step.actions,
  });

  if (recorded.phase === 'closing') {
    if (!facts.runComplete) return done(idle);
    let step = stopReviewer(idle);
    // Mark the worker's worktree for the drain's cleanup (DOR-2469), keeping
    // the stopped handle: the cleanup asks its host whether it still runs.
    if (step.drain.cleanup == null) {
      step = {
        ...step,
        drain: { ...step.drain, cleanup: { status: 'pending', worker: step.drain.worker } },
      };
    }
    if (step.drain.worker) {
      step = {
        drain: { ...step.drain, worker: null },
        actions: [
          ...step.actions,
          { kind: 'stop', which: 'worker', handle: sessionHandle(step.drain.worker) },
        ],
      };
    }
    return done(step);
  }

  // Taken away: closed, or the claim removed, by someone else. (In `closing`
  // the worker closes the item itself, so that phase is handled above.)
  if (facts.item.closed || !facts.item.claimed) {
    return done(park(idle, PARK_REASONS.itemTaken, true));
  }

  const unstarted =
    (run.status === 'queued' && recorded.worker === null) || recorded.worker?.pending === true;
  if (unstarted && facts.queuedAgeMs !== null && facts.queuedAgeMs > cfg.startTimeoutMs) {
    return done({ ...idle, actions: [{ kind: 'adopt-or-release' }] });
  }

  if (recorded.wakeAfter !== null && now.getTime() < Date.parse(recorded.wakeAfter)) {
    return done(unclocked(idle));
  }

  if (
    PRE_REVIEW_PHASES.has(recorded.phase) &&
    recorded.pr === null &&
    facts.prForBranch &&
    !isFlowPrsOwn(recorded, facts.prForBranch, facts)
  ) {
    const parked = park(idle, PARK_REASONS.earlyPr);
    return done({
      drain: parked.drain,
      actions: [{ kind: 'disarm', pr: ref(facts.prForBranch) }, ...parked.actions],
    });
  }

  const step = phaseStep(idle, run, facts, cfg);
  if (run.limit && step.actions.some((a) => a.kind === 'send')) return done(unclocked(idle));
  return done(supervise(step, run, facts, cfg, now));
}
