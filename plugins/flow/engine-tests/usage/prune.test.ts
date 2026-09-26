/**
 * `flow usage prune` (spec `flow-cli-core` §6, §1.2 "Removing an account"):
 * deleting the usage files of accounts that are no longer registered. The pure
 * rule is pinned by the shared fixture (`prune.cases.json`); these cases run the
 * verb against real files in a temp `<dorkHome>`.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';
import { ledgerDir, recordUsage, type RuntimeSlug } from '../../scripts/fleet/usage-ledger.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

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
async function flow(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome },
    cwd: root,
    now: () => new Date('2026-09-26T16:00:00.000Z'),
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

describe('flow usage prune', () => {
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
    mkdirSync(ledgerDir(dorkHome, 'claude-code'), { recursive: true });
    writeFileSync(path.join(ledgerDir(dorkHome, 'claude-code'), '.statusline-x'), 'stamp');
  });

  // Purpose: only the files of accounts that are not registered go, in every
  // runtime; a registered account's file, each runtime's `default` and every
  // file that is not a ledger (a status-line stamp) stay.
  it('removes the files of unregistered accounts and keeps default', async () => {
    const result = await flow(['usage', 'prune', '--json']);
    expect(result.code, result.stderr).toBe(EXIT.ok);
    expect(
      result
        .json()
        .files.map((f: { runtime: string; accountId: string; status: string }) => [
          f.runtime,
          f.accountId,
          f.status,
        ])
    ).toEqual([
      ['claude-code', 'gone', 'removed'],
      ['codex', 'old-team', 'removed'],
    ]);
    expect(files('claude-code')).toEqual(['.statusline-x', 'default.json', 'mine.json']);
    expect(files('codex')).toEqual(['default.json']);
  });

  // Purpose: --dry-run names what would go and deletes nothing.
  it('changes nothing with --dry-run', async () => {
    const result = await flow(['usage', 'prune', '--dry-run']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain('Would remove');
    expect(result.stdout).toContain('claude-code:gone');
    expect(files('claude-code')).toEqual([
      '.statusline-x',
      'default.json',
      'gone.json',
      'mine.json',
    ]);
    expect(existsSync(path.join(ledgerDir(dorkHome, 'codex'), 'old-team.json'))).toBe(true);
  });

  // Purpose: with a config.json that cannot be read, every account would look
  // unregistered, so prune refuses (exit 3) rather than delete them all.
  it('removes nothing when config.json cannot be read', async () => {
    writeFileSync(path.join(dorkHome, 'config.json'), '{oops');
    const result = await flow(['usage', 'prune']);
    expect(result.code).toBe(EXIT.config);
    expect(files('claude-code')).toContain('gone.json');
  });

  // Purpose: with nothing to remove it says so plainly.
  it('says when there is nothing to remove', async () => {
    await flow(['usage', 'prune']);
    const again = await flow(['usage', 'prune']);
    expect(again.code).toBe(EXIT.ok);
    expect(again.stdout).toContain('nothing to remove');
  });
});
