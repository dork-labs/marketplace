/**
 * Moving a limited run to another account (spec `flow-handoff-dispatch` §5.3,
 * §4.3 "One handoff at a time"), shared by the drain's runner and `flow
 * handoff`. The decision is `nextHandoffAction`'s (pure); this module is the
 * I/O that carries it out.
 *
 * {@link executeHandoff}, in order:
 *
 * 0. **One handoff at a time.** Under the run store's lock, compare-and-set:
 *    the run's `sessionId` must still be the one the mover read, and no
 *    `handing-off` mark may stand. It then writes `limit.state = handing-off`
 *    with a fresh token, the time, the session id it is about to mint, and the
 *    target. A run with no limit (a manual move) gets a limit record for the
 *    move. The loser of a race starts nothing.
 * 1. A checkpoint newer than the episode, synthesized when there is none.
 * 2. The old worker stops (cli and cmux; DorkOS leaves it idle), so one writer
 *    holds the worktree.
 * 3. The run's own host must support and probe ok for the target runtime; if
 *    not, the run parks with the reason (switching hosts would be a guess).
 * 4. A new worker starts on the target account in the same worktree, its first
 *    message `resume-from-handoff`, which points at `HANDOFF.md` and at the old
 *    session's transcript for the new session to read. flow only resolves that
 *    path: it never reads, copies, moves or writes a transcript.
 * 5. Under the lock, and only while the token is still its own: the run's
 *    account, host, runtime, session and worker handle are rewritten, the move
 *    is appended to `drain.handoffs`, and the limit is cleared. The phase and
 *    `provenance` are untouched.
 *
 * A start that fails puts the run back to `awaiting-handoff` with the token
 * cleared. {@link adoptOrRevertHandoff} resolves a `handing-off` mark whose
 * mover died.
 *
 * @module @dorkos/flow/drain/handoff-exec
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FlowRun } from '../flow-run.ts';
import type { FlowStateFile } from '../flow-state-file.ts';
import {
  handleRuntime,
  type HostName,
  type LaunchAccount,
  type LaunchPermissionMode,
  type Launcher,
  type RuntimeName,
  type SessionHandle,
} from '../launchers/types.ts';
import { launchAccountFor } from '../launchers/common.ts';
import type { AccountRef } from './account-rank.ts';
import { windowLabel, type HandoffReason } from './handoff.ts';
import { render as renderMessage } from './messages.ts';
import type { DrainState, DrainWorkerHandle, RunLimit } from './state.ts';

/** Where the supervisor writes the messages it sends, relative to the worker's worktree. */
export const MESSAGES_DIR = '.dork/flow/drain/messages';

/** An account a handoff can move a run to, as the launcher bills it. */
export interface HandoffAccount {
  /** The runtime. */
  runtime: RuntimeName;
  /** The registry id (`default` for the runtime's implicit account). */
  id: string;
  /** The account's folder, or `null` for the implicit (ambient) account. */
  path: string | null;
  /** True for the runtime's implicit account. */
  implicit: boolean;
  /** The operator's label for it, when set. */
  label: string | null;
}

/** Everything a handoff touches. The runner and the verb wire the real ones. */
export interface HandoffExecDeps {
  /** The run store. */
  store: FlowStateFile;
  /** The launcher for a host. */
  launcher(host: HostName): Launcher;
  /** The clock. */
  now(): Date;
  /** The full flow command prefix messages spell verbs with. */
  flow: string;
  /** How long a `handing-off` mark may stand before its mover counts as dead (ms). */
  startTimeoutMs: number;
  /** The permission mode a session starts in when the old handle names none. */
  permissionMode: LaunchPermissionMode;
  /** The worker model (`models.bindings[models.tiers.implementation]`), or `null`. */
  workerModel: string | null;
  /** Mint a session id. */
  mintId(): string;
  /** Mint a handoff token. */
  mintToken(): string;
  /** Write a synthesized checkpoint unless one newer than `since` exists. */
  ensureCheckpoint(run: FlowRun, since: string, reason: string): Promise<void>;
  /** The old session's transcript path (only resolved, never opened), or `null`. */
  transcriptFor(handle: SessionHandle): string | null;
  /** The tracker half of a park. */
  park(identifier: string, reason: string): Promise<void>;
  /** Look for a session a dead mover may have started. */
  findSession(probe: DrainWorkerHandle): Promise<SessionHandle | null>;
  /** The account a `<runtime>:<id>` names, as the launcher bills it, or `null`. */
  resolveAccount(ref: AccountRef): Promise<HandoffAccount | null>;
  /** Print a warning. */
  warn(message: string): void;
}

