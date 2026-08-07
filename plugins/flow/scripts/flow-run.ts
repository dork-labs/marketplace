/**
 * Crash & stall recovery (§12) — the **canonical typed oracle** for the `/flow`
 * engine's durable run record and next-tick recovery ladder.
 *
 * This module is the **pinned oracle** the v1 skill-based runtime is checked
 * against, and the **P5 promotion surface**: when the loop moves server-side
 * (DOR-89), the server imports {@link recoverOrphan} verbatim — the recovery
 * *decision* is a pure function of the durable {@link FlowRun}, the orphan
 * signal, and a small probe context, so it ports from skill to server without a
 * rewrite. Keep it pure: no I/O, no clock, no tracker calls. The runtime gathers
 * facts (does the worktree exist? is the session log intact? is the worker pid
 * alive?), hands them in via {@link RecoveryContext}, and *acts* on the returned
 * {@link RecoveryAction}.
 *
 * ## Sessions are ephemeral; the work is durable
 *
 * The checkpoint is the **git commit + the JSONL session**, not the live agent
 * process. So recovery **resumes** — re-attach the worktree at HEAD and `resume`
 * the captured {@link FlowRun.sessionId} — and **never restarts from scratch**
 * while a usable checkpoint survives. Only when the checkpoint is gone (no
 * worktree, or a corrupt/missing session log) does the ladder fall back to a
 * clean restart. See {@link RecoveryAction}.
 *
 * ## "Parked on a human" is a distinct, never-reclaimed state
 *
 * An item parked on the human (the `agent/needs-input` disposition) is NOT an
 * orphan: it is *waiting by design*, and resumes only when the human replies.
 * The stall sweep **never** reclaims it — see the `needs-input` branch of
 * {@link recoverOrphan}. This is the single most important invariant here.
 *
 * ## v1 vs v2 (what is built here)
 *
 * v1 is **sequential, single-machine, WIP 1**: it needs no heartbeat or lease,
 * because on a fresh tick any `agent/claimed` + In-Progress + not-`needs-input`
 * item is orphaned *by definition* — a {@link FlowRun.workerPid} liveness check
 * suffices. v2 (concurrent) layers on {@link FlowRun.heartbeatAt}, a fencing
 * token, atomic multi-claim, and a stall-detector tick — that is server residue
 * (DOR-89), **NOT built here**. {@link FlowRun.heartbeatAt} is carried as an
 * optional field only, unused by the v1 path.
 *
 * @see specs/unified-workflow-system/02-specification.md §12 (crash & stall recovery)
 * @see ./config-schema.ts ({@link RecoverySchema} — `maxRetries`/`onExhausted`/`staleAfter`)
 * @see ./work-item.ts (`AgentDisposition` — the durable `agent/*` state machine)
 * @module @dorkos/flow/flow-run
 */

import type { z } from 'zod';
import type { RecoverySchema } from './config-schema.ts';

/**
 * The lifecycle status of a {@link FlowRun}. Mirrors the §12 record's `status`
 * field. Distinct from the `AgentDisposition` (the *tracker* label state
 * machine): `status` is the engine's own view of where the run is in its
 * lifecycle, persisted in `flow-state.json`.
 *
 * - `queued` — claimed, run record written, worker not yet launched.
 * - `running` — a worker is (or was) actively driving the run.
 * - `waiting_for_review` — work is done and parked at the human review gate.
 * - `complete` — merged/closed; terminal.
 * - `failed` — escalated/abandoned after exhausting recovery; terminal.
 */
export type FlowRunStatus = 'queued' | 'running' | 'waiting_for_review' | 'complete' | 'failed';

/**
 * The spine stage a {@link FlowRun} is currently parked at (§1) — the canonical
 * stage model `capture → triage → ideate → specify → decompose → execute →
 * verify → review → done → (monitor → signal)`. The in-spine values mirror the
 * `StagesSchema` keys (`config-schema.ts`); `monitor`/`signal` are the post-`done`
 * follow-up stages the schema does not yet project but the spine names.
 *
 * Distinct from {@link FlowRunStatus}: `stage` is *where on the spine* the work
 * is, `status` is the *run lifecycle* (queued/running/…). A run can be `running`
 * at the `execute` stage, then `running` at `verify`, then `waiting_for_review`
 * at `review`. The `/flow:status` surface (task 5.1) reads this to render where
 * each in-flight item sits, and a resumed run re-enters at this stage.
 */
export type FlowStage =
  | 'capture'
  | 'triage'
  | 'ideate'
  | 'specify'
  | 'decompose'
  | 'execute'
  | 'verify'
  | 'review'
  | 'done'
  | 'monitor'
  | 'signal';

