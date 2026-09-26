/**
 * `flow usage record --runtime codex` (spec `flow-usage` Amendment 1, A4; task
 * 4.1), and `--runtime` on `record` and `scan`. Driven through
 * `main(argv, deps)` with a fake stdin, a temp home and a fake watchdog. The
 * silence rules of §2.1 hold: nothing on stdout, exit 0 but for a TTY or a
 * bad flag.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostIo } from '../../scripts/cli/host-io.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/usage/codex');
const NOW = new Date('2026-09-26T20:00:00.000Z');

let root: string;
let dorkHome: string;
let osHome: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-record-codex-'));
  dorkHome = path.join(root, 'dork');
  osHome = path.join(root, 'home');
  mkdirSync(dorkHome, { recursive: true });
  mkdirSync(osHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function flow(
  argv: string[],
  input: string | null,
  opts: { env?: Record<string, string>; isTTY?: boolean } = {}
) {
  let stdout = '';
  let stderr = '';
  const armWatchdog = vi.fn();
  const io: Partial<HostIo> = {
    stdin: { isTTY: opts.isTTY ?? false, read: async () => input },
    osHome,
    armWatchdog,
  };
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome, ...opts.env },
    cwd: root,
    now: () => NOW,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    io,
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr, armWatchdog };
}

const record = (input: string | null, extra: string[] = [], opts = {}) =>
  flow(['usage', 'record', '--runtime', 'codex', ...extra], input, opts);

interface StoredLedger {
  windows: Record<string, Record<string, unknown>>;
  plan?: Record<string, unknown>;
  credits?: Record<string, unknown>;
}

function ledger(id = 'default'): StoredLedger | null {
  const file = path.join(dorkHome, 'runtimes', 'codex', 'usage', `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

const bare = () => readFileSync(path.join(FIXTURES, 'bare-rate-limits.json'), 'utf8');

/** One line of the pro fixture that holds the main limit (dated 19:05). */
function rolloutLine(): string {
  return readFileSync(path.join(FIXTURES, 'rollout-pro.jsonl'), 'utf8')
    .split('\n')
    .find((line) => line.includes('"2026-09-26T19:05:00.000Z"')) as string;
}

describe('flow usage record --runtime codex', () => {
  it('records a bare rate_limits object, dated now, and prints nothing', async () => {
    // Purpose: a Codex hook or DorkOS pipes the object in; it has no time of its own.
    const result = await record(bare());
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.armWatchdog).toHaveBeenCalledWith(3000);
    const stored = ledger();
    expect(stored?.windows.five_hour).toEqual({
      usedPct: 5,
      resetsAt: '2026-09-26T23:30:00.000Z',
      windowMinutes: 300,
      status: null,
      observedAt: NOW.toISOString(),
      source: 'rollout',
    });
    expect(stored?.windows.seven_day).toMatchObject({
      usedPct: 9.5,
      observedAt: NOW.toISOString(),
    });
    expect(stored?.plan).toMatchObject({ name: 'plus', observedAt: NOW.toISOString() });
    expect(stored?.credits).toMatchObject({ hasCredits: false, balance: null });
  });

  it('records a rollout line, dated by its own timestamp', async () => {
    // Purpose: a whole session-log line keeps the time Codex saw the reading.
    const result = await record(rolloutLine(), ['--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      ok: true,
      account: 'default',
      recorded: ['five_hour', 'seven_day', 'plan', 'credits'],
      changed: true,
      dropped: false,
    });
    expect(ledger()?.windows.five_hour).toMatchObject({
      usedPct: 22,
      observedAt: '2026-09-26T19:05:00.000Z',
    });
  });

  it('records nothing, silently, for a line that is not a token_count event or input that is not JSON', async () => {
    // Purpose: §2.1's silence rules: nothing recorded is still exit 0 with no output.
    const decoy = JSON.stringify({
      timestamp: '2026-09-26T19:06:40.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', rate_limits: JSON.parse(bare()) },
    });
    for (const input of [decoy, 'not json', '[]', null]) {
      const result = await record(input);
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(ledger()).toBeNull();

    const verbose = await record(decoy, ['--verbose']);
    expect(verbose.stderr).toContain('no Codex usage in the input');
  });

  it('writes for the registered account whose home is CODEX_HOME, and for no other', async () => {
    // Purpose: with registered Codex accounts the ambient home picks one; an
    // unregistered home records nothing.
    const work = path.join(root, 'codex-work');
    mkdirSync(work);
    writeFileSync(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({ runtimes: { codex: { accounts: [{ id: 'work', path: work }] } } })
    );
    await record(bare(), [], { env: { CODEX_HOME: work } });
    expect(ledger('work')).not.toBeNull();

    const other = await record(bare(), ['--json'], { env: { CODEX_HOME: path.join(root, 'x') } });
    expect(JSON.parse(other.stdout)).toMatchObject({ account: null, recorded: [] });
    expect(ledger()).toBeNull();
  });

  it('fails only for a terminal on stdin', async () => {
    // Purpose: a person typing it by hand learns what to pipe in.
    const result = await record(bare(), [], { isTTY: true });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Codex rate_limits object');
  });
});

describe('--runtime', () => {
  it('refuses an unknown runtime on record and scan with exit 2', async () => {
    // Purpose: a typo must not silently record for Claude Code.
    for (const sub of ['record', 'scan']) {
      const result = await flow(['usage', sub, '--runtime', 'gemini'], bare());
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('claude-code, codex, opencode');
    }
  });

  it('is not taken by other sub-verbs', async () => {
    // Purpose: the dispatcher allows --runtime on record and scan only.
    const result = await flow(['usage', 'prune', '--runtime', 'codex'], null);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('does not take --runtime');
  });
});
