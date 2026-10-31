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
 *
 * Dependency-free: no imports, so the extension can load it.
 *
 * @module @dorkos/flow/run-ended
 */

/** Why a run ended. */
export type RunEndReason = 'item-closed' | 'worker-gone';

/** The parts of a run record the rule reads (read leniently). */
export interface RunEndInput {
  status?: unknown;
  workerPid?: unknown;
  drain?: unknown;
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
 * @returns The reason, or `null`.
 */
export function runEnded(
  run: RunEndInput,
  item: ItemEndInput | null | undefined,
  pidAlive: (pid: unknown) => boolean | null
): RunEndReason | null {
  if (run.status === 'complete') return null;
  const closed = isClosedItem(item);
  const drain = typeof run.drain === 'object' && run.drain !== null ? run.drain : undefined;
  if (drain !== undefined) {
    return closed && (drain as { phase?: unknown }).phase === 'parked' ? 'item-closed' : null;
  }
  const running = run.status === 'running';
  const alive = running ? pidAlive(run.workerPid) : null;
  if (closed && !(running && alive !== false)) return 'item-closed';
  if (running && alive === false) return 'worker-gone';
  return null;
}
