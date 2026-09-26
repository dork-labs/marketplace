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
import type { DrainPullRequest, DrainState, DrainWorkerHandle } from './state.ts';

/** An open pull request found on the run's branch (the forge's `prForBranch`). */
export interface BranchPullRequest {
  /** `owner/name`. */
  repo: string;
  /** The PR number. */
  number: number;
  /** The PR's web address. */
  url: string;
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
    /** Its title, for the pull request. */
    title: string;
  };
  /** The run's `status` is `complete` (`flow done` ran). */
  runComplete: boolean;
}

/** The drain settings the reducer reads. */
export interface DrainStepConfig {
  /** Review verdicts before a run parks (`drain.maxReviewRounds`, default 5). */
  maxReviewRounds: number;
  /** How long a claim or a pending start may wait before adopt-or-release (ms). */
  startTimeoutMs: number;
  /** The full flow command prefix messages spell verbs with. */
  flow: string;
}

/** A pull request an action is about. */
export interface PrRef {
  /** `owner/name`. */
  repo: string;
  /** The PR number. */
  number: number;
}

/** A message to the worker, with the context its template renders from. */
export type SendAction = {
  [K in MessageKind]: { kind: 'send'; message: K; ctx: MessageContexts[K] };
}[MessageKind];

/**
 * One thing the runner does. There is no create-PR action: only `flow pr`
 * opens a pull request.
 *
 * - `start-reviewer`: start a fresh reviewer at `sha`; `deltaFrom` is the last
 *   reviewed SHA, for "also read `git diff <deltaFrom> <sha>`".
 * - `stop`: stop that session (its handle, runtime filled in).
 * - `send`: render the message and deliver it to the worker.
 * - `arm` / `disarm`: turn auto-merge on or off.
 * - `adopt-or-release`: a start never confirmed; adopt the minted session if it
 *   exists, else release the claim (§4.3).
 * - `park`: apply the park; `trackerWrite: false` when the item was taken away,
 *   so the runner writes nothing to the tracker.
 */
export type DrainAction =
  | { kind: 'start-reviewer'; sha: string; deltaFrom: string | null }
  | { kind: 'stop'; which: 'worker' | 'reviewer'; handle: SessionHandle }
  | SendAction
  | { kind: 'arm'; pr: PrRef }
  | { kind: 'disarm'; pr: PrRef }
  | { kind: 'adopt-or-release' }
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
} as const;

/** The phases where the worker writes code before a clean review. */
const PRE_REVIEW_PHASES = new Set<DrainState['phase']>(['working', 'reviewing', 'fixing']);

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
function startReviewer(step: Step, sha: string): Step {
  const stopped = stopReviewer(step);
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

/** Park the run: the reviewer stops; the worker too when the item was taken away. */
function park(step: Step, reason: string, taken = false): Step {
  let next = stopReviewer(step);
  if (taken && next.drain.worker) {
    next = {
      drain: { ...next.drain, worker: null },
      actions: [
        ...next.actions,
        { kind: 'stop', which: 'worker', handle: sessionHandle(next.drain.worker) },
      ],
    };
  }
  return {
    drain: { ...toPhase(next.drain, 'parked'), parkedReason: reason },
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
    if (!reviewer || reviewer.sha !== sha) return startReviewer(step, sha);
    if (!reviewer.pending && stopped(facts.reviewer)) {
      if (drain.nudges >= 1) return park(step, PARK_REASONS.reviewerStopped);
      const restarted = startReviewer(step, sha);
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
  return {
    drain: toPhase(next.drain, 'watching'),
    actions: drain.pr.disarmedForReview
      ? [...next.actions, { kind: 'arm', pr: ref(drain.pr) }]
      : next.actions,
  };
}

/** `watching`: follow the PR until it merges, closes, or goes red. */
function watching(step: Step, run: FlowRun, facts: DrainFacts, cfg: DrainStepConfig): Step {
  const drain = step.drain;
  const pr = facts.pr;
  if (!pr || !drain.pr) return step;
  const prUrl = drain.pr.url;
  if (pr.state === 'merged') {
    return send({ ...step, drain: toPhase(drain, 'closing') }, 'merged', {
      flow: cfg.flow,
      identifier: run.identifier,
      prUrl,
    });
  }
  if (pr.state === 'closed') return park(step, PARK_REASONS.prClosed);
  const redCtx = { flow: cfg.flow, identifier: run.identifier, prUrl, failing: pr.failing };
  if (pr.failing.length > 0 && facts.ejection === null) {
    return send({ ...step, drain: toPhase(drain, 'fixing-ci') }, 'ci-red', redCtx);
  }
  if (!pr.armed && !pr.queued && facts.ejection !== null) {
    if (facts.ejection === 'innocent' && drain.rearmedFor !== pr.headSha) {
      return {
        drain: { ...drain, rearmedFor: pr.headSha },
        actions: [...step.actions, { kind: 'arm', pr: ref(drain.pr) }],
      };
    }
    return send({ ...step, drain: toPhase(drain, 'fixing-ci') }, 'ci-red', {
      ...redCtx,
      ejected: true,
    });
  }
  return step;
}

/** The phase table for a run that is live, claimed and past its start. */
function phaseStep(step: Step, run: FlowRun, facts: DrainFacts, cfg: DrainStepConfig): Step {
  const drain = step.drain;
  const pushed = unreviewedPush(drain);
  switch (drain.phase) {
    case 'working':
      return pushed ? startReviewer(step, pushed) : nudge(step, run, facts, cfg);
    case 'reviewing':
      return reviewing(step, run, facts, cfg);
    case 'fixing':
      if (drain.verdict === 'changes' && drain.reviewRound >= cfg.maxReviewRounds) {
        return park(step, PARK_REASONS.rounds(drain.reviewRound));
      }
      return pushed ? startReviewer(step, pushed) : nudge(step, run, facts, cfg);
    case 'fixing-ci':
      return pushed ? startReviewer(step, pushed) : nudge(step, run, facts, cfg);
    case 'pr-ready':
      if (pushed) return startReviewer(step, pushed);
      return drain.pr ? { ...step, drain: toPhase(drain, 'watching') } : step;
    case 'watching':
      return pushed ? startReviewer(step, pushed) : watching(step, run, facts, cfg);
    default:
      return step;
  }
}

/**
 * One reducer step for one drain run (spec §4.4).
 *
 * @param run - The run as the pass read it; a run without `drain`, a parked
 *   run, or a drain written by a newer flow (`v` above 1) comes back unchanged.
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
  const current = run.drain;
  if (!current || current.v !== 1 || current.phase === 'parked') return { run, actions: [] };

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
    return done(idle);
  }

  if (PRE_REVIEW_PHASES.has(recorded.phase) && recorded.pr === null && facts.prForBranch) {
    const parked = park(idle, PARK_REASONS.earlyPr);
    return done({
      drain: parked.drain,
      actions: [{ kind: 'disarm', pr: ref(facts.prForBranch) }, ...parked.actions],
    });
  }

  const step = phaseStep(idle, run, facts, cfg);
  if (run.limit && step.actions.some((a) => a.kind === 'send')) return done(idle);
  return done(step);
}
