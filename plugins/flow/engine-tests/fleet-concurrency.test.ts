/**
 * Cross-process proofs for the shared lock-and-rename writer (spec
 * `flow-cli-core` §1.2 "Writing", Testing Strategy "Concurrency").
 *
 * The single-process suite (`atomic-json.test.ts`) pins each step; only real
 * processes can show the steps hold under a real race. Each child is a fresh
 * `node --experimental-strip-types` that imports the module under test, waits on
 * a start file so every child contends at once, does its one job, and prints a
 * JSON line.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const LEDGER_URL = pathToFileURL(path.join(SCRIPTS, 'fleet', 'usage-ledger.ts')).href;
const ATOMIC_URL = pathToFileURL(path.join(SCRIPTS, 'atomic-json.ts')).href;

let dir: string;
let go: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'flow-fleet-concurrency-'));
  go = path.join(dir, 'go');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Code every child runs first: spin until the start file exists. */
const WAIT_FOR_GO = `
import { existsSync } from 'node:fs';
const go = process.env.GO_FILE;
while (!existsSync(go)) await new Promise((r) => setTimeout(r, 5));
`;

/** Run `code` as an ES module child; resolve with its parsed JSON stdout. */
function child(code: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        WAIT_FOR_GO + code,
      ],
      { env: { ...process.env, ...env, GO_FILE: go }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (err += chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim()) as Record<string, unknown>);
    });
  });
}

/** Give the children time to start, then open the gate. */
async function openGate(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(go, '');
}

describe('eight writers merging into one ledger', () => {
  // Purpose: the reason the lock exists. Eight processes each merge a different
  // window into the same ledger at the same moment; without the lock, a later
  // rename would carry an older read and delete other writers' windows.
  it('keeps every window', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `window_${i}`);
    const runs = keys.map((key) =>
      child(
        `
        const { recordUsage } = await import(${JSON.stringify(LEDGER_URL)});
        const result = await recordUsage(process.env.HOME_DIR, 'claude3', [{
          key: process.env.KEY, usedPct: 10, resetsAt: null, status: null,
          observedAt: '2026-09-26T16:00:00.000Z', source: 'statusline',
        }], '2026-09-26T16:00:01.000Z');
        console.log(JSON.stringify(result));
        `,
        { HOME_DIR: dir, KEY: key }
      )
    );
    await openGate();
    const results = await Promise.all(runs);
    expect(results.map((r) => r.status)).toEqual(keys.map(() => 'written'));
    const ledger = JSON.parse(readFileSync(path.join(dir, 'usage', 'claude3.json'), 'utf8')) as {
      windows: Record<string, unknown>;
    };
    expect(Object.keys(ledger.windows).sort()).toEqual(keys);
    expect(readdirSync(path.join(dir, 'usage'))).toEqual(['claude3.json']);
  }, 30_000);
});

describe('two waiters racing for one stale lock', () => {
  // Purpose: when two processes find the same stale lock at once, it is broken
  // exactly once, both still get the lock in turn, and their holds never
  // overlap. A breaker that renames the other's fresh lock by mistake must put
  // it back rather than count a second break.
  it('breaks it exactly once and serializes the holders', async () => {
    const lock = path.join(dir, 'data.json.lock');
    for (let round = 0; round < 3; round += 1) {
      writeFileSync(lock, 'dead:0');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const runs = [0, 1].map(() =>
        child(
          `
          const { acquireLock, releaseLock } = await import(${JSON.stringify(ATOMIC_URL)});
          const held = await acquireLock(process.env.LOCK);
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 150));
          const end = Date.now();
          releaseLock(process.env.LOCK, held.token);
          console.log(JSON.stringify({ broke: held.broke, start, end }));
          `,
          { LOCK: lock }
        )
      );
      await openGate();
      const [a, b] = (await Promise.all(runs)) as { broke: number; start: number; end: number }[];
      rmSync(go);
      expect(a.broke + b.broke).toBe(1);
      const [first, second] = a.start <= b.start ? [a, b] : [b, a];
      expect(second.start).toBeGreaterThanOrEqual(first.end);
      expect(readdirSync(dir)).toEqual([]);
    }
  }, 30_000);
});
