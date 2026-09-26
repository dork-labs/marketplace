/**
 * Codex accounts and rollout lines, for `flow usage record|scan --runtime codex`
 * (spec `flow-usage` Amendment 1, A1, A2, A4).
 *
 * - An account's folder is a Codex home. The implicit `default` account is the
 *   ambient one: `CODEX_HOME` when set and non-empty, else `<os home>/.codex`.
 *   Registered `runtimes.codex.accounts[]` rows, when there are any, replace it
 *   (the registry rules are `accounts.ts`).
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

import path from 'node:path';
import { IMPLICIT_ACCOUNT_ID, loadIdentities } from './accounts.ts';
import type { FleetWarning } from './usage-ledger.ts';

/** One Codex account with the folder its sessions live in. */
export interface CodexAccount {
  /** The account id (`default` for the implicit one). */
  id: string;
  /** Its Codex home: the registered path, or the ambient one for `default`. */
  home: string;
  /** Whether it is the implicit account. */
  implicit: boolean;
}

/**
 * The ambient Codex home: `CODEX_HOME` when set and non-empty, else
 * `<osHome>/.codex`.
 *
 * @param env - The environment.
 * @param osHome - The OS home folder.
 * @returns The folder, not yet resolved.
 */
export function codexHome(
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string {
  const fromEnv = env.CODEX_HOME;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(osHome, '.codex');
}

/**
 * Every routable Codex account, each with its home: the registered rows, or the
 * implicit `default` (the ambient home) when there are none.
 *
 * @param dorkHome - The resolved DorkOS home.
 * @param env - The environment, for `CODEX_HOME`.
 * @param osHome - The OS home folder.
 * @returns The accounts in registry order, and the registry's warnings.
 */
export function codexAccounts(
  dorkHome: string,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): { accounts: CodexAccount[]; warnings: FleetWarning[] } {
  // The same rule as `readAccounts`: no row left means the implicit account.
  const { accounts: rows, warnings } = loadIdentities(dorkHome, 'codex');
  if (rows.length === 0) {
    return {
      accounts: [{ id: IMPLICIT_ACCOUNT_ID, home: codexHome(env, osHome), implicit: true }],
      warnings,
    };
  }
  const accounts = rows
    .filter((row) => row.routable)
    .map((row) => ({ id: row.id, home: row.path, implicit: false }));
  return { accounts, warnings };
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