/**
 * **Where this run came from** — the origin the next session needs in order to
 * decide whether it can *continue* the worker that started the work, or must
 * start a fresh one from the durable artifacts.
 *
 * Every field is optional, and the rule is **omit, never fabricate**: a harness
 * that cannot tell you its own session id simply leaves `sessionId` out. A
 * fabricated value is worse than a missing one — a later tick would try to
 * continue a worker that never existed, and report a resume it did not perform.
 *
 * This block overlaps, on purpose, with the run's own {@link FlowRun.sessionId},
 * {@link FlowRun.worktreePath} and {@link FlowRun.branch}. Those three are flow's
 * **required coordinates** — always present, always flow's own values. Provenance
 * is the **self-contained, harness-reported origin**, which is why it is what gets
 * serialized outward (into the PR body's provenance comment and the tracker
 * stamp): a reader outside this repo gets one blob that answers "which harness,
 * on which machine, in which worktree" without having to know the record's shape.
 *
 * That overlap is made drift-safe by one rule: **provenance is written once, at
 * run start, and never reconciled afterwards.** When it disagrees with the
 * {@link FlowRun} coordinates, the coordinates win and the provenance copy is
 * stale by definition — it records where the run *began*, not where it is now.
 */
export interface FlowRunProvenance {
  /** The agent harness that ran the work, as it names itself. */
  harness?: string;
  /**
   * The harness's own session/conversation id for this run — the handle a later
   * tick would use to continue the same worker. Some harnesses do not expose one
   * directly but do write a transcript whose location encodes it; deriving it
   * from there is fine, guessing is not.
   */
  sessionId?: string;
  /** The delegated worker/agent id or name the harness assigned, when it assigns one. */
  agentId?: string;
  /**
   * The machine the run happened on. Load-bearing for the resume ladder: a
   * retained transcript is only reachable from the machine that holds it, so a
   * host mismatch is what rules rung 1 out.
   */
  host?: string;
  /** Absolute worktree path the run used, as the harness saw it. */
  worktree?: string;
  /** Git branch the run worked on. */
  branch?: string;
}

/**
 * The **durable run record** (§12) — the session↔issue association, keyed by
 * issue, written to `flow-state.json` (v1, disk) → server SQLite (v2). Follows
 * the ADR-0043 **file-first write-through** pattern: disk is the source of
 * truth, the (future) DB is a derived cache.
 *
 * Sessions are ephemeral; this record is the durable bridge that lets the next
 * tick *adopt* an orphaned run and **resume** it (re-attach
 * {@link worktreePath} at HEAD on {@link branch}, `resume` {@link sessionId})
 * rather than restart it.
 */
export interface FlowRun {
  /** Tracker-native issue id (the record's primary key — runs are keyed by issue). */
  issueId: string;
  /**
   * Human key, e.g. `"DOR-123"` — the worktree/branch key. Mirrors the
   * `WorkItem.identifier` field (carried here so the run record is
   * self-contained for resume).
   */
  identifier: string;
  /**
   * The Claude SDK JSONL session id captured for this run — the resume handle.
   * With the Pulse seat, `sessionId = run.id` is captured per run, making each
   * issue independently resumable.
   */
  sessionId: string;
  /** Absolute worktree path, e.g. `~/.dork/workspaces/<project>/<key>/`. */
  worktreePath: string;
  /** Git branch for the run, e.g. `dork/<key>`. */
  branch: string;
  /**
   * The spine stage the run is currently at (`capture … done`). Written on claim
   * and advanced at each stage transition; drives the `/flow:status` surface and
   * lets a resumed run re-enter at the right stage. See {@link FlowStage}.
   *
   * (Schema reconciliation, task 3.1: this typed `stage` field REPLACES the
   * ad-hoc `trigger`/`depth`/`gate`/`tasksFile` keys the v1 prose was writing
   * untyped — those are dropped; the run record carries only the typed schema.)
   */
  stage: FlowStage;
  /** Lifecycle status. */
  status: FlowRunStatus;
  /**
   * How many times this run has been (re)attempted. Incremented by the recovery
   * ladder on every reclaim ({@link recoverOrphan}); gated against
   * `recovery.maxRetries`.
   */
  attemptCount: number;
  /**
   * OS process id of the worker driving the run — the **v1** single-machine
   * liveness signal. A claimed, In-Progress, not-`needs-input` item whose
   * `workerPid` is not alive on a fresh tick is orphaned by definition.
   */
  workerPid: number;
  /**
   * **v2 (concurrent) field — not used by the v1 single-machine WIP-1 path.**
   * Last heartbeat timestamp (ISO-8601) for the concurrent stall-detector
   * (`recovery.staleAfter`). Carried as optional so the record shape is forward
   * compatible with the DOR-89 server build; v1 recovery never reads it.
   */
  heartbeatAt?: string;
  /** ISO-8601 timestamp the run started. */
  startedAt: string;
  /** ISO-8601 timestamp the run completed, or `undefined` while in flight. */
  completedAt?: string;
  /**
   * Where this run came from — harness, session, worker, machine, worktree,
   * branch. Written at claim with whatever the running harness can actually
   * determine, and absent entirely on a harness that can determine nothing. See
   * {@link FlowRunProvenance}.
   */
  provenance?: FlowRunProvenance;
}

