/**
 * `flow usage record` (spec `flow-usage` §2.1): read the status-line JSON on
 * stdin and write the account's 5-hour and weekly readings to its usage ledger.
 *
 * A status-line script runs this in the background through
 * `scripts/usage/statusline-hook.sh`, so it must never print to stdout, never
 * fail loudly, and never outlive a 3 s watchdog. Only a TTY on stdin or a bad
 * flag (a person typing it by hand) is an error.
 *
 * The whole path from `flow.ts` to here imports no npm package, so it runs on a
 * plugin checkout where `npm install` never ran.
 *
 * @module @dorkos/flow/cli/usage-record
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { FlowError, UsageError } from '../errors.ts';
import { loadIdentities, resolveDorkHome, type AccountIdentity } from '../fleet/accounts.ts';
import { accountForConfigDir, defaultConfigDir } from '../fleet/config-dir.ts';
import { fromStatusLine } from '../fleet/observations.ts';
import { recordUsage } from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** Largest status-line payload read; more than this records nothing. */
export const MAX_STDIN_BYTES = 1024 * 1024;

/** The watchdog: the process exits 0 after this long, whatever it is doing. */
export const WATCHDOG_MS = 3_000;

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the hook's fingerprint (the text after `"rate_limits"` up to the first
 * `}}`) reads back as the whole `rate_limits` object. Only then may it be
 * stamped: a fingerprint cut short would otherwise hide later changes.
 *
 * @param fingerprint - `FLOW_USAGE_FP`, starting with the `:` after the key.
 * @param rateLimits - The parsed `rate_limits` value.
 * @returns True when the fingerprint is faithful.
 */
export function fingerprintIsFaithful(fingerprint: string, rateLimits: unknown): boolean {
  if (!fingerprint.startsWith(':')) return false;
  try {
    return JSON.stringify(JSON.parse(`${fingerprint.slice(1)}}}`)) === JSON.stringify(rateLimits);
  } catch {
    return false;
  }
}

/**
 * The stamp path the hook asked for, or `null` when it is not exactly
 * `<dorkHome>/usage/.statusline-*`. An environment variable can never make
 * `record` write anywhere else.
 */
function allowedStampPath(requested: string | undefined, dorkHome: string): string | null {
  if (requested === undefined || requested === '') return null;
  const resolved = path.resolve(requested);
  if (path.dirname(resolved) !== path.join(dorkHome, 'usage')) return null;
  if (!path.basename(resolved).startsWith('.statusline-')) return null;
  return resolved;
}

/** Write the stamp atomically (temp file + rename, mode 0600). */
function writeStamp(stamp: string, fingerprint: string): void {
  mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
  const temp = `${stamp}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${fingerprint}\n`, { mode: 0o600 });
  renameSync(temp, stamp);
}

/** The account `record` writes for, or `null`. */
function targetAccount(ctx: VerbContext, dorkHome: string): AccountIdentity | null {
  const { accounts } = loadIdentities(dorkHome);
  const flag = ctx.args.flags.account;
  if (typeof flag === 'string') {
    return accounts.find((account) => account.id === flag && account.routable) ?? null;
  }
  return accountForConfigDir(accounts, defaultConfigDir(ctx.env, ctx.io.osHome), ctx.io.osHome);
}

/** The `--json` payload shape. */
interface RecordOutcome {
  account: string | null;
  recorded: string[];
  changed: boolean;
  dropped: boolean;
}

/**
 * Run `flow usage record`.
 *
 * @param ctx - The verb context.
 * @returns An empty text result, and the outcome for `--json`.
 * @throws {UsageError} When stdin is a terminal.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  ctx.io.armWatchdog(WATCHDOG_MS);
  const verbose = ctx.args.flags.verbose === true;
  const say = (message: string) => {
    if (verbose) ctx.warn(message);
  };
  if (ctx.io.stdin.isTTY) {
    throw new UsageError('pipe the status-line JSON in; see "flow usage --help"');
  }

  const outcome: RecordOutcome = { account: null, recorded: [], changed: false, dropped: false };
  try {
    await record(ctx, outcome, say);
  } catch (error) {
    // Anything unexpected is swallowed: the status line must never see an error.
    if (error instanceof UsageError) throw error;
    outcome.dropped = true;
    say(
      `usage not recorded: ${error instanceof FlowError || error instanceof Error ? error.message : String(error)}`
    );
  }
  return { json: { ok: true, ...outcome }, text: '' };
}

/** The body of {@link run}; fills `outcome` as it goes. */
async function record(
  ctx: VerbContext,
  outcome: RecordOutcome,
  say: (message: string) => void
): Promise<void> {
  const raw = await ctx.io.stdin.read(MAX_STDIN_BYTES);
  if (raw === null) {
    say('the status-line input was over 1 MiB; nothing recorded');
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    say('the status-line input is not JSON; nothing recorded');
    return;
  }

  const dorkHome = resolveDorkHome(ctx.env, ctx.io.osHome);
  const stamp = allowedStampPath(ctx.env.FLOW_USAGE_STAMP, dorkHome);
  const fingerprint = ctx.env.FLOW_USAGE_FP;
  const stampIt = () => {
    if (stamp !== null && fingerprint !== undefined) writeStamp(stamp, fingerprint);
  };

  const account = targetAccount(ctx, dorkHome);
  const now = ctx.now();
  const observations = fromStatusLine(payload, now);
  if (account === null || observations.length === 0) {
    // Nothing could be recorded. Stamp anyway, or an unregistered config dir
    // would start Node on every render.
    say(account === null ? 'no registered account for this config dir' : 'no usage in the input');
    stampIt();
    return;
  }

  outcome.account = account.id;
  const result = await recordUsage(dorkHome, account.id, observations, now);
  for (const warning of result.warnings) say(warning.message);
  if (result.status === 'dropped') {
    // The next render retries: the stamp stays as it was.
    outcome.dropped = true;
    return;
  }
  outcome.recorded = observations.map((observation) => observation.key);
  outcome.changed = result.status === 'written';
  if (
    fingerprint !== undefined &&
    isObject(payload) &&
    fingerprintIsFaithful(fingerprint, payload.rate_limits)
  ) {
    stampIt();
  }
}
