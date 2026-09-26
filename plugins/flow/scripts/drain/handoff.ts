/**
 * The handoff state machine (spec `flow-handoff-dispatch` §5.2, §5.2a) as a
 * pure reducer: one run's limit episode plus what a pass observed, in; the next
 * `RunLimit` and the actions to take, out.
 *
 * The runner calls {@link nextHandoffAction} for every drain run, every pass,
 * before `drainStep`. While `run.limit` is set this reducer owns the worker:
 * `drainStep` records reports and sends it nothing.
 *
 * **The rows, in the order they are checked**
 *
 * - A limited reviewer is stopped and a fresh one starts at the same SHA on
 *   another account (`restart-reviewer`). No `RunLimit`: a review restarts
 *   cheaply.
 * - (no limit): `warning` starts a `winding-down` episode and sends
 *   `wind-down`; `exhausted` starts an `awaiting-handoff` one.
 * - A person's wait (`heldBy: "person"`, `flow handoff --wait`) outranks every
 *   automatic move: the run resumes on its own account when that account is
 *   `ok` again, and nothing else happens until `heldUntil` passes.
 * - `winding-down`: clears when the signal is `ok` again (a reset); moves on
 *   when the account is exhausted, when the worker wrote its `limit-warning`
 *   checkpoint and stopped, or when it stopped without one and the grace time
 *   passed (flow then writes a synthesized checkpoint).
 * - `awaiting-handoff`, checked in this order: wait on the same account when
 *   its window resets within `waitIfResetWithinMinutes`; continue on the next
 *   model when only a model's bucket is out and the host can switch models
 *   (the limit clears once the host took the switch, see the runner);
 *   make sure a checkpoint newer than the episode exists; then hand off (auto)
 *   or ask once (ask); with no candidate, wait for the earliest known reset.
 * - `pending-approval`: resume here once the run's own account is `ok`; the
 *   operator's `flow handoff` otherwise moves it.
 * - `waiting-reset`: at `drain.wakeAfter`, resume here if the account is `ok`,
 *   else act as `awaiting-handoff`.
 * - `handing-off` older than the start timeout: the mover died; the runner
 *   adopts the session it minted or reverts (`adopt-or-revert-handoff`).
 *
 * Resuming on the same account is not a move between accounts, so `ask` mode
 * allows it without approval (Decision D5), and so does the wait-if-soon row.
 * Every transition into `awaiting-handoff` is decided in the same pass, so an
 * account flipped to rejected mid-item is handed off by the next pass.
 *
 * The move itself (the `handing-off` compare-and-set, the stop, the start and
 * the rewrite of the run) is `executeHandoff` in `handoff-exec.ts`; this module
 * only decides. It never clears the limit of a run it hands off: the move does,
 * once the new session started, so no other step talks to the old worker in
 * between.
 *
 * Pure and dependency-free (type imports and local zero-dependency modules
 * only), so it runs before `npm install`. `now` is always an input.
 *
 * @module @dorkos/flow/drain/handoff
 */

import type { FlowRun } from '../flow-run.ts';
import { handleRuntime, type SessionHandle, type SessionState } from '../launchers/types.ts';
import {
  limitSignal,
  type AccountRef,
  type LedgerWindows,
  type LimitSignal,
} from './account-rank.ts';
import type { ResolvedAccountPolicy } from '../fleet/accounts.ts';
import type { RuntimeSlug } from '../fleet/usage-ledger.ts';
import type { SendAction } from './drain-step.ts';
import type { DrainHandoff, DrainState, DrainWorkerHandle, RunLimit } from './state.ts';

/** How long to wait when no reset time is known (spec §5.2 `waiting-reset`). */
export const UNKNOWN_RESET_WAIT_MS = 30 * 60 * 1000;

/** Whether flow moves a limited run by itself (`auto`) or asks first (`ask`). */
export type HandoffPolicyMode = 'auto' | 'ask';

/** Why a run moved between accounts (the `drain.handoffs` reason). */
export type HandoffReason = DrainHandoff['reason'];

