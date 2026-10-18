/**
 * Which permission mode the sessions flow launches may start in (DOR-3062).
 *
 * `drain`, `handoff` and `report … review-launch` start agent sessions that
 * run unattended. Commands run `flow <verb>` without asking, and three of them
 * may edit the project, `config.local.json` included, so the configured
 * `drain.permissionMode` cannot be taken on its word: a steered agent could
 * raise it to `bypassPermissions` for every later unattended run.
 *
 * So only `default`, `acceptEdits` and `plan` are taken as configured. Any
 * other mode needs a grant a person gave in DorkOS, through the flow
 * extension's destructive `set_drain_bypass` tool (an approval card only a
 * person can grant). The extension stores the grant in DorkOS's own data
 * folder, outside every project, and this module reads it from there:
 *
 * - keyed by the project's canonical root (the main checkout's real path), so
 *   worktrees share it and a copied folder does not;
 * - holding the SHA-256 of `config.json` and `config.local.json` taken when it
 *   was granted, so a change to either lapses it;
 * - lapsing 30 days after it was granted.
 *
 * Anything else (no DorkOS, no grant, a changed file, an old grant, a file
 * that is not a plain file) starts sessions in `acceptEdits` and says why in
 * one line. There is no way to grant it outside DorkOS: a flag or a file an
 * agent can reach would be no grant at all.
 *
 * Known limit: an agent with an unrestricted shell as the same OS user can
 * write DorkOS's data folder too, and with DorkOS login off any local process
 * can grant an approval (DOR-505). This stops a steered agent inside flow's
 * narrowed commands, not one with a full shell.
 *
 * @module @dorkos/flow/drain-bypass
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE, LOCAL_CONFIG_FILE, PROJECT_CONFIG_DIR } from './config-names.ts';

/** The key the flow extension keeps grants under in its stored data. */
export const DRAIN_BYPASS_KEY = 'drainBypass';

/** How long a grant lasts. */
export const GRANT_DAYS = 30;

/** The modes sessions may start in with no grant. Anything else needs one. */
export const MODES_WITHOUT_GRANT: readonly string[] = ['default', 'acceptEdits', 'plan'];

/** The mode a session falls back to when a grant is missing or no longer holds. */
export const FALLBACK_MODE = 'acceptEdits';

/** A person's grant for one project, as the extension stores it. */
export interface BypassGrant {
  /** When it was granted (ISO 8601). */
  grantedAt: string;
  /** SHA-256 of `config.json` when it was granted, or `absent`. */
  configHash: string;
  /** SHA-256 of `config.local.json` when it was granted, or `absent`. */
  localHash: string;
}

/** The two settings files a grant covers, in the project's main checkout. */
export function settingsFiles(root: string): { committed: string; local: string } {
  return {
    committed: path.join(root, PROJECT_CONFIG_DIR, CONFIG_FILE),
    local: path.join(root, PROJECT_CONFIG_DIR, LOCAL_CONFIG_FILE),
  };
}

/** A path with symlinks resolved, or as given when it does not exist. */
function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return path.resolve(file);
    }
  }
}

/** SHA-256 of a file's bytes, or `absent` when it cannot be read. */
export function hashFile(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'absent';
  }
}

/**
 * A new grant for a project: its settings files' hashes, now.
 *
 * @param root - The project's canonical root.
 * @param now - The time it is granted.
 */
export function makeGrant(root: string, now: Date): BypassGrant {
  const files = settingsFiles(root);
  return {
    grantedAt: now.toISOString(),
    configHash: hashFile(files.committed),
    localHash: hashFile(files.local),
  };
}

/** Where DorkOS keeps the flow extension's stored data. */
export function extensionDataFile(dorkHome: string): string {
  return path.join(dorkHome, 'extension-data', 'flow', 'data.json');
}

/**
 * The grant stored for a project, read from DorkOS's data folder. Only a plain
 * file counts (a symlink there could point anywhere).
 *
 * @param dorkHome - DorkOS's data folder.
 * @param root - The project's canonical root.
 * @returns The grant, or null when there is none or the file cannot be trusted.
 */
export function readGrant(dorkHome: string, root: string): BypassGrant | null {
  const file = extensionDataFile(dorkHome);
  try {
    if (!lstatSync(file).isFile()) return null;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const grants = data?.[DRAIN_BYPASS_KEY] as Record<string, unknown> | undefined;
    const grant = grants?.[root] as Partial<BypassGrant> | undefined;
    if (
      typeof grant?.grantedAt !== 'string' ||
      typeof grant.configHash !== 'string' ||
      typeof grant.localHash !== 'string'
    ) {
      return null;
    }
    return { grantedAt: grant.grantedAt, configHash: grant.configHash, localHash: grant.localHash };
  } catch {
    return null;
  }
}

/**
 * Why a grant no longer holds, or null when it does.
 *
 * @param grant - The stored grant.
 * @param root - The project's canonical root.
 * @param now - The time now.
 */
export function grantProblem(grant: BypassGrant, root: string, now: Date): string | null {
  const at = Date.parse(grant.grantedAt);
  if (!Number.isFinite(at) || at > now.getTime()) return 'its grant has an impossible date';
  if (now.getTime() - at > GRANT_DAYS * 24 * 60 * 60 * 1000) {
    return `its grant is more than ${GRANT_DAYS} days old`;
  }
  const files = settingsFiles(root);
  if (hashFile(files.committed) !== grant.configHash)
    return `${CONFIG_FILE} changed since the grant`;
  if (hashFile(files.local) !== grant.localHash)
    return `${LOCAL_CONFIG_FILE} changed since the grant`;
  return null;
}

/** What sessions start in, and the line to say when that is not what was configured. */
export interface EffectiveMode {
  mode: string;
  notice?: string;
}

/**
 * The mode the sessions flow launches start in.
 *
 * @param opts.configured - `drain.permissionMode` (or a flag that lowered it).
 * @param opts.root - The project's canonical root, or null when it has none.
 * @param opts.dorkHome - DorkOS's data folder, or null without DorkOS.
 * @param opts.loadedFrom - The settings files flow actually read; a grant
 *   covers only the two in the project's main checkout.
 * @param opts.now - The time now.
 */
export function effectivePermissionMode(opts: {
  configured: string;
  root: string | null;
  dorkHome: string | null;
  loadedFrom: { committed: string | null; local: string | null };
  now: Date;
}): EffectiveMode {
  const { configured, root, dorkHome, loadedFrom, now } = opts;
  if (MODES_WITHOUT_GRANT.includes(configured)) return { mode: configured };
  const fallback = (why: string): EffectiveMode => ({
    mode: FALLBACK_MODE,
    notice: `drain.permissionMode is ${configured}, but ${why}; starting sessions in ${FALLBACK_MODE}. A person grants ${configured} in DorkOS (Flow's "Allow unattended bypass" approval).`,
  });
  if (root === null) return fallback('this project has no git root to grant it for');
  if (dorkHome === null) return fallback('DorkOS is not here to hold a grant');
  const files = settingsFiles(root);
  if (
    (loadedFrom.committed !== null && real(loadedFrom.committed) !== real(files.committed)) ||
    (loadedFrom.local !== null && real(loadedFrom.local) !== real(files.local))
  ) {
    return fallback(`flow read settings from outside ${path.join(root, PROJECT_CONFIG_DIR)}`);
  }
  const grant = readGrant(dorkHome, root);
  if (grant === null) return fallback('no person has granted it for this project');
  const problem = grantProblem(grant, root, now);
  return problem === null ? { mode: configured } : fallback(problem);
}
