/**
 * Codex accounts and rollout lines, for `flow usage record|scan --runtime codex`
 * (spec `flow-usage` Amendment 1, A1, A2, A4).
 *
 * - An account's folder is a Codex home. Which accounts there are, and which
 *   one `codex:default` names (`CODEX_HOME` when set and non-empty, else
 *   `<os home>/.codex`; an alias when a registered row has that folder), is the
 *   shared resolver's answer (`resolveAccounts` in `accounts.ts`, spec §1.1a
 *   rev 6d); this module only adds each account's home.
 * - Usage comes only from the `rate_limits` object Codex writes into its own
 *   session logs (`token_count` events). Mapping it to ledger entries is the
 *   contract's `codexObservations`, not this module's. Nothing here reads a
 *   stored sign-in.
 *
 * Dependency-free (node builtins and local zero-dependency modules only), so
 * `usage record --runtime codex` runs where `npm install` never ran.
 *
 * @module @dorkos/flow/fleet/codex-accounts
 */

import { loadAccounts, type AccountEnvironment, type RuntimeAccount } from './accounts.ts';
import type { FleetWarning } from './usage-ledger.ts';

/** One routable Codex account with the folder its sessions live in. */
export type CodexAccount = RuntimeAccount & {
  /** Its Codex home: the account's folder. */
  home: string;
};

/**
 * Every routable Codex account with its home, in the resolver's order
 * (registered rows, then `default` when it stands alone).
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param environment - The environment (`CODEX_HOME`) and home.
 * @returns The accounts and the registry's warnings.
 */
export function codexAccounts(
  dorkHome: string,
  environment: AccountEnvironment
): { accounts: CodexAccount[]; warnings: FleetWarning[] } {
  const loaded = loadAccounts(dorkHome, environment);
  const accounts = loaded.accounts.flatMap((account): CodexAccount[] =>
    account.runtime === 'codex' && account.routable && account.path !== null
      ? [{ ...account, home: account.path }]
      : []
  );
  return { accounts, warnings: loaded.warnings };
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The usage reading in one rollout line (spec A2 "Lines"): the line counts when
 * `type` is `event_msg`, `payload.type` is `token_count`, `payload.rate_limits`
 * is an object and `timestamp` parses. Anything else, including a message that
 * quotes the same text, is `null`.
 *
 * @param entry - One parsed rollout line.
 * @returns The `rate_limits` object and the line's time as UTC ISO, or `null`.
 */
export function rolloutReading(entry: unknown): { rateLimits: object; observedAt: string } | null {
  if (!isObject(entry) || entry.type !== 'event_msg') return null;
  const payload = entry.payload;
  if (!isObject(payload) || payload.type !== 'token_count') return null;
  if (!isObject(payload.rate_limits)) return null;
  if (typeof entry.timestamp !== 'string') return null;
  const ms = Date.parse(entry.timestamp);
  if (Number.isNaN(ms)) return null;
  return { rateLimits: payload.rate_limits, observedAt: new Date(ms).toISOString() };
}

/**
 * Whether a file name is a Codex session log: `rollout-*.jsonl`.
 *
 * @param name - A file name.
 * @returns True for a rollout file.
 */
export function isRolloutFile(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}