/** The newest checkpoint in the worker's worktree, as the reducer needs it. */
export interface HandoffCheckpoint {
  /** Its `trigger` header field. */
  trigger: string;
  /** Its `writtenAt` header field (ISO). */
  writtenAt: string;
}

/** Where the run could go: `rankAccounts` with the run's account excluded and no affinity. */
export interface HandoffCandidates {
  /** The best eligible (runtime, account), or `null` when nothing is eligible. */
  pick: AccountRef | null;
  /**
   * The `resetsAt` of every account left out as `limited` or `near-limit`, so a
   * run with no candidate wakes at the earliest one.
   */
  resets: readonly (string | null)[];
}

/** The drain settings the reducer reads. */
export interface HandoffConfig {
  /** Minutes a warned worker has to checkpoint before flow writes one (`drain.windDownGraceMinutes`). */
  windDownGraceMinutes: number;
  /** Wait on the same account when its limit resets this soon (`drain.waitIfResetWithinMinutes`). */
  waitIfResetWithinMinutes: number;
  /** How long a `handing-off` mark may stand before its mover counts as dead (ms). */
  startTimeoutMs: number;
  /** The full flow command prefix messages spell verbs with. */
  flow: string;
}

/** Everything {@link nextHandoffAction} decides from. */
export interface HandoffInput {
  /** The run as the pass read it. */
  run: FlowRun;
  /** The run's account's signal: the worse of its ledger and the worker's launcher state ({@link combineSignal}). */
  signal: LimitSignal;
  /** The worker's state from its launcher, or `null` when no worker has started. */
  session: SessionState | null;
  /** The reviewer's state from its launcher, or `null` when no reviewer has started. */
  reviewer: SessionState | null;
  /** The worktree's current checkpoint header, or `null` when there is none. */
  checkpoint: HandoffCheckpoint | null;
  /** `fleet.handoff` and `fleet.crossRuntimeFallback`. */
  policy: { handoff: HandoffPolicyMode; crossRuntimeFallback: 'off' | 'on' };
  /** Where the run could go. */
  candidates: HandoffCandidates;
  /**
   * The next model in `drain.modelFallback` for the run's runtime whose bucket
   * has room ({@link pickFallbackModel}), or `null` when there is none or the
   * host cannot switch a session's model.
   */
  modelFallback: string | null;
  /** The run's account's label, for messages. */
  accountLabel: string;
  /** The pass's clock. */
  now: Date;
  /** The drain settings. */
  cfg: HandoffConfig;
}

/**
 * One thing the runner does for the handoff machine.
 *
 * - `send`: a message to the worker (`wind-down`, `limit-cleared`); a
 *   `limit-cleared` with `model` asks the host to switch the session's model.
 * - `synthesize-checkpoint`: write `HANDOFF.md` for a session that stopped
 *   without a fresh one; `reason` goes into its open questions.
 * - `handoff`: move the run to `to` (spec §5.3).
 * - `notify`: the ask-mode comment naming `candidate`, once per episode.
 * - `restart-reviewer`: stop the limited reviewer and clear its worktree; the
 *   drain reducer then starts a fresh one at the same SHA, and `exclude` keeps
 *   it off the limited account.
 * - `adopt-or-revert-handoff`: a `handing-off` mark outlived its mover.
 */
export type HandoffAction =
  | SendAction
  | { kind: 'synthesize-checkpoint'; reason: string }
  | { kind: 'handoff'; to: AccountRef; reason: HandoffReason }
  | { kind: 'notify'; candidate: AccountRef }
  | { kind: 'restart-reviewer'; handle: SessionHandle; exclude: string }
  | { kind: 'adopt-or-revert-handoff' };

/** What {@link nextHandoffAction} returns. */
export interface HandoffResult {
  /** The run with its next `limit` (and `drain.wakeAfter`, `drain.reviewer`). */
  run: FlowRun;
  /** What to do, in order. */
  actions: HandoffAction[];
}

