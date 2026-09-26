/**
 * `flow usage prune` (spec `flow-usage` Amendment 1, A6; task 4.4): list the
 * usage files nobody needs, and delete them only with `--yes`. The pure
 * unregistered-id rule is pinned by the shared fixture (`prune.cases.json`);
 * these cases run the verb against real files in a temp `<dorkHome>`.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import { ledgerDir, recordUsage, type RuntimeSlug } from '../../scripts/fleet/usage-ledger.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-09-26T16:00:00.000Z');

let root: string;
let dorkHome: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-usage-prune-'));
  dorkHome = path.join(root, 'dork');
  mkdirSync(dorkHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run `flow <argv>` against the temp home. */
async function flow(argv: string[], now: () => Date = () => NOW) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome },
    cwd: root,
    now,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      throw new Error('flow usage prune must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: path.resolve(here, '..', '..'),
    io: { osHome: path.join(root, 'home') },
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

/** Write one ledger file through the real writer. */
async function ledger(runtime: RuntimeSlug, id: string): Promise<void> {
  const result = await recordUsage(dorkHome, runtime, id, [
    {
      key: 'five_hour',
      usedPct: 10,
      resetsAt: null,
      status: null,
      observedAt: '2026-09-26T15:59:00.000Z',
      source: 'statusline',
    },
  ]);
  expect(result.status).toBe('written');
}

/** The files left in one runtime's usage folder. */
const files = (runtime: RuntimeSlug) => readdirSync(ledgerDir(dorkHome, runtime)).sort();

/** Write a file in one runtime's usage folder (or a legacy one) dated `ageMin` minutes before now. */
function leftover(dir: string, name: string, ageMin: number): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, 'x');
  const when = new Date(NOW.getTime() - ageMin * 60 * 1000);
  utimesSync(file, when, when);
  return file;
}

interface PruneJson {
  applied: boolean;
  files: { runtime: string; file: string; reason: string; accountId?: string; status: string }[];
}

/** `[runtime, basename, reason, status]` for each listed file. */
const rows = (out: PruneJson) =>
  out.files.map((f) => [f.runtime, path.basename(f.file), f.reason, f.status]);