/** The inferred {@link RecoverySchema} config type (`maxRetries`/`onExhausted`/`staleAfter`). */
export type RecoveryConfig = z.infer<typeof RecoverySchema>;

/**
 * The orphan signal that drove the next tick to consider a run for recovery —
 * the **disposition**, not comment presence (§12). Derived from the durable
 * `agent/*` label group on the tracker item plus its workflow state:
 *
 * - `needs-input` — `agent/needs-input`: parked on the human; **never an orphan
 *   to reclaim**, resumes only on the human's reply.
 * - `claimed-no-worker` — `agent/claimed` + In-Progress with **no live worker**
 *   (the v1 orphan: a `workerPid` liveness check failed). The ladder adopts +
 *   resumes (or restart-cleans) it.
 * - `no-local-record` — In-Progress on the tracker but there is **no local
 *   {@link FlowRun}** for it (e.g. claimed on another machine). Re-derive the
 *   run from tracker + workspace (tracker-as-truth).
 */
export type OrphanSignal = 'needs-input' | 'claimed-no-worker' | 'no-local-record';

/**
 * The probe facts the runtime gathers (impurely) and injects into the pure
 * {@link recoverOrphan} ladder. Keeping the I/O at the call site is what makes
 * the recovery *decision* a pure, server-portable oracle.
 */
export interface RecoveryContext {
  /**
   * Whether the run's {@link FlowRun.worktreePath} still exists on disk — half
   * of the durable checkpoint. Absent ⇒ the git commit is gone ⇒ no resume.
   */
  worktreeExists: boolean;
  /**
   * Whether the run's {@link FlowRun.sessionId} JSONL log is present and
   * parseable — the other half of the checkpoint. Corrupt/missing ⇒ no resume.
   */
  sessionLogIntact: boolean;
}

/** Tracker label applied when recovery exhausts its retries and escalates (§12). */
export const RECOVERY_BLOCKED_LABEL = 'agent/blocked';

/**
 * The kinds the next-tick recovery ladder (§12) can produce. A discriminated
 * union (over {@link RecoveryAction.kind}) rather than boolean flags, so every
 * branch is exhaustively handled at the call site.
 */
export type RecoveryActionKind = 'skip' | 'resume' | 'restart-clean' | 'escalate' | 're-derive';

/**
 * The resolved outcome of the next-tick recovery ladder (§12) — a discriminated
 * union over {@link RecoveryAction.kind}. Each variant carries exactly the
 * fields its branch acts on.
 *
 * - `skip` — the item is parked on a human (`needs-input`): leave it untouched;
 *   it resumes only on the human's reply. **Never** reclaimed; `attemptCount` is
 *   untouched.
 * - `resume` — adopt the surviving checkpoint: re-attach the worktree at HEAD
 *   and `resume` the JSONL session. Carries the incremented `attemptCount`.
 * - `restart-clean` — the checkpoint is gone (no worktree, or a corrupt session
 *   log) but retries remain: discard and restart cleanly. Carries the
 *   incremented `attemptCount`.
 * - `escalate` — retries are exhausted (`attemptCount >= recovery.maxRetries`):
 *   apply `agent/blocked`, comment, and nudge; the loop blocks on the human.
 * - `re-derive` — no local run record (claimed on another machine): rebuild the
 *   run from tracker + workspace (tracker-as-truth), then adopt it.
 */
export type RecoveryAction =
  | {
      kind: 'skip';
      /** Why the sweep left the item untouched (parked on a human). */
      reason: 'parked-on-human';
    }
  | {
      kind: 'resume';
      /**
       * `attemptCount` after the increment this reclaim applies. The runtime
       * persists this back onto the {@link FlowRun}.
       */
      attemptCount: number;
    }
  | {
      kind: 'restart-clean';
      /** Why the checkpoint could not be resumed. */
      reason: 'no-worktree' | 'session-log-corrupt';
      /** `attemptCount` after the increment this reclaim applies. */
      attemptCount: number;
    }
  | {
      kind: 'escalate';
      /** `agent/blocked` — the durable escalation label. */
      label: typeof RECOVERY_BLOCKED_LABEL;
      /** Human-readable reason retries were exhausted, for the escalation comment. */
      reason: string;
    }
  | {
      kind: 're-derive';
      /** Why a run had to be reconstructed: there was no local record. */
      reason: 'no-local-record';
    };