/** The `<runtime>:<id>` key of an account; no account is the runtime's implicit `default`. */
export function accountKeyOf(
  runtime: string | undefined,
  account: string | null | undefined
): string {
  return `${runtime ?? 'claude-code'}:${account ?? 'default'}`;
}

/** Whether a window key is a model's own bucket (it binds only sessions on that model). */
export function isModelBucket(window: string | null): boolean {
  return window !== null && (window.startsWith('model:') || window.startsWith('seven_day_'));
}

const LEVEL_RANK: Record<LimitSignal['level'], number> = {
  ok: 0,
  unknown: 1,
  warning: 2,
  exhausted: 3,
};

/**
 * The signal a pass acts on (§5.1): the worse of the account's ledger signal
 * and the worker's launcher state, where `limited` counts as exhausted. A
 * `limited` state whose reset time has passed no longer counts (a stopped
 * session keeps reporting its last limit). The ambient account has no ledger:
 * pass `null` and the launcher state alone decides.
 *
 * @param ledger - The account's `limitSignal`, or `null` for the ambient account.
 * @param session - The worker's launcher state, or `null`.
 * @param now - The pass's clock.
 * @returns The combined signal.
 */
export function combineSignal(
  ledger: LimitSignal | null,
  session: SessionState | null,
  now: Date
): LimitSignal {
  const base: LimitSignal = ledger ?? { level: 'ok', window: null, resetsAt: null, cause: null };
  if (session?.kind !== 'limited') return base;
  if (session.resetsAt !== null && Date.parse(session.resetsAt) <= now.getTime()) return base;
  const fromSession: LimitSignal = {
    level: 'exhausted',
    window: session.window,
    resetsAt: session.resetsAt,
    cause: 'limit',
  };
  if (LEVEL_RANK[base.level] < LEVEL_RANK.exhausted) return fromSession;
  // Both exhausted: the ledger names the window; keep the later reset, the one that binds.
  const later =
    base.resetsAt === null ||
    (session.resetsAt !== null && Date.parse(session.resetsAt) > Date.parse(base.resetsAt));
  return later ? { ...base, resetsAt: session.resetsAt ?? base.resetsAt } : base;
}

/** Input to {@link pickFallbackModel}. */
export interface FallbackModelInput {
  /** The run's runtime. A fallback never crosses runtimes. */
  runtime: RuntimeSlug;
  /** `drain.modelFallback[runtime]`, in order: tier names or model ids. */
  list: readonly string[];
  /** `models.bindings`, which resolves a tier name to a model. */
  bindings: Readonly<Record<string, string>>;
  /** The model the session runs now, or `null`. */
  current: string | null;
  /** The account's ledger windows. */
  windows: LedgerWindows;
  /** The ledger's raw `spend`. */
  spend?: unknown;
  /** The account's resolved policy. */
  policy: ResolvedAccountPolicy;
  /** `drain.warnMarginPct`. */
  warnMarginPct: number;
  /** Whether the run's host can switch a session's model (`modelSwitchFor`). */
  canSwitch: boolean;
  /** The pass's clock. */
  now: Date;
}

/**
 * The model a run continues on when only its model's bucket is out (§5.2a):
 * the first model after the current one in `drain.modelFallback[runtime]`
 * (each entry resolved through `models.bindings`) whose account still has room
 * on every window it would use, `five_hour` and `seven_day` included. `null`
 * when the list is empty, the host cannot switch, the current signal is not
 * model-scoped, or no later model has room.
 *
 * @param input - The runtime, list, bindings, current model, ledger, policy and clock.
 * @returns The model to switch to, or `null`.
 */
export function pickFallbackModel(input: FallbackModelInput): string | null {
  if (!input.canSwitch || input.list.length === 0) return null;
  const judge = (model: string | null) =>
    limitSignal({
      runtime: input.runtime,
      windows: input.windows,
      spend: input.spend,
      policy: input.policy,
      model,
      now: input.now,
      warnMarginPct: input.warnMarginPct,
    });
  const here = judge(input.current);
  if (here.level !== 'exhausted' || !isModelBucket(here.window)) return null;
  const resolved = input.list.map((entry) => input.bindings[entry] ?? entry);
  const at = input.current === null ? -1 : resolved.indexOf(input.current);
  for (const model of resolved.slice(at + 1)) {
    if (model === input.current) continue;
    const level = judge(model).level;
    if (level === 'ok' || level === 'unknown') return model;
  }
  return null;
}

