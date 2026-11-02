/**
 * Whether a project's drain lanes still have a supervisor (DOR-3263). Every
 * `flow drain` pass stamps `<main checkout>/.dork/flow/drain-last-pass.json`
 * with its time. A live drain holds the lock (`lock.ts`); a scheduled one
 * (`--tick`) holds it only for its pass, so the stamp is what says it still
 * runs. Lanes are unsupervised when no live drain holds the lock and no pass
 * ran within twice the stall time (once is the shipped hourly schedule's own
 * gap): then nothing notices a lane that goes quiet, until the next `flow
 * drain` adopts them.
 *
 * Dependency-free, so the Flow extension's server half reads it too.
 *
 * @module @dorkos/flow/drain/last-pass
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The stamp, relative to the main checkout. */
export const LAST_PASS_FILE = path.join('.dork', 'flow', 'drain-last-pass.json');

/**
 * Stamp a finished pass.
 *
 * @param mainCheckout - The project's main checkout.
 * @param at - When the pass ran.
 */
export function writeLastPass(mainCheckout: string, at: Date): void {
  const file = path.join(mainCheckout, LAST_PASS_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ at: at.toISOString() })}\n`);
  renameSync(temp, file);
}

/**
 * When the last pass ran, or `null` when none was stamped (or the stamp
 * cannot be read).
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The ISO time, or `null`.
 */
export function readLastPass(mainCheckout: string): string | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(mainCheckout, LAST_PASS_FILE), 'utf8')
    );
    const at = (value as { at?: unknown } | null)?.at;
    return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

/** Whether a stored run is a live drain lane: queued or running, with a v1 drain that is not parked. */
function isLane(run: unknown): run is { identifier: string } {
  if (typeof run !== 'object' || run === null) return false;
  const record = run as Record<string, unknown>;
  const drain = record.drain as Record<string, unknown> | undefined;
  return (
    typeof record.identifier === 'string' &&
    (record.status === 'queued' || record.status === 'running') &&
    typeof drain === 'object' &&
    drain !== null &&
    drain.v === 1 &&
    drain.phase !== 'parked'
  );
}

/** Lanes no drain watches: their items, and the last pass (`null`: never stamped). */
export interface Unsupervised {
  /** The lanes' items, in store order. */
  identifiers: string[];
  /** The last pass, or `null` when none was stamped. */
  lastPassAt: string | null;
}

/**
 * The project's unsupervised lanes, or `null` when every lane is watched (or
 * there are none).
 *
 * @param input - The run store, the live drain's pid (`null`: none), the last
 *   pass, the clock and the stall time (`drain.stallAfterMinutes`).
 * @returns The lanes, or `null`.
 */
export function unsupervisedLanes(input: {
  runs: Readonly<Record<string, unknown>>;
  livePid: number | null;
  lastPassAt: string | null;
  now: Date;
  stallAfterMs: number;
}): Unsupervised | null {
  if (input.livePid !== null) return null;
  const last = input.lastPassAt === null ? Number.NaN : Date.parse(input.lastPassAt);
  // Twice the stall time: an hourly schedule's passes are an hour apart.
  if (Number.isFinite(last) && input.now.getTime() - last <= 2 * input.stallAfterMs) return null;
  const identifiers = Object.values(input.runs)
    .filter(isLane)
    .map((run) => run.identifier);
  return identifiers.length === 0 ? null : { identifiers, lastPassAt: input.lastPassAt };
}
