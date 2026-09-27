/**
 * Find the account folders on this machine (spec `flow-cli-core` Amendment
 * "account setup", S1.1), for `flow accounts setup` and the setup nudge.
 *
 * - Claude Code: `<home>/.claude`; every `<home>/.claude*` folder holding a
 *   `sessions/` or `projects/` folder; `CLAUDE_CONFIG_DIR` when it is a folder.
 * - Codex: `<home>/.codex`, and `CODEX_HOME` when it is a folder.
 * - OpenCode: its data folder, when it exists (the ambient `opencode:default`).
 * - Every registered account whose folder exists.
 *
 * Folders are merged by {@link canonicalAccountPath}, so a symlink and its
 * target, or a registered row and the folder it names, are one candidate. Only
 * folder names and existence are read, plus whether one of the two org marker
 * files exists; no file's contents are ever read here.
 *
 * Dependency-free: node builtins and local zero-dependency modules only.
 *
 * @module @dorkos/flow/fleet/detect-accounts
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  accountForPath,
  canonicalAccountPath,
  defaultAccountPath,
  resolveAccountRef,
  type RuntimeAccount,
} from './accounts.ts';
import { resolveOpenCodeDataDir } from './opencode-store.ts';
import { RUNTIMES, type RuntimeSlug } from './usage-ledger.ts';

/** Where a candidate folder was found. */
export type CandidateSource = 'home' | 'glob' | 'env' | 'default' | 'registered' | 'data';

/** Why a folder looks managed by an organization. */
export interface OrgMarker {
  /** The marker file that exists. */
  file: string;
  /** One plain sentence for people. */
  reason: string;
}

/** One account folder found on this machine. */
export interface AccountCandidate {
  /** The runtime the folder belongs to. */
  runtime: RuntimeSlug;
  /** The folder, `~` expanded. */
  path: string;
  /** The folder for comparison ({@link canonicalAccountPath}). */
  canonicalPath: string;
  /** Every place it was found, in the order looked. */
  sources: CandidateSource[];
  /** Whether it is its runtime's machine-wide default folder (spec §1.1a rev 6d). */
  isDefault: boolean;
  /** The account that runs in it (a registered row, or the standalone `default`), or `null`. */
  account: RuntimeAccount | null;
  /** The org marker, for a Claude Code folder that has one. */
  orgMarker: OrgMarker | null;
}

/**
 * The files Claude Code leaves in an account folder when an organization
 * manages it: its cache of server-managed settings, and org policy limits.
 * Neither name is in Claude Code's published docs (see the spec amendment's
 * decision A1), so a missing marker proves nothing and setup always asks.
 */
export const ORG_MARKER_FILES = ['remote-settings.json', 'policy-limits.json'] as const;

/** What {@link detectAccountFolders} reads from. */
export interface DetectInputs {
  /** The OS home folder. */
  home: string;
  /** The environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`). */
  env: Readonly<Record<string, string | undefined>>;
  /** The parsed `config.json`, for the Claude Code default folder. */
  config: unknown;
  /** Every account ({@link loadAccounts}), to join registered folders in. */
  accounts: readonly RuntimeAccount[];
}

/** Whether `dir` is a folder (following a symlink). */
function isFolder(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** A `<home>/.claude*` folder counts when it holds `sessions/` or `projects/`. */
function looksLikeClaudeAccount(dir: string): boolean {
  return isFolder(path.join(dir, 'sessions')) || isFolder(path.join(dir, 'projects'));
}

/** The org marker of a Claude Code folder, or `null`. */
export function orgMarkerOf(dir: string): OrgMarker | null {
  for (const file of ORG_MARKER_FILES) {
    try {
      if (statSync(path.join(dir, file)).isFile()) {
        return {
          file,
          reason: `it has ${file}, which Claude Code saves when an organization manages the account`,
        };
      }
    } catch {
      // not there
    }
  }
  return null;
}

/** Every `<home>/.claude*` folder name other than `.claude`, sorted. */
function claudeGlob(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('.claude') && name !== '.claude')
    .sort()
    .map((name) => path.join(home, name))
    .filter((dir) => isFolder(dir) && looksLikeClaudeAccount(dir));
}

/** An environment variable's value, when set and non-empty. */
function envValue(env: DetectInputs['env'], name: string): string | null {
  const value = env[name];
  return value !== undefined && value !== '' ? value : null;
}

/**
 * Find every account folder on this machine.
 *
 * @param inputs - The home folder, environment, config and accounts.
 * @returns The candidates, runtime by runtime, each folder once.
 */
export function detectAccountFolders(inputs: DetectInputs): AccountCandidate[] {
  const { home, env, config, accounts } = inputs;
  const candidates: AccountCandidate[] = [];
  const add = (runtime: RuntimeSlug, dir: string, source: CandidateSource): void => {
    if (!path.isAbsolute(dir) && !dir.startsWith('~')) return;
    const canonical = canonicalAccountPath(dir, home);
    if (!isFolder(canonical)) return;
    const existing = candidates.find((c) => c.runtime === runtime && c.canonicalPath === canonical);
    if (existing !== undefined) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    candidates.push({
      runtime,
      path: dir === '~' ? home : dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir,
      canonicalPath: canonical,
      sources: [source],
      isDefault: false,
      account: null,
      orgMarker: null,
    });
  };

  for (const runtime of RUNTIMES) {
    if (runtime === 'opencode') {
      add(runtime, resolveOpenCodeDataDir(env, home), 'data');
      continue;
    }
    const chosen = defaultAccountPath(config, runtime, { home }).path;
    if (chosen !== null) add(runtime, chosen, 'default');
    add(runtime, path.join(home, runtime === 'claude-code' ? '.claude' : '.codex'), 'home');
    if (runtime === 'claude-code') {
      for (const dir of claudeGlob(home)) add(runtime, dir, 'glob');
    }
    const fromEnv = envValue(env, runtime === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME');
    if (fromEnv !== null) add(runtime, fromEnv, 'env');
    for (const account of accounts) {
      if (account.runtime === runtime && !account.implicit && account.path !== null) {
        add(runtime, account.path, 'registered');
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.runtime === 'opencode') {
      candidate.isDefault = true;
      candidate.account = resolveAccountRef(accounts, 'opencode', 'default');
      continue;
    }
    const chosen = defaultAccountPath(config, candidate.runtime, { home }).path;
    candidate.isDefault =
      chosen !== null && canonicalAccountPath(chosen, home) === candidate.canonicalPath;
    candidate.account = accountForPath(accounts, candidate.runtime, candidate.path, { home });
    if (candidate.runtime === 'claude-code') candidate.orgMarker = orgMarkerOf(candidate.path);
  }
  // The default folder first within each runtime, then the order found.
  return RUNTIMES.flatMap((runtime) => {
    const own = candidates.filter((c) => c.runtime === runtime);
    return [...own.filter((c) => c.isDefault), ...own.filter((c) => !c.isDefault)];
  });
}
