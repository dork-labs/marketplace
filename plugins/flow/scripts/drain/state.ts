/**
 * A run's drain state and limit (spec `flow-handoff-dispatch` §4.3, §5.1): the
 * types, and the schemas the `flow-state.json` reader checks them with.
 *
 * Both live on the run record as optional fields (`FlowRun.drain`,
 * `FlowRun.limit`). They are flow's own: every reader passes unknown fields
 * through and DorkOS reads only `identifier`, `sessionId`, `stage` and
 * `status`, so adding them is not a change to the shared contract.
 *
 * **Why the phases are fields, not statuses.** `FlowRunStatus` is an enum inside
 * an all-or-nothing reader: a new status value would make every older reader
 * reject the whole file. For the same reason, every vocabulary in here (phase,
 * host, verdict, limit level and state, handoff reason) is checked only as a
 * string, the way `FlowRun.host` is. The TypeScript types pin the values flow
 * writes; the schema refuses only the wrong type, so a record from a newer flow
 * still reads, and code that meets a value it does not know leaves that run
 * alone.
 *
 * Every object is a `z.looseObject`, so unknown nested fields survive a
 * read-modify-write by an older writer.
 *
 * **Who writes which field** (§4.3): the report verbs own `pushedSha`,
 * `verdict`, `reviewedSha`, `reviewRound` and `pr`; the supervisor owns the
 * rest. Every writer bumps {@link DrainState.rev} in the same locked write.
 *
 * @module @dorkos/flow/drain/state
 */

import { z } from 'zod';

import type { HostName, SessionHandle } from '../launchers/types.ts';

/** Where a drain run is in its loop. */
export type DrainPhase =
  'working' | 'reviewing' | 'fixing' | 'pr-ready' | 'watching' | 'fixing-ci' | 'closing' | 'parked';

/** Every {@link DrainPhase}, in loop order. */
export const DRAIN_PHASES: readonly DrainPhase[] = [
  'working',
  'reviewing',
  'fixing',
  'pr-ready',
  'watching',
  'fixing-ci',
  'closing',
  'parked',
];

/**
 * A worker's session handle. `pending` is the intent written before launch
 * (§4.3): the minted session id is claimed in the slot, then `start` is called.
 */
export interface DrainWorkerHandle extends SessionHandle {
  /** `true` while the slot holds the intent and the session is not yet confirmed started. */
  pending?: boolean;
}

/** A reviewer's session handle: the SHA it reviews, where, and its token's hash. */
export interface DrainReviewerHandle extends DrainWorkerHandle {
  /** The commit under review. */
  sha: string;
  /** The detached review worktree (absolute). */
  worktree: string;
  /** Hash of the token the reviewer's `flow report` must present (§4.5). */
  tokenHash: string;
}

/** The pull request a drain run opened. */
export interface DrainPullRequest {
  /** `owner/name`. */
  repo: string;
  /** The PR number. */
  number: number;
  /** The PR's web address. */
  url: string;
  /** Whether auto-merge is armed. */
  armed: boolean;
  /** Whether flow disarmed auto-merge while a review round runs. */
  disarmedForReview: boolean;
}

/** One move of a run between accounts. */
export interface DrainHandoff {
  /** The account moved from, or `null` for the ambient account. */
  from: string | null;
  /** The account moved to, or `null` for the ambient account. */
  to: string | null;
  /** When (ISO). */
  at: string;
  /** Why: a warning, a rejected request, the operator, or a window reset. */
  reason: 'warning' | 'rejected' | 'manual' | 'reset';
}

/** A drain run's state (§4.3), stored at `FlowRun.drain`. */
export interface DrainState {
  /** Schema version, `1` today. */
  v: number;
  /** Bumped by every write, by every writer; the supervisor's compare-and-set reads it. */
  rev: number;
  /** Where the run is in its loop. */
  phase: DrainPhase;
  /** The worker's session, or `null` between sessions. */
  worker: DrainWorkerHandle | null;
  /** The reviewer's session, or `null` when no review runs. */
  reviewer: DrainReviewerHandle | null;
  /** The last SHA the worker reported pushed. */
  pushedSha: string | null;
  /** The SHA of the latest verdict. */
  reviewedSha: string | null;
  /** The latest verdict. */
  verdict: 'clean' | 'changes' | null;
  /** Verdicts so far. */
  reviewRound: number;
  /** The run's pull request, once open. */
  pr: DrainPullRequest | null;
  /** The head SHA an innocent merge-queue ejection was re-armed for (once per SHA). */
  rearmedFor: string | null;
  /** "You stopped without reporting" messages sent in this phase. */
  nudges: number;
  /** Skip this run until then (ISO). */
  wakeAfter: string | null;
  /** Every move between accounts, oldest first. */
  handoffs: DrainHandoff[];
  /** Why the run parked, when `phase` is `parked`. */
  parkedReason: string | null;
}

