/**
 * The status-line hook as real processes (spec `flow-usage` §2.2): real bash,
 * real node, temp folders. These prove what no unit test can: the status line
 * never waits for the recorder, the hook skips Node when nothing changed, and
 * `usage record` runs where `npm install` never ran.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recorderBlock } from '../../scripts/cli/usage-install.ts';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(FLOW_ROOT, 'scripts', 'usage', 'statusline-hook.sh');
/** The status-line payload as Claude Code sends it: one compact line. */
const FULL = JSON.stringify(
  JSON.parse(
    readFileSync(
      path.join(FLOW_ROOT, 'engine-tests', 'fixtures', 'usage', 'statusline', 'full.json'),
      'utf8'
    )
  )
);

/** Every bash to prove the hook on: macOS's 3.2 and whatever `bash` is on PATH. */
const BASHES = [
  ...new Set(['/bin/bash', spawnSync('bash', ['-c', 'command -v bash']).stdout.toString().trim()]),
].filter((bash) => bash !== '' && existsSync(bash));

let root: string;
let dorkHome: string;
let configDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-hook-'));
  dorkHome = path.join(root, 'dork');
  configDir = path.join(root, '.claude-a');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dorkHome, { recursive: true });
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      runtimes: {
        claudeCode: { accounts: [{ id: 'acct-a', path: configDir, label: null, color: null }] },
      },
    })
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run a command with stdin, resolving when its stdout closes (as Claude Code reads it). */
function runUntilStdoutCloses(cmd: string, args: string[], input: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ ms: number; stdout: string }>((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stdout.on('close', () =>
      resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, stdout })
    );
    child.stdin.end(input);
  });
}

describe('the status-line lines', () => {
  it.each(BASHES)('never make the status line wait for the recorder (%s)', async (bash) => {
    // Purpose: with the redirection on the wrong group, a slow recorder held the status line for 2 s.
    const slowHook = path.join(root, 'slow-hook.sh');
    writeFileSync(slowHook, '#!/bin/bash\nsleep 2\n');
    chmodSync(slowHook, 0o755);
    const [marker, line] = recorderBlock('input', slowHook, process.execPath, FLOW_ROOT);
    const script = path.join(root, 'statusline.sh');
    writeFileSync(script, `#!/bin/bash\ninput=$(cat)\n${marker}\n${line}\nprintf 'rendered'\n`);
    const result = await runUntilStdoutCloses(bash, [script], FULL, { PATH: process.env.PATH });
    expect(result.stdout).toBe('rendered');
    expect(result.ms).toBeLessThan(1_000);
  });
});

describe('the hook', () => {
  it.each(BASHES)(
    'starts Node only when a reading changed (%s)',
    async (bash) => {
      // Purpose: the status line renders several times a second; Node must not start each time.
      const count = path.join(root, 'count');
      const stubNode = path.join(root, 'node-stub.sh');
      writeFileSync(
        stubNode,
        `#!/bin/bash\necho x >> '${count}'\nexec '${process.execPath}' "$@"\n`
      );
      chmodSync(stubNode, 0o755);
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        DORK_HOME: dorkHome,
        CLAUDE_CONFIG_DIR: configDir,
        FLOW_NODE: stubNode,
      };
      const calls = () =>
        existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0;

      await runUntilStdoutCloses(bash, [HOOK], FULL, env);
      expect(calls()).toBe(1);
      const ledger = JSON.parse(readFileSync(path.join(dorkHome, 'usage', 'acct-a.json'), 'utf8'));
      expect(ledger.windows.five_hour.resetsAt).toBe('2026-09-26T19:00:00.000Z');

      await runUntilStdoutCloses(bash, [HOOK], FULL, env);
      expect(calls()).toBe(1);

      await runUntilStdoutCloses(
        bash,
        [HOOK],
        FULL.replace('"used_percentage":41.5', '"used_percentage":42'),
        env
      );
      expect(calls()).toBe(2);

      // No rate_limits at all (before the first response): never starts Node.
      await runUntilStdoutCloses(bash, [HOOK], '{"model":{"display_name":"Opus"}}', env);
      expect(calls()).toBe(2);
    },
    30_000
  );
});

describe('usage record without npm install', () => {
  it('writes the ledger from a copy of scripts/ with no node_modules', async () => {
    // Purpose: the status line may run flow on a checkout where npm install never ran.
    const copy = path.join(root, 'flow');
    cpSync(path.join(FLOW_ROOT, 'scripts'), path.join(copy, 'scripts'), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        path.join(copy, 'scripts', 'flow.ts'),
        'usage',
        'record',
        '--verbose',
      ],
      {
        input: FULL,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          DORK_HOME: dorkHome,
          CLAUDE_CONFIG_DIR: configDir,
        },
        encoding: 'utf8',
      }
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(path.join(dorkHome, 'usage', 'acct-a.json'))).toBe(true);
  }, 30_000);
});