/**
 * Whether the surviving checkpoint (git commit + JSONL session) is intact enough
 * to **resume** rather than restart. Both halves must hold: the worktree must
 * exist (the commit) AND the session log must be intact (the JSONL).
 *
 * @param ctx - The probe facts gathered by the runtime.
 * @returns `true` when both checkpoint halves survive.
 */
function checkpointResumable(ctx: RecoveryContext): boolean {
  return ctx.worktreeExists && ctx.sessionLogIntact;
}

/**
 * **The next-tick recovery ladder (§12).** A pure decision driven by the orphan
 * **disposition**, the durable {@link FlowRun}, the probe {@link RecoveryContext},
 * and the {@link RecoveryConfig} — returns the {@link RecoveryAction} the runtime
 * should take. No I/O, no clock: the runtime gathers facts and acts on the
 * result, so this same function ports verbatim to the P5 server (DOR-89).
 *
 * The ladder, in order:
 *
 * 1. **`needs-input` ⇒ `skip`.** Parked on a human is a *distinct* state the
 *    stall sweep never reclaims; `attemptCount` is untouched. Checked first so
 *    nothing below can ever reclaim a parked item.
 * 2. **`no-local-record` ⇒ `re-derive`.** In-Progress on the tracker with no
 *    local {@link FlowRun} (claimed on another machine): reconstruct from tracker
 *    + workspace (tracker-as-truth). `run` is absent for this signal.
 * 3. **Retries exhausted ⇒ `escalate`.** When `run.attemptCount >=
 *    recovery.maxRetries` there is no reclaim left: apply
 *    {@link RECOVERY_BLOCKED_LABEL}, comment, and nudge.
 * 4. **Checkpoint survives ⇒ `resume`** (re-attach worktree at HEAD, `resume`
 *    the session); **else ⇒ `restart-clean`.** Either way `attemptCount` is
 *    incremented by exactly one and returned for the runtime to persist.
 *
 * The `claimed-no-worker` signal flows through steps 3–4. v1 needs no heartbeat:
 * the caller only emits this signal once a {@link FlowRun.workerPid} liveness
 * check has already established the worker is dead.
 *
 * @param signal - The orphan disposition that triggered the sweep.
 * @param run - The durable run record, or `null`/`undefined` for the
 *   `no-local-record` signal (there is, by definition, no local record).
 * @param ctx - The probe facts (`worktreeExists`, `sessionLogIntact`).
 * @param recovery - The resolved recovery config (`maxRetries`, …).
 * @returns The action the runtime should take.
 * @throws If `signal` is `claimed-no-worker` or `needs-input` but `run` is
 *   absent — those signals are defined only for an item with a local record.
 */
export function recoverOrphan(
  signal: OrphanSignal,
  run: FlowRun | null | undefined,
  ctx: RecoveryContext,
  recovery: RecoveryConfig
): RecoveryAction {
  // 1. Parked on a human — never reclaimed, resumes only on the human's reply.
  if (signal === 'needs-input') {
    return { kind: 'skip', reason: 'parked-on-human' };
  }

  // 2. No local record (other machine) — tracker-as-truth re-derivation. By
  // definition there is no `run` to adopt; rebuild it from tracker + workspace.
  if (signal === 'no-local-record') {
    return { kind: 're-derive', reason: 'no-local-record' };
  }

  // From here `signal === 'claimed-no-worker'`, which is only defined for an
  // item that HAS a local run record.
  if (run === null || run === undefined) {
    throw new Error(
      `recoverOrphan: signal "${signal}" requires a local FlowRun, but none was provided`
    );
  }

  // 3. Retries exhausted — escalate (apply agent/blocked + comment + nudge).
  if (run.attemptCount >= recovery.maxRetries) {
    return {
      kind: 'escalate',
      label: RECOVERY_BLOCKED_LABEL,
      reason: `recovery retries exhausted (attemptCount ${run.attemptCount} >= maxRetries ${recovery.maxRetries})`,
    };
  }

  // 4. Reclaim — every reclaim counts as one attempt.
  const attemptCount = run.attemptCount + 1;

  // Resume when the checkpoint (git commit + JSONL session) survives; otherwise
  // restart cleanly. The checkpoint — not the dead worker — is the source of truth.
  if (checkpointResumable(ctx)) {
    return { kind: 'resume', attemptCount };
  }
  return {
    kind: 'restart-clean',
    reason: ctx.worktreeExists ? 'session-log-corrupt' : 'no-worktree',
    attemptCount,
  };
}