/**
 * Whether a signal says the limit is gone: `ok`, or `unknown` (nothing trips,
 * some window has no reading). A model bucket the ledger has never seen reads
 * as no reading, so an account with a bound model is often `unknown` rather
 * than `ok`; like eligibility (Decision D13), no reading is not a limit.
 */
function clear(signal: LimitSignal): boolean {
  return signal.level === 'ok' || signal.level === 'unknown';
}

/** A session that is not running a turn: idle, gone, or stopped by a limit. */
function stopped(state: SessionState | null): boolean {
  return state?.kind === 'idle' || state?.kind === 'exited' || state?.kind === 'limited';
}

/** A stored handle as a launcher takes it. */
function launchHandle(handle: DrainWorkerHandle): SessionHandle {
  const { pending: _pending, pendingSince: _since, ...rest } = handle;
  return { ...rest, runtime: handleRuntime(handle) };
}

/** The handoff reason for an episode's level. */
function reasonFor(limit: RunLimit): HandoffReason {
  return limit.level === 'warning' ? 'warning' : 'rejected';
}

/** The working state of one decision. */
interface Work {
  limit: RunLimit | undefined;
  drain: DrainState;
  actions: HandoffAction[];
  /** A checkpoint newer than the episode exists, or was asked for this pass. */
  checkpointed: boolean;
}

/**
 * One handoff step for one drain run (§5.2, §5.2a).
 *
 * @param input - The run, its signal, sessions, checkpoint, policy, candidates, fallback model, clock and settings.
 * @returns The run with its next limit, and the actions to apply in order.
 */
