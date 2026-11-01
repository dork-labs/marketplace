/**
 * Whether a run record outlived its work (DOR-2924, DOR-2706): the item it
 * works closed under it, or its worker died. Such a run is not in flight and
 * waits at no gate, but its record stays until `flow release` clears it, so
 * nothing is lost on a wrong read.
 *
 * One rule for `flow status` and the Flow extension. It never loses a run that
 * may still be live:
 *
 * - **item closed**: the tracker says the item is completed or canceled, and
 *   - for a `flow drain` run, the drain has parked it (the drain closes the
 *     item itself while `closing`, and a merged PR closes it on its `Closes`
 *     line before the drain moves on, so only a park means it stopped);
 *   - for any other run, it is not `running` with a worker that may be alive
 *     (a live session may be closing the item itself, as `/flow:done` does).
 * - **worker gone**: a `running` run, not the drain's, whose worker pid is
 *   certainly dead. A drain worker has no long-lived pid; its launcher knows.
 * - **session gone** (DOR-2490): a drain run, queued or running, not parked
 *   and not limited, whose host answered that it no longer has the session the
 *   drain waits on. Only DorkOS says `gone` (its 404 for the chat, from the
 *   DorkOS that started it); a host that did not answer is `unknown`, which is
 *   never gone. The drain waits on such a run forever, since it only acts on a
 *   session that is idle or exited. It waits on a session by the same tests
 *   its phase table (`drain/drain-step.ts`) uses:
 *   - the worker while `working`, `fixing` or `fixing-ci` with no unreviewed
 *     push (an unreviewed push starts a reviewer, whatever the worker does);
 *   - the reviewer while `reviewing` a pushed commit that has no verdict yet,
 *     when that reviewer reviews that commit (otherwise the drain starts a
 *     fresh reviewer, or routes the verdict without it).
 *   In every other case the drain carries the run on without that session.
 *
 * Dependency-free: no imports.
 *
 * @module @dorkos/flow/run-ended
 */

/** Why a run ended. */
export type RunEndReason = 'item-closed' | 'worker-gone' | 'session-gone';

/** The parts of a run record the rule reads (read leniently). */
export interface RunEndInput {
  status?: unknown;
  workerPid?: unknown;
  drain?: unknown;
  limit?: unknown;
}

/**
 * What a drain run's sessions are doing, as `flow status` words it (`busy`,
 * `idle`, `exited`, `limited`, `unknown`, `starting`, or `gone`), `null` for
 * no session.
 */
export interface RunSessions {
  worker: string | null;
  reviewer: string | null;
}

/** The drain phases that may wait on the worker's session. */
const WORKER_PHASES = new Set(['working', 'fixing', 'fixing-ci']);

/** A string field of a leniently read record, or `null`. */
function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The session a drain run waits on, or `null` when its next pass carries it on
 * without one (`drain-step.ts`'s `phaseStep` and `reviewing`).
 */
export function waitedOnSession(drain: Record<string, unknown>): 'worker' | 'reviewer' | null {
  const phase = drain.phase;
  const pushed = str(drain, 'pushedSha');
  const reviewed = str(drain, 'reviewedSha');
  if (typeof phase !== 'string') return null;
  // `fixing` with its review rounds spent parks on the drain's next pass. Only
  // a `maxReviewRounds` lowered mid-run gets there (`reviewing` parks first),
  // and the rule cannot see that setting, so it is not told apart here.
  if (WORKER_PHASES.has(phase)) return pushed !== null && pushed !== reviewed ? null : 'worker';
  if (phase !== 'reviewing' || pushed === null) return null;
  if (reviewed === pushed && drain.verdict !== null && drain.verdict !== undefined) return null;
  const reviewer = drain.reviewer;
  const reviewing =
    typeof reviewer === 'object' && reviewer !== null
      ? str(reviewer as Record<string, unknown>, 'sha')
      : null;
  return reviewing === pushed ? 'reviewer' : null;
}

/** The parts of a tracker item the rule reads. */
export interface ItemEndInput {
  stateCategory?: unknown;
}

/** Whether a tracker item is closed. */
export function isClosedItem(item: ItemEndInput | null | undefined): boolean {
  return item?.stateCategory === 'completed' || item?.stateCategory === 'canceled';
}

/**
 * Why a run ended, or `null` while it may still be live.
 *
 * @param run - The run as stored.
 * @param item - Its tracker item, or `null`/`undefined` when the tracker did
 *   not say (never read as closed).
 * @param pidAlive - Whether a pid is alive: `true`, `false`, or `null` when it
 *   cannot tell (no pid, or a host's `-1`).
 * @param sessions - For a drain run, what its sessions are doing; absent when
 *   nobody asked their host (never read as gone).
 * @returns The reason, or `null`.
 */
export function runEnded(
  run: RunEndInput,
  item: ItemEndInput | null | undefined,
  pidAlive: (pid: unknown) => boolean | null,
  sessions?: RunSessions
): RunEndReason | null {
  if (run.status === 'complete') return null;
  const closed = isClosedItem(item);
  const drain = typeof run.drain === 'object' && run.drain !== null ? run.drain : undefined;
  if (drain !== undefined) {
    const fields = drain as Record<string, unknown>;
    if (fields.phase === 'parked') return closed ? 'item-closed' : null;
    const role = waitedOnSession(fields);
    const waiting = role === null ? null : sessions?.[role];
    const limited = run.limit !== undefined && run.limit !== null;
    const active = run.status === 'queued' || run.status === 'running';
    return active && !limited && waiting === 'gone' ? 'session-gone' : null;
  }
  const running = run.status === 'running';
  const alive = running ? pidAlive(run.workerPid) : null;
  if (closed && !(running && alive !== false)) return 'item-closed';
  if (running && alive === false) return 'worker-gone';
  return null;
}