/** How a handoff ended. */
export type HandoffOutcome =
  | { status: 'moved'; sessionId: string; line: string }
  | { status: 'lost'; line: string }
  | { status: 'parked'; line: string }
  | { status: 'failed'; line: string };

/** A version-1 drain run. */
type DrainRun = FlowRun & { drain: DrainState };

/** Whether a run carries a drain this version writes. */
function writable(run: FlowRun | undefined): run is DrainRun {
  return run?.drain?.v === 1 && typeof run.drain.rev === 'number';
}

/**
 * Write one message file in the worker's worktree, numbered after the last one.
 *
 * @param worktree - The worker's worktree.
 * @param kind - The message kind, for the file name.
 * @param text - The rendered message.
 * @returns The file's absolute path.
 */
export function writeMessage(worktree: string, kind: string, text: string): string {
  const dir = path.join(worktree, MESSAGES_DIR);
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  for (const name of readdirSync(dir)) {
    const n = Number(/^(\d+)-/.exec(name)?.[1]);
    if (Number.isFinite(n)) seq = Math.max(seq, n);
  }
  const file = path.join(dir, `${String(seq + 1).padStart(3, '0')}-${kind}.md`);
  writeFileSync(file, text);
  return file;
}

/**
 * A reset time as the operator reads it, in this machine's time zone.
 *
 * @param iso - An ISO time, or `null`.
 * @returns E.g. "Thu 09:00", or "an unknown time".
 */