export function nextHandoffAction(input: HandoffInput): HandoffResult {
  const { run, now, cfg } = input;
  const drain = run.drain;
  if (!drain || drain.v !== 1 || drain.phase === 'parked' || drain.phase === 'closing') {
    return { run, actions: [] };
  }
  const nowIso = now.toISOString();
  const work: Work = {
    limit: run.limit,
    drain,
    actions: [],
    checkpointed: false,
  };

  // A limited reviewer restarts at the same SHA elsewhere; no episode.
  const reviewer = drain.reviewer;
  if (reviewer !== null && !reviewer.pending && input.reviewer?.kind === 'limited') {
    work.drain = { ...work.drain, reviewer: null };
    work.actions.push({
      kind: 'restart-reviewer',
      handle: launchHandle(reviewer),
      exclude: accountKeyOf(handleRuntime(reviewer), reviewer.account),
    });
  }

  const worker = drain.worker;
  if (worker !== null && !worker.pending) decideWorker(work, input, nowIso);

  const next: FlowRun = { ...run, drain: work.drain };
  if (work.limit === undefined) delete next.limit;
  else next.limit = work.limit;
  return { run: next, actions: work.actions };

  /** The worker's episode, row by row. */
  function decideWorker(w: Work, inp: HandoffInput, iso: string): void {
    const signal = inp.signal;
    const newer = (cp: HandoffCheckpoint | null, since: string, trigger?: string) =>
      cp !== null &&
      Date.parse(cp.writtenAt) > Date.parse(since) &&
      (trigger === undefined || cp.trigger === trigger);

    if (w.limit === undefined) {
      if (signal.level === 'warning') {
        w.limit = episode(signal, 'warning', 'winding-down', iso);
        w.actions.push({
          kind: 'send',
          message: 'wind-down',
          ctx: {
            flow: cfg.flow,
            identifier: run.identifier,
            accountLabel: inp.accountLabel,
            windowLabel: windowLabel(signal.window),
          },
        });
        return;
      }
      if (signal.level !== 'exhausted') return;
      w.limit = episode(signal, 'exhausted', 'awaiting-handoff', iso);
    }
    const limit = w.limit;
    w.checkpointed = newer(inp.checkpoint, limit.since);

    if (limit.state === 'handing-off') {
      const at = Date.parse(limit.handingOffAt ?? '');
      if (!Number.isFinite(at) || now.getTime() - at > cfg.startTimeoutMs) {
        w.actions.push({ kind: 'adopt-or-revert-handoff' });
      }
      return;
    }

    if (limit.heldBy === 'person') {
      if (clear(signal)) return resumeHere(w, inp);
      const until = limit.heldUntil ? Date.parse(limit.heldUntil) : NaN;
      if (!Number.isFinite(until) || now.getTime() < until) return;
      // The person's time passed: the hold lifts and the run waits as usual.
      const { heldBy: _by, heldUntil: _until, ...rest } = limit;
      w.limit = rest;
      w.drain = { ...w.drain, wakeAfter: iso };
    }

    const state = w.limit.state;
    if (state === 'winding-down') {
      if (clear(signal)) {
        w.limit = undefined;
        if (stopped(inp.session)) sendCleared(w, inp, null);
        return;
      }
      if (signal.level === 'exhausted') {
        w.limit = { ...escalate(w.limit, signal), state: 'awaiting-handoff' };
      } else if (newer(inp.checkpoint, w.limit.since, 'limit-warning') && stopped(inp.session)) {
        w.limit = { ...w.limit, state: 'awaiting-handoff' };
      } else if (
        stopped(inp.session) &&
        now.getTime() - Date.parse(w.limit.since) >= cfg.windDownGraceMinutes * 60_000
      ) {
        w.actions.push({
          kind: 'synthesize-checkpoint',
          reason: 'stopped after the usage warning without writing a checkpoint',
        });
        w.checkpointed = true;
        w.limit = { ...w.limit, state: 'awaiting-handoff' };
      } else {
        return;
      }
      return awaiting(w, inp, iso);
    }
    if (state === 'awaiting-handoff') {
      if (signal.level === 'exhausted') w.limit = escalate(w.limit, signal);
      return awaiting(w, inp, iso);
    }
    if (state === 'pending-approval') {
      if (clear(signal)) return resumeHere(w, inp);
      return;
    }
    if (state === 'waiting-reset') {
      const wake = Date.parse(w.drain.wakeAfter ?? '');
      if (Number.isFinite(wake) && now.getTime() < wake) return;
      if (clear(signal)) return resumeHere(w, inp);
      if (signal.level === 'exhausted') w.limit = escalate(w.limit, signal);
      return awaiting(w, inp, iso);
    }
  }

  /** `awaiting-handoff`: the §5.2a rows first, then checkpoint, then move, ask or wait. */
  function awaiting(w: Work, inp: HandoffInput, iso: string): void {
    const limit = w.limit as RunLimit;
    const resetsMs = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
    const soon = cfg.waitIfResetWithinMinutes * 60_000;
    if (Number.isFinite(resetsMs) && resetsMs > now.getTime() && resetsMs - now.getTime() <= soon) {
      w.limit = { ...limit, state: 'waiting-reset' };
      w.drain = { ...w.drain, wakeAfter: limit.resetsAt };
      return;
    }
    if (
      limit.level === 'exhausted' &&
      isModelBucket(limit.window) &&
      limit.modelSwitch !== 'unsupported' &&
      inp.modelFallback !== null
    ) {
      // The limit stays until the host confirms the switch: the runner clears it
      // then, or marks `modelSwitch: unsupported` so the next pass hands off.
      w.limit = { ...limit, state: 'awaiting-handoff' };
      w.drain = { ...w.drain, wakeAfter: null };
      sendCleared(w, inp, inp.modelFallback);
      return;
    }
    if (!w.checkpointed) {
      w.actions.push({
        kind: 'synthesize-checkpoint',
        reason:
          limit.level === 'warning'
            ? 'stopped near a usage limit without a newer checkpoint'
            : 'its account ran out of usage',
      });
      w.checkpointed = true;
    }
    const pick = candidateFor(inp);
    if (pick !== null) {
      if (inp.policy.handoff === 'auto') {
        w.limit = { ...limit, state: 'awaiting-handoff' };
        w.actions.push({ kind: 'handoff', to: pick, reason: reasonFor(limit) });
        return;
      }
      const key = `${pick.runtime}:${pick.id}`;
      w.limit = { ...limit, state: 'pending-approval', candidate: key };
      if (limit.notifiedAt === null) {
        w.limit.notifiedAt = iso;
        w.actions.push({ kind: 'notify', candidate: pick });
      }
      w.drain = { ...w.drain, wakeAfter: null };
      return;
    }
    const resets = [limit.resetsAt, ...inp.candidates.resets]
      .map((value) => (value ? Date.parse(value) : NaN))
      .filter((ms) => Number.isFinite(ms) && ms > now.getTime());
    const wake = resets.length > 0 ? Math.min(...resets) : now.getTime() + UNKNOWN_RESET_WAIT_MS;
    w.limit = { ...limit, state: 'waiting-reset' };
    w.drain = { ...w.drain, wakeAfter: new Date(wake).toISOString() };
  }

  /** The candidate a move may go to: another runtime only with cross-runtime fallback on. */
  function candidateFor(inp: HandoffInput): AccountRef | null {
    const pick = inp.candidates.pick;
    if (pick === null) return null;
    const own = handleRuntime({ runtime: run.runtime as RuntimeSlug | undefined });
    if (pick.runtime !== own && inp.policy.crossRuntimeFallback !== 'on') return null;
    return pick;
  }

  /** Resume on the run's own account: clear the episode and tell the same session to go on. */
  function resumeHere(w: Work, inp: HandoffInput): void {
    const account = run.account ?? null;
    w.limit = undefined;
    w.drain = {
      ...w.drain,
      wakeAfter: null,
      handoffs: [
        ...w.drain.handoffs,
        { from: account, to: account, at: now.toISOString(), reason: 'reset' },
      ],
    };
    sendCleared(w, inp, null);
  }

  /** Send `limit-cleared`, with a model when the session switches to one. */
  function sendCleared(w: Work, inp: HandoffInput, model: string | null): void {
    w.actions.push({
      kind: 'send',
      message: 'limit-cleared',
      ctx: {
        flow: cfg.flow,
        identifier: run.identifier,
        accountLabel: inp.accountLabel,
        ...(model !== null ? { model } : {}),
      },
      ...(model !== null ? { model } : {}),
    });
  }

  /** A new episode on the run's account. */
  function episode(
    signal: LimitSignal,
    level: RunLimit['level'],
    state: RunLimit['state'],
    iso: string
  ): RunLimit {
    return {
      level,
      account: run.account ?? null,
      window: signal.window,
      resetsAt: signal.resetsAt,
      cause: signal.cause ?? 'limit',
      since: iso,
      state,
      handoffToken: null,
      handingOffAt: null,
      handoffSessionId: null,
      notifiedAt: null,
    };
  }
}

/** An episode turned exhausted: the window, reset and cause the exhausted signal names. */
function escalate(limit: RunLimit, signal: LimitSignal): RunLimit {
  return {
    ...limit,
    level: 'exhausted',
    window: signal.window ?? limit.window,
    resetsAt: signal.resetsAt ?? limit.resetsAt,
    cause: signal.cause ?? limit.cause,
  };
}

/**
 * A window key as a person reads it: `five_hour` is "5-hour", `seven_day`
 * "weekly", a model family's bucket "weekly Opus" or "weekly Sonnet", a model
 * bucket "<model> model", anything else its key.
 *
 * @param window - The window key, or `null`.
 * @returns Its label, or `null` for no window.
 */
export function windowLabel(window: string | null): string | null {
  if (window === null) return null;
  if (window === 'five_hour') return '5-hour';
  if (window === 'seven_day') return 'weekly';
  if (window === 'seven_day_opus') return 'weekly Opus';
  if (window === 'seven_day_sonnet') return 'weekly Sonnet';
  if (window.startsWith('model:')) return `${window.slice('model:'.length)} model`;
  return window;
}