/** A run's account limit episode (§5.1), stored at `FlowRun.limit`. */
export interface RunLimit {
  /** How bad: close to a ceiling, or at it. */
  level: 'warning' | 'exhausted';
  /** The account that hit it, or `null` for the ambient account. */
  account: string | null;
  /** The rate-limit window. */
  window: string | null;
  /** When the window resets (ISO). */
  resetsAt: string | null;
  /** The real limit, or the account's reserve. */
  cause: 'limit' | 'reserve';
  /** When the episode began (ISO). */
  since: string;
  /** Where the handoff machine (§5.2) is. */
  state: 'winding-down' | 'awaiting-handoff' | 'pending-approval' | 'waiting-reset' | 'handing-off';
  /** Set with `handing-off`, so only one mover wins (§4.3). */
  handoffToken: string | null;
  /** When `handing-off` was set (ISO). */
  handingOffAt: string | null;
  /** The session id minted for the new session, for adoption. */
  handoffSessionId: string | null;
  /** When the ask-mode comment was posted, once per episode (ISO). */
  notifiedAt: string | null;
}

/**
 * A vocabulary field: typed as the union `T`, checked on disk only as a string
 * (see the module comment for why).
 */
function vocabulary<T extends string>(): z.ZodType<T> {
  return z.custom<T>((value) => typeof value === 'string');
}

const nullableString = z.string().nullable();
const count = z.number().int().nonnegative();

/** The on-disk check for a {@link SessionHandle}. */
export const SessionHandleSchema: z.ZodType<SessionHandle> = z.looseObject({
  host: vocabulary<HostName>(),
  sessionId: z.string(),
  account: nullableString,
  cwd: z.string(),
  pid: z.number().int().optional(),
  surface: z.string().optional(),
  workspace: z.string().optional(),
  logFile: z.string().optional(),
  logOffset: count.optional(),
});

const workerHandleShape = {
  host: vocabulary<HostName>(),
  sessionId: z.string(),
  account: nullableString,
  cwd: z.string(),
  pid: z.number().int().optional(),
  surface: z.string().optional(),
  workspace: z.string().optional(),
  logFile: z.string().optional(),
  logOffset: count.optional(),
  pending: z.boolean().optional(),
};

/** The on-disk check for a {@link DrainWorkerHandle}. */
export const DrainWorkerHandleSchema: z.ZodType<DrainWorkerHandle> =
  z.looseObject(workerHandleShape);

/** The on-disk check for a {@link DrainReviewerHandle}. */
export const DrainReviewerHandleSchema: z.ZodType<DrainReviewerHandle> = z.looseObject({
  ...workerHandleShape,
  sha: z.string(),
  worktree: z.string(),
  tokenHash: z.string(),
});

/** The on-disk check for a {@link DrainState}. */
export const DrainStateSchema: z.ZodType<DrainState> = z.looseObject({
  v: z.number().int().positive(),
  rev: count,
  phase: vocabulary<DrainPhase>(),
  worker: DrainWorkerHandleSchema.nullable(),
  reviewer: DrainReviewerHandleSchema.nullable(),
  pushedSha: nullableString,
  reviewedSha: nullableString,
  verdict: vocabulary<'clean' | 'changes'>().nullable(),
  reviewRound: count,
  pr: z
    .looseObject({
      repo: z.string(),
      number: z.number().int().positive(),
      url: z.string(),
      armed: z.boolean(),
      disarmedForReview: z.boolean(),
    })
    .nullable(),
  rearmedFor: nullableString,
  nudges: count,
  wakeAfter: nullableString,
  handoffs: z.array(
    z.looseObject({
      from: nullableString,
      to: nullableString,
      at: z.string(),
      reason: vocabulary<DrainHandoff['reason']>(),
    })
  ),
  parkedReason: nullableString,
});

/** The on-disk check for a {@link RunLimit}. */
export const RunLimitSchema: z.ZodType<RunLimit> = z.looseObject({
  level: vocabulary<RunLimit['level']>(),
  account: nullableString,
  window: nullableString,
  resetsAt: nullableString,
  cause: vocabulary<RunLimit['cause']>(),
  since: z.string(),
  state: vocabulary<RunLimit['state']>(),
  handoffToken: nullableString,
  handingOffAt: nullableString,
  handoffSessionId: nullableString,
  notifiedAt: nullableString,
});
