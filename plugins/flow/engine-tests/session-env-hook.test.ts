/**
 * The SessionStart hook (`hooks/session-env.mjs`) that hands the session id to
 * the `flow` CLI through `CLAUDE_ENV_FILE`, so `flow claim` in an unattended
 * drain records the session that works the item.
 *
 * Each case runs the real hook as Claude Code does: event JSON on stdin, the
 * env file named in the environment, and a check of what the file holds after.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, '..', 'hooks', 'session-env.mjs');
const HOOKS_JSON = path.resolve(here, '..', 'hooks', 'hooks.json');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flow-session-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the hook with `stdin` and `CLAUDE_ENV_FILE` (omitted when undefined). */
function runHook(stdin: string, envFile: string | undefined) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (envFile !== undefined) env.CLAUDE_ENV_FILE = envFile;
  return spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: 'utf8' });
}

describe('session-env hook', () => {
  it('appends export FLOW_SESSION_ID=<id> to CLAUDE_ENV_FILE', () => {
    // Purpose: this is the one way the drain's claim learns its session id;
    // without it every unattended claim records an unknown session.
    const envFile = path.join(dir, 'env.sh');
    writeFileSync(envFile, 'export KEEP=1\n');
    const result = runHook(JSON.stringify({ session_id: 'abc-123_x.y' }), envFile);
    expect(result.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe(
      'export KEEP=1\nexport FLOW_SESSION_ID=abc-123_x.y\n'
    );
  });

  it('exported this way, a shell sees the id', () => {
    // Purpose: the file is sourced by a shell, so the line must be valid shell.
    const envFile = path.join(dir, 'env.sh');
    runHook(JSON.stringify({ session_id: 'sess-42' }), envFile);
    const shell = spawnSync('sh', ['-c', `. "${envFile}"; printf %s "$FLOW_SESSION_ID"`], {
      encoding: 'utf8',
    });
    expect(shell.stdout).toBe('sess-42');
  });

  it('does nothing without CLAUDE_ENV_FILE', () => {
    // Purpose: other harnesses and old Claude Code builds must start normally.
    const result = runHook(JSON.stringify({ session_id: 'abc' }), undefined);
    expect(result.status).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  const skipped: [string, string][] = [
    ['no session id', JSON.stringify({})],
    ['a non-JSON event', 'not json'],
    ['an id that could inject shell', JSON.stringify({ session_id: 'x; rm -rf ~' })],
    ['an empty id', JSON.stringify({ session_id: '' })],
  ];
  for (const [name, stdin] of skipped) {
    it(`writes nothing and exits 0 for ${name}`, () => {
      // Purpose: the hook never invents an id, never writes unsafe shell, and never blocks a session.
      const envFile = path.join(dir, 'env.sh');
      const result = runHook(stdin, envFile);
      expect(result.status).toBe(0);
      expect(existsSync(envFile)).toBe(false);
    });
  }

  it('is registered as a SessionStart hook run with node from the plugin root', () => {
    // Purpose: an unregistered hook is dead code; the drain would still have no session id.
    const config = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    const commands = config.hooks.SessionStart.flatMap((entry) => entry.hooks);
    expect(commands).toContainEqual({
      type: 'command',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-env.mjs"',
    });
  });
});
