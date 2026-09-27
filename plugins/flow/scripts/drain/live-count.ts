/**
 * Live sessions per account (spec `flow-handoff-dispatch` §3.2, `at-capacity`):
 * what `rankAccounts` takes as `liveByAccount`. Kept apart from `cli/next.ts`,
 * which loads zod, so the Flow extension's server half can count them too.
 *
 * Dependency-free (local zero-dependency modules only).
 *
 * @module @dorkos/flow/drain/live-count
 */

import type { FlowRun } from '../flow-run.ts';
import { handleRuntime } from '../launchers/types.ts';

/**
 * `<runtime>:<id>` for a stored account, where no account means the runtime's `default`.
 *
 * @param runtime - The stored runtime (absent: `claude-code`).
 * @param account - The stored account (absent: `default`).
 * @returns The key.
 */
export function liveKey(runtime: string | undefined, account: string | null | undefined): string {
  return `${runtime ?? 'claude-code'}:${account ?? 'default'}`;
}

/**
 * Live sessions per `<runtime>:<id>`: every `running` or `queued` run by its
 * account, plus its drain reviewer's handle by the reviewer's account. A parked
 * drain run counts for nothing. A run or
 * handle with no account bills its runtime's `default` (`assignAccounts` in `cli/next.ts`
 * folds `<runtime>:default` into the row it aliases).
 *
 * @param runs - Every run, keyed by issue id.
 * @returns The counts.
 */
export function liveByAccount(runs: Readonly<Record<string, FlowRun>>): Record<string, number> {
  const live: Record<string, number> = {};
  const add = (key: string): void => {
    live[key] = (live[key] ?? 0) + 1;
  };
  for (const run of Object.values(runs)) {
    if (run.status !== 'running' && run.status !== 'queued') continue;
    // A parked drain run holds no live session (parking stops them).
    if (run.drain?.phase === 'parked') continue;
    add(liveKey(run.runtime, run.account));
    const reviewer = run.drain?.reviewer;
    if (reviewer) add(liveKey(handleRuntime(reviewer), reviewer.account));
  }
  return live;
}
