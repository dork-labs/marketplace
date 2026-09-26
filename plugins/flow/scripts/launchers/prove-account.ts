/**
 * Proving which account a session bills (spec `flow-handoff-dispatch` §2.1
 * "Proving the account"), shared by the cli and cmux launchers.
 *
 * Claude Code writes a session's transcript to
 * `<CLAUDE_CONFIG_DIR>/projects/<project slug>/<sessionId>.jsonl`. A transcript
 * with our session id under the account's dir proves the session runs in that
 * config dir, and so on that account's login.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/launchers/prove-account
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The transcript of `sessionId` under a config dir, if there is one.
 *
 * @param configDir - An absolute `CLAUDE_CONFIG_DIR`.
 * @param sessionId - The session id (already validated as a file name).
 * @returns The transcript's absolute path, or `null`.
 */
export function findTranscript(configDir: string, sessionId: string): string | null {
  const projects = path.join(configDir, 'projects');
  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(projects, entry, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this project folder.
    }
  }
  return null;
}

/**
 * Whether the session's transcript exists under the account's config dir.
 *
 * @param configDir - The account's absolute config dir (for the ambient account,
 *   the supervisor's resolved dir).
 * @param sessionId - The session id.
 * @returns True when `<configDir>/projects/*\/<sessionId>.jsonl` exists.
 */
export function proveAccount(configDir: string, sessionId: string): boolean {
  return findTranscript(configDir, sessionId) !== null;
}
