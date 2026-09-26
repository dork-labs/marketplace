/**
 * `flow usage record --runtime codex` (spec `flow-usage` Amendment 1, A4): read
 * one Codex `rate_limits` object, or one whole rollout line, on stdin and write
 * it to the Codex account's usage ledger by the contract's `codexObservations`.
 *
 * A bare object is dated now; a rollout line is dated by its own `timestamp`.
 * The silence rules of §2.1 hold: nothing on stdout, stderr only with
 * `--verbose`, exit 0 but for a TTY or a bad flag, and a 3 s watchdog.
 *
 * The whole path from `flow.ts` to here imports no npm package.
 *
 * @module @dorkos/flow/cli/usage-record-codex
 */

import { codexAccounts, rolloutReading, type CodexAccount } from '../fleet/codex-accounts.ts';
import { codexObservations, recordUsage } from '../fleet/usage-ledger.ts';
import {
  accountForPath,
  ambientAccountPath,
  resolveAccountRef,
  resolveDorkHome,
} from '../fleet/accounts.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { MAX_STDIN_BYTES, runRecorder, type RecordOutcome } from './usage-record.ts';

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `rate_limits` object and its time in one stdin payload: a rollout line
 * (it has a `type`) counts only when it is a `token_count` event; anything else
 * that is an object is a bare `rate_limits` object, dated `now`.
 *
 * @param payload - The parsed stdin.
 * @param now - The current time.
 * @returns The reading, or `null` when the payload holds none.
 */
export function codexStdinReading(
  payload: unknown,
  now: Date
): { rateLimits: object; observedAt: string } | null {
  if (!isObject(payload)) return null;
  if (payload.type !== undefined) return rolloutReading(payload);
  return { rateLimits: payload, observedAt: now.toISOString() };
}

/**
 * The account `record` writes for: `--account` (`default` resolves to the row it
 * aliases), else the account whose folder is this process's Codex home.
 * `codex:default` is machine-wide (`<os home>/.codex`), so an unregistered Codex
 * home that is not the default writes nothing.
 */
function targetAccount(ctx: VerbContext, dorkHome: string): CodexAccount | null {
  const home = ctx.io.osHome;
  const { accounts } = codexAccounts(dorkHome, { home });
  const flag = ctx.args.flags.account;
  if (typeof flag === 'string') return resolveAccountRef(accounts, 'codex', flag);
  const ambient = ambientAccountPath('codex', ctx.env, home) ?? '';
  return accountForPath(accounts, 'codex', ambient, { home });
}

/** Read stdin, find the reading and write it; fills `outcome` as it goes. */
async function record(
  ctx: VerbContext,
  outcome: RecordOutcome,
  say: (message: string) => void
): Promise<void> {
  const raw = await ctx.io.stdin.read(MAX_STDIN_BYTES);
  if (raw === null) {
    say('the input was over 1 MiB; nothing recorded');
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    say('the input is not JSON; nothing recorded');
    return;
  }
  const now = ctx.now();
  const reading = codexStdinReading(payload, now);
  const observations =
    reading === null ? [] : codexObservations(reading.rateLimits, reading.observedAt);
  if (observations.length === 0) {
    say('no Codex usage in the input');
    return;
  }

  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  const account = targetAccount(ctx, dorkHome);
  if (account === null) {
    say('no Codex account for this Codex home');
    return;
  }
  outcome.account = account.id;
  const result = await recordUsage(dorkHome, 'codex', account.id, observations, now);
  for (const warning of result.warnings) say(warning.message);
  if (result.status === 'dropped') {
    outcome.dropped = true;
    return;
  }
  outcome.recorded = observations.map((observation) =>
    'key' in observation ? observation.key : observation.kind
  );
  outcome.changed = result.status === 'written';
}

/**
 * Run `flow usage record --runtime codex`.
 *
 * @param ctx - The verb context.
 * @returns An empty text result, and the outcome for `--json`.
 * @throws {UsageError} When stdin is a terminal.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  return runRecorder(
    ctx,
    'pipe a Codex rate_limits object or rollout line in; see "flow usage --help"',
    (outcome, say) => record(ctx, outcome, say)
  );
}
