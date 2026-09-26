/**
 * `flow usage record` (spec `flow-usage` §2.1), driven through `main(argv, deps)`
 * with a fake stdin, a temp home and a fake watchdog. The status line runs this
 * in the background, so the contract is: write both windows with their reset
 * times, print nothing, and never fail loudly.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostIo } from '../../scripts/cli/host-io.ts';
import { fingerprintIsFaithful } from '../../scripts/cli/usage-record.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/usage');
const NOW = new Date('2026-09-26T16:04:10.000Z');

let root: string;
let dorkHome: string;
let osHome: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-record-'));
  dorkHome = path.join(root, 'dork');
  osHome = path.join(root, 'home');
  mkdirSync(path.join(osHome, '.claude'), { recursive: true });
  mkdirSync(path.join(osHome, '.claude-a'), { recursive: true });
  mkdirSync(dorkHome, { recursive: true });
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'acct-a', path: path.join(osHome, '.claude-a'), label: null, color: null },
            { id: 'main', path: path.join(osHome, '.claude'), label: null, color: null },
          ],
        },
      },
    })
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sink() {
  let text = '';
  return { write: (chunk: string) => ((text += chunk), true), text: () => text };
}

function statusLine(name: string): string {
  return readFileSync(path.join(FIXTURES, 'statusline', name), 'utf8');
}

async function record(
  input: string | null,
  opts: { env?: Record<string, string>; argv?: string[]; isTTY?: boolean } = {}
) {
  const stdout = sink();
  const stderr = sink();
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
    stdout,
    stderr,
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    io,
  };
  const code = await main(['usage', 'record', ...(opts.argv ?? [])], deps);
  return { code, stdout: stdout.text(), stderr: stderr.text(), armWatchdog };
}

function ledger(id: string): Record<string, unknown> | null {
  const file = path.join(dorkHome, 'runtimes', 'claude-code', 'usage', `${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

const acctAEnv = () => ({ CLAUDE_CONFIG_DIR: path.join(osHome, '.claude-a') });

describe('flow usage record', () => {
  it('writes both windows with their reset times and prints nothing (DOR-2369 validation 1)', async () => {
    // Purpose: the recorder exists to keep resets_at, and the status line must see no output.
    const result = await record(statusLine('full.json'), { env: acctAEnv() });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.armWatchdog).toHaveBeenCalledWith(3000);
    expect(ledger('acct-a')).toMatchObject({
      v: 1,
      accountId: 'acct-a',
      windows: {
        five_hour: {
          usedPct: 41.5,
          resetsAt: '2026-09-26T19:00:00.000Z',
          source: 'statusline',
          observedAt: NOW.toISOString(),
        },
        seven_day: { usedPct: 72, resetsAt: '2026-09-30T19:00:00.000Z' },
      },
    });
  });

  it('uses ~/.claude when CLAUDE_CONFIG_DIR is unset, and --account overrides', async () => {
    // Purpose: the main account usually runs with no variable at all.
    await record(statusLine('full.json'));
    expect(ledger('main')).not.toBeNull();
    await record(statusLine('iso-resets.json'), { argv: ['--account', 'acct-a'] });
    expect(ledger('acct-a')).not.toBeNull();
  });

  it('writes nothing for an unregistered dir, bad JSON, or oversized input', async () => {
    // Purpose: a status line on an account flow does not know must stay silent and harmless.
    for (const run of [
      () =>
        record(statusLine('full.json'), { env: { CLAUDE_CONFIG_DIR: path.join(osHome, 'nope') } }),
      () => record('{not json', { env: acctAEnv() }),
      () => record(null, { env: acctAEnv() }),
      () => record(statusLine('full.json'), { argv: ['--account', 'ghost'] }),
    ]) {
      expect(await run()).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(existsSync(path.join(dorkHome, 'runtimes', 'claude-code', 'usage'))).toBe(false);
  });

  it('refuses a terminal on stdin', async () => {
    // Purpose: a person typing it by hand gets a hint instead of a silent wait.
    const result = await record('', { isTTY: true });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/pipe the status-line JSON/);
  });

  it('prints the envelope with --json and warnings with --verbose', async () => {
    // Purpose: people and tests can see what happened; the hook passes neither flag.
    const json = await record(statusLine('full.json'), { env: acctAEnv(), argv: ['--json'] });
    expect(JSON.parse(json.stdout)).toEqual({
      v: 1,
      ok: true,
      account: 'acct-a',
      recorded: ['five_hour', 'seven_day'],
      changed: true,
      dropped: false,
    });
    const verbose = await record('{not json', { env: acctAEnv(), argv: ['--verbose'] });
    expect(verbose.stderr).toMatch(/not JSON/);
  });

  describe('the dedupe stamp', () => {
    const fp = (text: string) => {
      const after = text.slice(text.indexOf('"rate_limits"') + '"rate_limits"'.length);
      return after.slice(0, after.indexOf('}}'));
    };
    const stampPath = () =>
      path.join(dorkHome, 'runtimes', 'claude-code', 'usage', '.statusline-x');
    const hookEnv = (text: string, stamp = stampPath()) => ({
      ...acctAEnv(),
      FLOW_USAGE_FP: fp(text),
      FLOW_USAGE_STAMP: stamp,
    });

    it('stamps a settled write whose fingerprint reads back whole', async () => {
      // Purpose: the hook skips Node only for a reading already recorded.
      const text = statusLine('full.json');
      await record(text, { env: hookEnv(text) });
      expect(readFileSync(stampPath(), 'utf8')).toBe(`${fp(text)}\n`);
    });

    it('stamps when nothing could be recorded', async () => {
      // Purpose: an unregistered dir, or no valid window, must not start Node on every render.
      const text = statusLine('full.json');
      await record(text, {
        env: { ...hookEnv(text), CLAUDE_CONFIG_DIR: path.join(osHome, 'nope') },
      });
      expect(existsSync(stampPath())).toBe(true);
      rmSync(stampPath());
      const none = '{"rate_limits":{"five_hour":{"resets_at":1790449200}}}';
      await record(none, { env: hookEnv(none) });
      expect(existsSync(stampPath())).toBe(true);
    });

    it('never stamps a fingerprint cut short', async () => {
      // Purpose: a nested object in a future window would cut the fingerprint and hide changes.
      const text =
        '{"rate_limits":{"five_hour":{"used_percentage":5,"resets_at":1790449200,"extra":{"a":1}},"seven_day":{"used_percentage":6,"resets_at":1790794800}}}';
      await record(text, { env: hookEnv(text) });
      expect(ledger('acct-a')).not.toBeNull();
      expect(existsSync(stampPath())).toBe(false);
    });

    it('ignores a stamp path outside <dorkHome>/usage', async () => {
      // Purpose: an environment variable must never make record write anywhere else.
      const text = statusLine('full.json');
      const outside = path.join(root, '.statusline-evil');
      await record(text, { env: hookEnv(text, outside) });
      expect(existsSync(outside)).toBe(false);
      const wrongName = path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'acct-a.json.bak');
      await record(text, { env: hookEnv(text, wrongName) });
      expect(existsSync(wrongName)).toBe(false);
    });

    it('leaves the stamp alone when the write is dropped', async () => {
      // Purpose: a dropped write must be retried on the next render.
      const text = statusLine('full.json');
      mkdirSync(path.join(dorkHome, 'runtimes', 'claude-code', 'usage'), { recursive: true });
      // A live holder's lock (fresh mtime, never released) makes the writer give up after 2 s.
      writeFileSync(
        path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'acct-a.json.lock'),
        `${process.pid}:held`
      );
      const result = await record(text, { env: hookEnv(text), argv: ['--json'] });
      expect(JSON.parse(result.stdout)).toMatchObject({ dropped: true });
      expect(existsSync(stampPath())).toBe(false);
    }, 10_000);
  });
});

describe('fingerprintIsFaithful', () => {
  it('accepts only a fingerprint that parses back to the whole object', () => {
    // Purpose: the one check that keeps the dedupe from hiding a change.
    const rl = { five_hour: { used_percentage: 1, resets_at: 2 } };
    expect(fingerprintIsFaithful(':{"five_hour":{"used_percentage":1,"resets_at":2', rl)).toBe(
      true
    );
    expect(fingerprintIsFaithful(':{"five_hour":{"used_percentage":1', rl)).toBe(false);
    expect(fingerprintIsFaithful('{"five_hour":{"used_percentage":1,"resets_at":2', rl)).toBe(
      false
    );
  });
});
