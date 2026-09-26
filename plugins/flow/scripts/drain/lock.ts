/**
 * One drain supervisor per project (spec `flow-handoff-dispatch` §4.1): the
 * lock `<main checkout>/.dork/flow/drain.lock` holds `{ pid, token, startedAt }`
 * and is created with exclusive-create.
 *
 * - A lock whose pid is alive refuses a second drain (exit 5, "a drain is
 *   already running, pid N").
 * - A lock whose pid is gone, or that cannot be read as a lock, is stale. It is
 *   broken the way S1 breaks a stale file lock (`breakStaleLock`: rename it
 *   aside, check the moved contents are the ones judged stale, put back a lock
 *   that changed meanwhile), then taken again.
 * - Release deletes the lock only while it still holds this supervisor's
 *   contents.
 *
 * Unlike a file lock, a drain lock is judged by its pid, not its age: a drain
 * runs for hours and never refreshes it.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/drain/lock
 */

import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';

import { breakStaleLock, releaseLock } from '../atomic-json.ts';
import { PreconditionError } from '../errors.ts';

/** The lock file, relative to the main checkout. */
export const DRAIN_LOCK_FILE = path.join('.dork', 'flow', 'drain.lock');

/** How many stale locks one acquire breaks before giving up (another drain keeps winning). */
const MAX_BREAKS = 3;

/** A held drain lock. */
export interface DrainLock {
  /** The lock file. */
  file: string;
  /** The exact contents this supervisor wrote, which release compares. */
  contents: string;
  /** Delete the lock if it is still ours. */
  release(): void;
}

/** The pid a lock's contents name, or `null` when they are not a drain lock. */
function lockPid(contents: string): number | null {
  try {
    const parsed = JSON.parse(contents) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null;
  } catch {
    return null;
  }
}

/**
 * Take the drain lock.
 *
 * @param mainCheckout - The project's main checkout.
 * @param opts - This process's pid, the clock and a pid-liveness check.
 * @returns The held lock.
 * @throws {PreconditionError} When a live drain holds it (exit 5).
 */
export function acquireDrainLock(
  mainCheckout: string,
  opts: { pid: number; now: Date; pidAlive: (pid: number) => boolean }
): DrainLock {
  const file = path.join(mainCheckout, DRAIN_LOCK_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const contents = `${JSON.stringify({
    pid: opts.pid,
    token: randomBytes(16).toString('hex'),
    startedAt: opts.now.toISOString(),
  })}\n`;
  for (let breaks = 0; breaks <= MAX_BREAKS; breaks += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, contents);
      } finally {
        closeSync(fd);
      }
      return { file, contents, release: () => releaseLock(file, contents) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let existing: string;
    try {
      existing = readFileSync(file, 'utf8');
    } catch {
      continue; // released between the create and the read: try again
    }
    const pid = lockPid(existing);
    if (pid !== null && opts.pidAlive(pid)) {
      throw new PreconditionError(`a drain is already running, pid ${pid} (${file})`);
    }
    breakStaleLock(file, existing);
  }
  throw new PreconditionError(
    `another drain kept taking ${file}; run "flow drain" again once it settles`
  );
}

/**
 * The pid of a live drain holding the project's lock, or `null` when no live
 * drain holds it (no lock, an unreadable one, or a dead pid's).
 *
 * @param mainCheckout - The project's main checkout.
 * @param pidAlive - A pid-liveness check.
 * @returns The live holder's pid, or `null`.
 */
export function liveDrainPid(
  mainCheckout: string,
  pidAlive: (pid: number) => boolean
): number | null {
  let contents: string;
  try {
    contents = readFileSync(path.join(mainCheckout, DRAIN_LOCK_FILE), 'utf8');
  } catch {
    return null;
  }
  const pid = lockPid(contents);
  return pid !== null && pidAlive(pid) ? pid : null;
}
