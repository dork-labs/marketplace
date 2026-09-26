#!/usr/bin/env node

/**
 * SessionStart hook: hand this session's id to the `flow` CLI.
 *
 * `flow claim` records the session that works an item (`FlowRun.sessionId`,
 * the handle recovery resumes). It reads `--session`, else `FLOW_SESSION_ID`.
 * An agent's Bash commands do not keep environment variables between calls, but
 * Claude Code sources the file named by `CLAUDE_ENV_FILE` before each one, and
 * hands SessionStart hooks both that file and the session id (`session_id` on
 * stdin). So this hook appends `export FLOW_SESSION_ID=<id>` to that file.
 *
 * It does nothing, and exits 0, when either is missing, when the id is not a
 * plain token (letters, digits, `.`, `_`, `-`, so it can never inject shell), or
 * when the write fails. It must never stop a session from starting.
 *
 * @module @dorkos/flow/hooks/session-env
 */

import { appendFileSync } from 'node:fs';

/** A session id safe to write unquoted into a shell file. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The line to append, or `undefined` when there is nothing safe to write.
 *
 * @param {string} stdin - The SessionStart event JSON.
 * @param {string | undefined} envFile - `CLAUDE_ENV_FILE`.
 * @returns {string | undefined} `export FLOW_SESSION_ID=<id>\n`, or nothing.
 */
export function sessionEnvLine(stdin, envFile) {
  if (typeof envFile !== 'string' || envFile === '') return undefined;
  let id;
  try {
    id = JSON.parse(stdin)?.session_id;
  } catch {
    return undefined;
  }
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return undefined;
  return `export FLOW_SESSION_ID=${id}\n`;
}

/**
 * Read stdin with a hard timeout so the hook never hangs a session.
 *
 * @returns {Promise<string>} Whatever arrived.
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      process.stdin.removeAllListeners();
      process.stdin.unref();
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000).unref();
  });
}

async function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  const line = sessionEnvLine(await readStdin(), envFile);
  if (line !== undefined) {
    try {
      appendFileSync(envFile, line);
    } catch {
      // Never block a session over this; the claim still runs, with a warning.
    }
  }
  process.exit(0);
}

// Only run the hook when invoked directly, not when imported by a test.
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main();
}