describe('flow usage prune', () => {
  let claudeDir: string;
  let codexDir: string;
  let legacyDir: string;

  beforeEach(async () => {
    writeFileSync(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({ runtimes: { claudeCode: { accounts: [{ id: 'mine', path: '/a/mine' }] } } })
    );
    await ledger('claude-code', 'mine');
    await ledger('claude-code', 'gone');
    await ledger('claude-code', 'default');
    await ledger('codex', 'default');
    await ledger('codex', 'old-team');
    claudeDir = ledgerDir(dorkHome, 'claude-code');
    codexDir = ledgerDir(dorkHome, 'codex');
    legacyDir = path.join(dorkHome, 'usage');
    leftover(claudeDir, '.statusline-x', 600);
    leftover(claudeDir, 'mine.json.corrupt-1790000000000', 600);
    leftover(claudeDir, 'gone.json.corrupt-1790000000000', 1);
    leftover(claudeDir, 'mine.json.1234.abcd.tmp', 61);
    leftover(claudeDir, 'mine.json.5678.efgh.tmp', 59);
    leftover(claudeDir, 'mine.json.lock', 5);
    leftover(codexDir, 'default.json.lock.stale-9f8e', 120);
  });

  /** The plan every case starts from. */
  const EXPECTED = [
    ['claude-code', 'default.json', 'unregistered', 'listed'],
    ['claude-code', 'gone.json', 'unregistered', 'listed'],
    ['claude-code', 'gone.json.corrupt-1790000000000', 'unregistered', 'listed'],
    ['claude-code', 'mine.json.1234.abcd.tmp', 'leftover', 'listed'],
    ['codex', 'default.json.lock.stale-9f8e', 'leftover', 'listed'],
    ['codex', 'old-team.json', 'unregistered', 'listed'],
  ];

  // Purpose: without --yes prune only lists (A6): unregistered ledgers and
  // their corrupt backups at any age, leftovers only past an hour. A known
  // account's ledger, its corrupt backup, a young tmp, a fresh lock and a
  // stamp are never listed, and nothing is deleted.
  it('lists what it would remove and deletes nothing without --yes', async () => {
    const before = [...files('claude-code'), ...files('codex')];
    const result = await flow(['usage', 'prune', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    const out = result.json() as PruneJson;
    expect(out.applied).toBe(false);
    expect(rows(out)).toEqual(EXPECTED);
    expect([...files('claude-code'), ...files('codex')]).toEqual(before);

    const human = await flow(['usage', 'prune']);
    expect(human.stdout).toContain('Would remove');
    expect(human.stdout).toContain('claude-code:gone is not a known account');
    expect(human.stdout).toContain('Run again with --yes');
  });

  // Purpose: --dry-run is kept as the same listing, even beside --yes.
  it('treats --dry-run as the listing, even with --yes', async () => {
    const result = await flow(['usage', 'prune', '--dry-run', '--yes', '--json']);
    expect(result.code).toBe(EXIT.ok);
    expect((result.json() as PruneJson).applied).toBe(false);
    expect(files('claude-code')).toContain('gone.json');
  });

  // Purpose: with --yes exactly the listed files go; a known ledger, a fresh
  // tmp and lock, a stamp and a known account's corrupt backup survive.
  it('deletes exactly the listed files with --yes', async () => {
    const result = await flow(['usage', 'prune', '--yes', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    const out = result.json() as PruneJson;
    expect(out.applied).toBe(true);
    expect(rows(out)).toEqual(EXPECTED.map(([r, n, why]) => [r, n, why, 'removed']));
    expect(files('claude-code')).toEqual([
      '.statusline-x',
      'mine.json',
      'mine.json.5678.efgh.tmp',
      'mine.json.corrupt-1790000000000',
      'mine.json.lock',
    ]);
    expect(files('codex')).toEqual(['default.json']);

    const again = await flow(['usage', 'prune']);
    expect(again.stdout).toContain('Nothing to remove.');
  });

  // Purpose: --yes re-checks each rule right before deleting. An account
  // registered, or a leftover written to again, between the listing and the
  // delete keeps its file.
  it('keeps a file whose rule no longer holds at delete time', async () => {
    let reads = 0;
    const now = () => {
      reads += 1;
      if (reads === 2) {
        // The listing is made; the first re-check is about to run.
        writeFileSync(
          path.join(dorkHome, 'config.json'),
          JSON.stringify({
            runtimes: {
              claudeCode: {
                accounts: [
                  { id: 'mine', path: '/a/mine' },
                  { id: 'gone', path: '/a/gone' },
                ],
              },
            },
          })
        );
        utimesSync(path.join(claudeDir, 'mine.json.1234.abcd.tmp'), NOW, NOW);
      }
      return NOW;
    };
    const result = await flow(['usage', 'prune', '--yes', '--json'], now);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(rows(result.json() as PruneJson)).toEqual([
      ['claude-code', 'default.json', 'unregistered', 'removed'],
      ['claude-code', 'gone.json', 'unregistered', 'kept'],
      ['claude-code', 'gone.json.corrupt-1790000000000', 'unregistered', 'kept'],
      ['claude-code', 'mine.json.1234.abcd.tmp', 'leftover', 'kept'],
      ['codex', 'default.json.lock.stale-9f8e', 'leftover', 'removed'],
      ['codex', 'old-team.json', 'unregistered', 'removed'],
    ]);
    expect(files('claude-code')).toContain('gone.json');
    expect(files('claude-code')).toContain('mine.json.1234.abcd.tmp');
  });

  // Purpose: a registered OpenCode (or Codex) account's ledger is known and kept;
  // an id no longer registered for that runtime is listed.
  it('keeps a registered account of every runtime and lists the unregistered', async () => {
    await ledger('opencode', 'default');
    await ledger('opencode', 'openrouter');
    writeFileSync(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({
        runtimes: {
          claudeCode: { accounts: [{ id: 'mine', path: '/a/mine' }] },
          opencode: { accounts: [{ id: 'openrouter', path: '/a/or' }] },
        },
      })
    );
    const out = (await flow(['usage', 'prune', '--json'])).json() as PruneJson;
    expect(rows(out).filter((r) => r[0] === 'opencode')).toEqual([
      ['opencode', 'default.json', 'unregistered', 'listed'],
    ]);
  });

  it('lists legacy files by the age rule for non-json', async () => {
    leftover(legacyDir, 'claude2.json', 1);
    leftover(legacyDir, '.statusline-old', 90);
    leftover(legacyDir, '.statusline-fresh', 10);
    leftover(legacyDir, 'claude2.json.corrupt-1', 90);
    leftover(legacyDir, 'claude3.json.corrupt-2', 10);
    leftover(legacyDir, 'notes.txt', 900);
    const result = await flow(['usage', 'prune', '--yes', '--json']);
    const legacy = rows(result.json() as PruneJson).filter(([runtime]) => runtime === 'legacy');
    expect(legacy).toEqual([
      ['legacy', '.statusline-old', 'legacy', 'removed'],
      ['legacy', 'claude2.json', 'legacy', 'removed'],
      ['legacy', 'claude2.json.corrupt-1', 'legacy', 'removed'],
    ]);
    expect(readdirSync(legacyDir).sort()).toEqual([
      '.statusline-fresh',
      'claude3.json.corrupt-2',
      'notes.txt',
    ]);
  });

  // Purpose: with a config.json that cannot be read, every account would look
  // unregistered, so prune refuses (exit 3) rather than delete them all.
  it('removes nothing when config.json cannot be read', async () => {
    writeFileSync(path.join(dorkHome, 'config.json'), '{oops');
    const result = await flow(['usage', 'prune', '--yes']);
    expect(result.code).toBe(EXIT.config);
    expect(files('claude-code')).toContain('gone.json');
  });
});
