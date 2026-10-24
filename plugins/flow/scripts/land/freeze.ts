/**
 * The release freeze (DOR-3262): while it is on, flow's arm guard arms nothing
 * in this project. The release step sets it before it cuts a release and clears
 * it after (`flow freeze on|off`).
 *
 * It is a file in flow's local run files, `<main checkout>/.dork/flow/freeze.json`,
 * so every worktree of the project sees the same freeze, and it is never
 * committed (a PR cannot lift it). A marker that exists but cannot be read
 * counts as on: the guard fails closed.
 *
 * @module @dorkos/flow/land/freeze
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUN_FILES_DIR } from '../config-names.ts';

/** The marker's name in {@link RUN_FILES_DIR}. */
export const FREEZE_FILE = 'freeze.json';

/** A freeze that is on. */
export interface FreezeMarker {
  /** When it was set (ISO 8601). */
  since: string;
  /** Why, in a few words. */
  reason: string;
}

/**
 * The marker's path.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The absolute path.
 */
export function freezePath(mainCheckout: string): string {
  return path.join(mainCheckout, RUN_FILES_DIR, FREEZE_FILE);
}

/**
 * The freeze in force, or `null` when there is none.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The marker; one that cannot be read reads as on, saying so.
 */
export function readFreeze(mainCheckout: string): FreezeMarker | null {
  const file = freezePath(mainCheckout);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const marker =
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    return {
      since: typeof marker.since === 'string' ? marker.since : 'unknown',
      reason:
        typeof marker.reason === 'string' && marker.reason !== ''
          ? marker.reason
          : 'no reason given',
    };
  } catch {
    return { since: 'unknown', reason: `${file} exists but cannot be read` };
  }
}

/**
 * Turn the freeze on (again, with a new reason, when it already is).
 *
 * @param mainCheckout - The project's main checkout.
 * @param reason - Why.
 * @param now - The clock.
 * @returns The marker written.
 */
export function setFreeze(mainCheckout: string, reason: string, now: Date): FreezeMarker {
  const file = freezePath(mainCheckout);
  mkdirSync(path.dirname(file), { recursive: true });
  const marker: FreezeMarker = { since: now.toISOString(), reason };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(temp, file);
  return marker;
}

/**
 * Turn the freeze off.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns Whether a freeze was on.
 */
export function clearFreeze(mainCheckout: string): boolean {
  const file = freezePath(mainCheckout);
  const was = existsSync(file);
  rmSync(file, { force: true });
  return was;
}
