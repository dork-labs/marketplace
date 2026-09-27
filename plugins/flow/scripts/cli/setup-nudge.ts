/**
 * The one-line setup nudge `flow status`, `flow fleet` and `flow next` print
 * (spec `flow-cli-core` Amendment "account setup", S2): when a runtime has two
 * or more account folders on this machine and none of its registered accounts
 * is in rotation, suggest `flow accounts setup`.
 *
 * It only ever adds one line to human output. In `--json` mode it prints
 * nothing; it never writes to stderr, never changes an exit code, and a failure
 * to look (an unreadable home folder, a broken config) prints nothing.
 * `fleet.nudge: false` in the project config turns it off.
 *
 * Dependency-free: node builtins and local zero-dependency modules only.
 *
 * @module @dorkos/flow/cli/setup-nudge
 */

import { readJsonFile } from '../atomic-json.ts';
import { findConfigRoots, fleetSettings, type ConfigRoots } from '../config-files.ts';
import { detectAccountFolders, type AccountCandidate } from '../fleet/detect-accounts.ts';
import {
  fleetPolicyPath,
  identityConfigPath,
  readAccounts,
  resolveDorkHome,
  resolveFleetPolicy,
  type RuntimeAccount,
} from '../fleet/accounts.ts';
import { RUNTIMES, type RuntimeSlug } from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** Each runtime's name for people. */
const RUNTIME_NAMES: Readonly<Record<RuntimeSlug, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/**
 * The nudge for these folders and this policy, or `null`. Rotation is counted
 * over registered accounts only: a standalone `default` that reads as rotation
 * because it is alone (rev 6d) does not mean the other folders are in use.
 *
 * @param candidates - The folders found ({@link detectAccountFolders}).
 * @param accounts - Every account, in the order `roles` follows.
 * @param roles - Each account's resolved role, in the same order.
 * @returns The line, or `null`.
 */
export function nudgeLine(
  candidates: readonly AccountCandidate[],
  accounts: readonly RuntimeAccount[],
  roles: readonly string[]
): string | null {
  for (const runtime of RUNTIMES) {
    const found = candidates.filter((c) => c.runtime === runtime).length;
    if (found < 2) continue;
    const inRotation = accounts.filter(
      (account, index) =>
        account.runtime === runtime && !account.implicit && roles[index] === 'rotation'
    ).length;
    if (inRotation > 0) continue;
    return `${found} ${RUNTIME_NAMES[runtime]} account folders found, 0 in rotation: run \`flow accounts setup\`.`;
  }
  return null;
}

/**
 * The nudge for this invocation, or `null`: never in `--json` mode, never when
 * `fleet.nudge` is false, and never when looking fails.
 *
 * @param ctx - The verb context.
 * @param roots - The config roots, when the verb already found them.
 * @returns The line, or `null`.
 */
export function setupNudge(ctx: VerbContext, roots?: ConfigRoots): string | null {
  if (ctx.json) return null;
  try {
    if (!fleetSettings(roots ?? findConfigRoots(ctx.projectDir, ctx.flowRoot)).nudge) return null;
    const home = ctx.io.osHome;
    const dorkHome = resolveDorkHome({ ...ctx.env }, home);
    const config = readJsonFile(identityConfigPath(dorkHome)).value;
    const { accounts } = readAccounts(config, { home });
    const policy = resolveFleetPolicy(accounts, readJsonFile(fleetPolicyPath(dorkHome)).value);
    const candidates = detectAccountFolders({ home, env: ctx.env, config, accounts });
    return nudgeLine(
      candidates,
      accounts,
      policy.accounts.map((p) => p.role)
    );
  } catch {
    return null;
  }
}

/**
 * A verb's result with the nudge added under its human text. The JSON payload
 * and the exit code are never touched.
 *
 * @param ctx - The verb context.
 * @param result - The verb's result.
 * @param roots - The config roots, when the verb already found them.
 * @returns The result, with at most one more line of text.
 */
export function withSetupNudge(
  ctx: VerbContext,
  result: VerbResult,
  roots?: ConfigRoots
): VerbResult {
  const line = setupNudge(ctx, roots);
  if (line === null) return result;
  return { ...result, text: result.text === '' ? line : `${result.text}\n\n${line}` };
}
