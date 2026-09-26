/**
 * How often a drain pass journals usage. Each pass considers the accounts its
 * runs bill and the accounts it ranked, and asks for a `usage.snapshot` journal
 * line for each, but at most once per {@link USAGE_SAMPLE_INTERVAL_MS} per
 * `<runtime>:<account>`: a drain that ticks every minute would otherwise read
 * every ledger and the journal on every pass. The journal's own sampling rule
 * (`shouldSampleUsage`) still decides whether a line is written.
 *
 * The last time each account was considered lives in a small file under the
 * main checkout, `.dork/flow/drain-usage.json` (`{ "<runtime>:<id>": "<ISO>" }`).
 * Only the one drain supervisor (it holds `drain.lock`) writes it, so a plain
 * write-and-rename is enough.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/drain/usage-sample
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The shortest gap between two usage snapshots of one account. */
export const USAGE_SAMPLE_INTERVAL_MS = 15 * 60 * 1000;

/** The state file, relative to the main checkout. */
export const USAGE_SAMPLE_FILE = path.join('.dork', 'flow', 'drain-usage.json');

/** When each `<runtime>:<id>` was last considered (ISO). */
export type UsageSampleState = Record<string, string>;

/**
 * The accounts due a snapshot, and the state after considering them. Pure.
 *
 * @param state - When each account was last considered.
 * @param keys - The `<runtime>:<id>` of each account this pass considered.
 * @param now - The pass's clock.
 * @param intervalMs - The shortest gap (default {@link USAGE_SAMPLE_INTERVAL_MS}).
 * @returns The due keys (deduplicated, in first-seen order) and the new state.
 */
export function dueForSnapshot(
  state: Readonly<UsageSampleState>,
  keys: readonly string[],
  now: Date,
  intervalMs = USAGE_SAMPLE_INTERVAL_MS
): { due: string[]; next: UsageSampleState } {
  const next: UsageSampleState = { ...state };
  const due: string[] = [];
  for (const key of new Set(keys)) {
    const last = Date.parse(state[key] ?? '');
    // A clock that went backwards reads as due, so a bad entry cannot stall sampling.
    if (Number.isFinite(last) && now.getTime() - last < intervalMs && now.getTime() >= last) {
      continue;
    }
    due.push(key);
    next[key] = now.toISOString();
  }
  return { due, next };
}

/**
 * Read the state file; missing or unreadable reads as empty.
 *
 * @param mainCheckout - The main checkout.
 * @returns The state.
 */
export function readUsageSampleState(mainCheckout: string): UsageSampleState {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(mainCheckout, USAGE_SAMPLE_FILE), 'utf8')
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    return {};
  }
}

/**
 * Write the state file (write a temp file, then rename over).
 *
 * @param mainCheckout - The main checkout.
 * @param state - The state.
 */
export function writeUsageSampleState(mainCheckout: string, state: UsageSampleState): void {
  const file = path.join(mainCheckout, USAGE_SAMPLE_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