export function localTime(iso: string | null): string {
  if (iso === null || !Number.isFinite(Date.parse(iso))) return 'an unknown time';
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** An account's name for people: its label, else `<runtime>:<id>`. */
function labelOf(account: HandoffAccount | null, ref: AccountRef): string {
  return account?.label ?? `${ref.runtime}:${ref.id}`;
}

/**
 * The launch account for a handoff target, as the runner launches one
 * (`launchAccountFor`): a standalone `default` starts in its machine-wide
 * folder; only a folder-less account is `null`, the ambient environment.
 */
function launchAccount(account: HandoffAccount): LaunchAccount | null {
  return account.path === null ? null : launchAccountFor(account);
}

/** A stored handle as a launcher takes it. */
function launchHandle(handle: DrainWorkerHandle): SessionHandle {
  const { pending: _pending, pendingSince: _since, ...rest } = handle;
  return { ...rest, runtime: handleRuntime(handle) };
}

/** The limit a manual move of an unlimited run records while it moves. */
function manualLimit(run: FlowRun, nowIso: string): RunLimit {
  return {
    level: 'warning',
    account: run.account ?? null,
    window: null,
    resetsAt: null,
    cause: 'limit',
    since: nowIso,
    state: 'awaiting-handoff',
    handoffToken: null,
    handingOffAt: null,
    handoffSessionId: null,
    notifiedAt: null,
  };
}

/** The limit with its move cleared, back to `awaiting-handoff`. */
function reverted(limit: RunLimit): RunLimit {
  const { handoffTo: _to, handoffReason: _reason, ...rest } = limit;
  return {
    ...rest,
    state: 'awaiting-handoff',
    handoffToken: null,
    handingOffAt: null,
    handoffSessionId: null,
  };
}

/** The line for a finished move: "moved to <acct> (<window> limit on <old> until <time>)". */
function movedLine(
  to: string,
  limit: RunLimit | undefined,
  from: string,
  reason: HandoffReason
): string {
  if (reason === 'manual' || limit === undefined || limit.window === null) {
    return `moved to ${to} (${reason === 'manual' ? 'moved by hand' : 'usage limit'} from ${from})`;
  }
  return `moved to ${to} (${windowLabel(limit.window)} limit on ${from} until ${localTime(limit.resetsAt)})`;
}

/**
 * Carry out one handoff (§5.3). Safe to run beside the supervisor: step 0's
 * compare-and-set lets exactly one mover through.
 *
 * @param deps - The world a handoff touches.
 * @param read - The run as the mover read it (its `sessionId` is the compare-and-set's condition).
 * @param to - The target (runtime, account).
 * @param reason - Why: `warning`, `rejected`, `reset` or `manual`.
 * @param note - Why, in words, for a synthesized checkpoint (default from `reason`).
 * @returns How it ended, with a line for the report.
 */
export async function executeHandoff(
  deps: HandoffExecDeps,
  read: FlowRun,
  to: AccountRef,
  reason: HandoffReason,
  note?: string
): Promise<HandoffOutcome> {
  const target = await deps.resolveAccount(to);
  if (target === null) {
    return { status: 'failed', line: `${to.runtime}:${to.id} is not a registered account` };
  }
  const now = deps.now();
  const nowIso = now.toISOString();
  const token = deps.mintToken();
  const minted = deps.mintId();

  // 0. The compare-and-set.
  let before: DrainRun | undefined;
  let why = 'the run is gone';
  await deps.store.updateRun(read.issueId, (run) => {
    before = undefined;
    if (!writable(run)) {
      why = 'the run has no drain state flow can write';
      return run;
    }
    if (run.sessionId !== read.sessionId) {
      why = 'another session took the run over since it was read';
      return run;
    }
    if (run.limit?.state === 'handing-off') {
      why = 'another handoff of this run is in progress';
      return run;
    }
    before = run;
    const limit: RunLimit = {
      ...(run.limit ?? manualLimit(run, nowIso)),
      state: 'handing-off',
      handoffToken: token,
      handingOffAt: nowIso,
      handoffSessionId: minted,
      handoffTo: `${to.runtime}:${to.id}`,
      handoffReason: reason,
    };
    return { ...run, limit, drain: { ...run.drain, rev: run.drain.rev + 1 } };
  });
  const run = before as DrainRun | undefined;
  if (run === undefined) return { status: 'lost', line: `not moved: ${why}` };
  const ours = (r: FlowRun): r is DrainRun => writable(r) && r.limit?.handoffToken === token;
  const revert = async (): Promise<void> => {
    await deps.store.updateRun(run.issueId, (r) =>
      ours(r) && r.limit
        ? { ...r, limit: reverted(r.limit), drain: { ...r.drain, rev: r.drain.rev + 1 } }
        : r
    );
  };

  const since = run.limit?.since ?? nowIso;
  const fromLabel = run.account ?? 'the ambient account';
  try {
    // 1. A checkpoint newer than the episode.
    await deps.ensureCheckpoint(
      run,
      since,
      note ??
        (reason === 'manual' ? 'moved to another account by hand' : 'its account ran out of usage')
    );
  } catch (error) {
    await revert();
    return {
      status: 'failed',
      line: `not moved: the checkpoint failed (${(error as Error).message})`,
    };
  }

  // 2. One writer per worktree.
  const old = run.drain.worker;
  if (old !== null && !old.pending) {
    try {
      await deps.launcher(old.host).stop(launchHandle(old));
    } catch (error) {
      deps.warn(`${run.identifier}: could not stop the old worker: ${(error as Error).message}`);
    }
  }

  // 3. The run's own host, never another.
  const host = (run.host ?? old?.host ?? 'cli') as HostName;
  const launcher = deps.launcher(host);
  const support = launcher.supports(target.runtime);
  const probe = support.ok ? await launcher.probe(target.runtime) : support;
  if (!probe.ok) {
    const parkedReason = `the handoff to ${labelOf(target, to)} needs the ${host} host, which cannot start it: ${probe.reason}`;
    await deps.store.updateRun(run.issueId, (r) =>
      ours(r) && r.limit
        ? {
            ...r,
            limit: reverted(r.limit),
            drain: {
              ...r.drain,
              phase: 'parked',
              parkedReason,
              parkedFrom: r.drain.phase === 'parked' ? (r.drain.parkedFrom ?? null) : r.drain.phase,
              parkedAt: nowIso,
              rev: r.drain.rev + 1,
            },
          }
        : r
    );
    await deps.park(run.identifier, parkedReason);
    return { status: 'parked', line: `parked: ${parkedReason}` };
  }

  // 4. The new worker, told only to resume from the checkpoint.
  const oldRuntime = old
    ? handleRuntime(old)
    : handleRuntime({ runtime: run.runtime as RuntimeName });
  const sameRuntime = oldRuntime === target.runtime;
  const transcript = old ? deps.transcriptFor(launchHandle(old)) : null;
  const file = writeMessage(
    run.worktreePath,
    'resume-from-handoff',
    renderMessage('resume-from-handoff', {
      flow: deps.flow,
      identifier: run.identifier,
      worktree: run.worktreePath,
      branch: run.branch,
      transcript,
      previousRuntime: sameRuntime ? null : oldRuntime,
    })
  );
  const model = sameRuntime ? (old?.model ?? deps.workerModel ?? undefined) : undefined;
  let handle: SessionHandle;
  try {
    handle = await launcher.start({
      role: 'worker',
      runtime: target.runtime,
      identifier: run.identifier,
      account: launchAccount(target),
      cwd: run.worktreePath,
      promptFile: file,
      sessionId: minted,
      ...(model ? { model } : {}),
      permissionMode: old?.permissionMode ?? deps.permissionMode,
      title: `${run.identifier} worker`,
    });
  } catch (error) {
    // Any failure to start (a LaunchError, or the host throwing) leaves the
    // run where it was, waiting to be handed off again.
    await revert();
    return {
      status: 'failed',
      line: `not moved: the new session on ${labelOf(target, to)} did not start (${(error as Error).message}); the next pass tries again`,
    };
  }

  // 5. The run now lives on the new account.
  let written = false;
  const limit = run.limit;
  await deps.store.updateRun(run.issueId, (r) => {
    written = false;
    if (!ours(r)) return r;
    written = true;
    return finishMove(r, handle, target, reason, nowIso);
  });
  if (!written) {
    deps.warn(
      `${run.identifier}: the new session ${handle.sessionId} started, but the run changed hands meanwhile; stopping it`
    );
    try {
      await launcher.stop(handle);
    } catch {
      // Best effort: the run record no longer points at it.
    }
    return {
      status: 'lost',
      line: 'not moved: the run changed hands while the new session started',
    };
  }
  return {
    status: 'moved',
    sessionId: handle.sessionId,
    line: movedLine(labelOf(target, to), limit, fromLabel, reason),
  };
}

/** Step 5: rewrite the run onto the new session and clear its limit. */
function finishMove(
  r: DrainRun,
  handle: SessionHandle,
  target: HandoffAccount,
  reason: HandoffReason,
  nowIso: string
): DrainRun {
  const next: DrainRun = {
    ...r,
    host: handle.host,
    runtime: handle.runtime,
    sessionId: handle.sessionId,
    workerPid: handle.pid ?? -1,
    drain: {
      ...r.drain,
      worker: handle,
      nudges: 0,
      wakeAfter: null,
      handoffs: [
        ...r.drain.handoffs,
        {
          from: r.account ?? null,
          to: target.implicit ? null : target.id,
          at: nowIso,
          reason,
        },
      ],
      rev: r.drain.rev + 1,
    },
  };
  if (target.implicit) delete next.account;
  else next.account = target.id;
  delete next.limit;
  return next;
}

/**
 * Resolve a `handing-off` mark whose mover died (§5.2 last row): adopt the
 * session it minted when that exists and finish the move; else put the run back
 * to `awaiting-handoff`. On DorkOS, where `session_start` may mint another id
 * server-side, "not found" proves nothing, so the run parks with instructions.
 *
 * @param deps - The world a handoff touches.
 * @param read - The run as the pass read it.
 * @returns A line for the report.
 */
export async function adoptOrRevertHandoff(deps: HandoffExecDeps, read: FlowRun): Promise<string> {
  const limit = read.limit;
  if (!writable(read) || limit?.state !== 'handing-off') return 'nothing to resolve';
  const token = limit.handoffToken;
  const to = parseRef(limit.handoffTo ?? null);
  const target = to === null ? null : await deps.resolveAccount(to);
  const host = (read.host ?? read.drain.worker?.host ?? 'cli') as HostName;
  const nowIso = deps.now().toISOString();
  const same = (r: FlowRun): r is DrainRun =>
    writable(r) && r.limit?.state === 'handing-off' && r.limit.handoffToken === token;

  if (limit.handoffSessionId !== null && to !== null && target !== null) {
    const found = await deps.findSession({
      host,
      runtime: target.runtime,
      sessionId: limit.handoffSessionId,
      account: target.implicit ? null : target.id,
      cwd: read.worktreePath,
    });
    if (found !== null) {
      const reason = (limit.handoffReason ?? 'rejected') as HandoffReason;
      let wrote = false;
      await deps.store.updateRun(read.issueId, (r) => {
        wrote = false;
        if (!same(r)) return r;
        wrote = true;
        return finishMove(r, found, target, reason, nowIso);
      });
      return wrote
        ? `adopted the session ${found.sessionId} a stopped handoff started on ${labelOf(target, to)}`
        : 'the handoff was resolved by someone else meanwhile';
    }
  }
  if (host === 'dorkos') {
    const reason = `a handoff stopped while starting a DorkOS session; check DorkOS for a session in ${read.worktreePath} whose context names flow id ${limit.handoffSessionId ?? 'unknown'}, then flow release or re-run`;
    await deps.store.updateRun(read.issueId, (r) =>
      same(r) && r.limit
        ? {
            ...r,
            limit: reverted(r.limit),
            drain: {
              ...r.drain,
              phase: 'parked',
              parkedReason: reason,
              parkedFrom: r.drain.phase === 'parked' ? (r.drain.parkedFrom ?? null) : r.drain.phase,
              parkedAt: nowIso,
              rev: r.drain.rev + 1,
            },
          }
        : r
    );
    await deps.park(read.identifier, reason);
    return `parked: ${reason}`;
  }
  await deps.store.updateRun(read.issueId, (r) =>
    same(r) && r.limit
      ? { ...r, limit: reverted(r.limit), drain: { ...r.drain, rev: r.drain.rev + 1 } }
      : r
  );
  return 'a handoff never finished starting its session; the run waits to be handed off again';
}

/**
 * Parse `<runtime>:<id>`; a bare id is a Claude Code account.
 *
 * @param key - The key, or `null`.
 * @returns The (runtime, id), or `null` for none or a runtime flow does not know.
 */
export function parseRef(key: string | null): AccountRef | null {
  if (key === null || key === '') return null;
  const at = key.indexOf(':');
  const runtime = at === -1 ? 'claude-code' : key.slice(0, at);
  const id = at === -1 ? key : key.slice(at + 1);
  if (runtime !== 'claude-code' && runtime !== 'codex' && runtime !== 'opencode') return null;
  if (id === '') return null;
  return { runtime, id };
}

/**
 * The ask-mode comment (§5.5): why the run waits and the command that moves it.
 *
 * @param input - The item, the limited account's label, the window, its reset, the candidate and its label, and the flow prefix.
 * @returns The comment body (unsigned).
 */
export function askText(input: {
  identifier: string;
  accountLabel: string;
  window: string | null;
  resetsAt: string | null;
  candidate: AccountRef;
  candidateLabel: string;
  flow: string;
}): string {
  const which = input.window ? `its ${windowLabel(input.window)} limit` : 'a usage limit';
  return [
    `${input.accountLabel} reached ${which} (resets ${localTime(input.resetsAt)}). This run is waiting.`,
    `To continue on ${input.candidateLabel} now, run \`${input.flow} handoff ${input.identifier} --to ${input.candidate.runtime}:${input.candidate.id}\`.`,
    'Otherwise it continues here when the limit resets.',
  ].join(' ');
}

/**
 * The line `flow drain` and `flow status` print for a run waiting for approval
 * (§5.5), or for any other limited state; `null` for a run with no limit.
 *
 * @param limit - The run's limit, or `undefined`.
 * @param wakeAfter - The run's `drain.wakeAfter`.
 * @returns E.g. "limited until Thu 09:00, waiting for approval to move to claude4".
 */
export function limitLine(limit: RunLimit | undefined, wakeAfter: string | null): string | null {
  if (limit === undefined) return null;
  const until = localTime(limit.resetsAt);
  switch (limit.state) {
    case 'pending-approval':
      return `limited until ${until}, waiting for approval to move to ${limit.candidate ?? 'another account'}`;
    case 'waiting-reset':
      return limit.heldBy === 'person'
        ? `held by a person until ${limit.heldUntil ? localTime(limit.heldUntil) : `the account resets (${until})`}`
        : `limited until ${until}, waiting (next check ${localTime(wakeAfter)})`;
    case 'winding-down':
      return `near its ${windowLabel(limit.window) ?? 'usage'} limit, winding down`;
    case 'handing-off':
      return `moving to ${limit.handoffTo ?? 'another account'}`;
    default:
      return `limited until ${until}, about to move`;
  }
}
