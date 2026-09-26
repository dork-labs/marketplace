/**
 * Which registered account a Claude Code config dir belongs to (spec
 * `flow-usage` §2.1 "Which account").
 *
 * The status-line payload names no account. The account is the
 * `CLAUDE_CONFIG_DIR` the session runs in (unset means `<os home>/.claude`),
 * matched against the registry by real path so a symlinked dir finds its target.
 *
 * Dependency-free (no npm package).
 *
 * @module @dorkos/flow/fleet/config-dir
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { AccountIdentity } from './accounts.ts';

/**
 * The config dir a Claude Code process runs in: `CLAUDE_CONFIG_DIR` when set and
 * non-empty, else `<osHome>/.claude`.
 *
 * @param env - The environment of the process that ran Claude Code's hook.
 * @param osHome - The OS home folder.
 * @returns The config dir, not yet resolved.
 */
export function defaultConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(osHome, '.claude');
}

/**
 * Normalize a dir for comparison: expand a leading `~`, resolve it, drop a
 * trailing separator, then take its real path (the resolved path when realpath
 * fails, for example because the dir does not exist).
 *
 * @param dir - A dir as written in config or the environment.
 * @param osHome - The OS home folder, for `~`.
 * @returns The comparable path.
 */
export function canonicalDir(dir: string, osHome: string): string {
  let expanded = dir;
  if (expanded === '~') expanded = osHome;
  else if (expanded.startsWith('~/')) expanded = path.join(osHome, expanded.slice(2));
  let resolved = path.resolve(expanded);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) resolved = resolved.slice(0, -1);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The registered account whose path is `dir`. Rows whose id fails the id
 * pattern never match (they have no usage file). The first match in registry
 * order wins.
 *
 * @param identities - The identities in registry order.
 * @param dir - The config dir to look up.
 * @param osHome - The OS home folder, for `~`.
 * @returns The matching identity, or `null`.
 */
export function accountForConfigDir(
  identities: readonly AccountIdentity[],
  dir: string,
  osHome: string
): AccountIdentity | null {
  const target = canonicalDir(dir, osHome);
  for (const identity of identities) {
    if (!identity.routable) continue;
    if (canonicalDir(identity.path, osHome) === target) return identity;
  }
  return null;
}
