/**
 * The file side of the fleet contracts (spec `flow-cli-core` §1.1, §1.2): where
 * `<dorkHome>` is, how the identity, policy and ledger files are read, and how
 * the policy and ledger are written. The pure rules are pinned by the shared
 * fixture in `fleet-conformance.test.ts`; this suite covers what the fixture
 * cannot, because it touches real files.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dropAccountPolicies,
  fleetPolicyPath,
  loadAccounts,
  loadFleetPolicy,
  loadIdentities,
  resolveDorkHome,
  setAccountPolicy,
  setFleetSetting,
  unknownPolicyKeys,
  updateFleetPolicy,
} from '../scripts/fleet/accounts.ts';
import { PreconditionError, UsageError } from '../scripts/errors.ts';
import {
  ledgerDir,
  ledgerPath,
  listLedgerIds,
  readLedger,
  recordUsage,
  removeLedger,
  type RuntimeSlug,
  type UsageObservation,
} from '../scripts/fleet/usage-ledger.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'flow-fleet-files-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A valid five_hour observation. */
function obs(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    key: 'five_hour',
    usedPct: 40,
    resetsAt: '2026-09-26T19:00:00.000Z',
    status: null,
    observedAt: '2026-09-26T16:00:00.000Z',
    source: 'statusline',
    ...overrides,
  };
}

describe('resolveDorkHome', () => {
  // Purpose: DORK_HOME wins when set and non-empty; an empty value is treated as
  // unset, and the fallback is <os home>/.dork (never DorkOS's dev default).
  it('prefers a non-empty DORK_HOME, else <home>/.dork', () => {
    expect(resolveDorkHome({ DORK_HOME: '/srv/dork' }, '/home/me')).toBe('/srv/dork');
    expect(resolveDorkHome({ DORK_HOME: '' }, '/home/me')).toBe('/home/me/.dork');
    expect(resolveDorkHome({}, '/home/me')).toBe('/home/me/.dork');
  });
});

describe('loadIdentities', () => {
  // Purpose: a missing config.json means no accounts and no error.
  it('reads a missing file as no accounts', () => {
    expect(loadIdentities(home, 'claude-code')).toEqual({ accounts: [], warnings: [] });
  });

  // Purpose: an unparsable config.json is not an error either, but it warns and
  // is left untouched (only DorkOS writes that file's other sections).
  it('reads an unparsable file as no accounts, with a warning, untouched', () => {
    writeFileSync(path.join(home, 'config.json'), '{oops');
    const result = loadIdentities(home, 'claude-code');
    expect(result.accounts).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(['file-corrupt']);
    expect(readFileSync(path.join(home, 'config.json'), 'utf8')).toBe('{oops');
  });

  // Purpose: the real file path is `<dorkHome>/config.json`.
  it('reads rows from <dorkHome>/config.json', () => {
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        runtimes: { claudeCode: { accounts: [{ id: 'work', path: '/w', label: null }] } },
      })
    );
    expect(loadIdentities(home, 'claude-code').accounts).toEqual([
      { id: 'work', path: '/w', label: null, color: null, routable: true },
    ]);
  });
});

describe('loadAccounts', () => {
  // Purpose: every runtime with no registered account has its implicit
  // `default`; a registered runtime lists its rows, tagged with runtime and key.
  it('lists each runtime, with an implicit default where nothing is registered', () => {
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        runtimes: {
          claudeCode: { accounts: [{ id: 'work', path: '/w' }] },
          codex: { accounts: [{ id: 'team', path: '/codex-team' }] },
        },
      })
    );
    const result = loadAccounts(home);
    expect(result.registryReadable).toBe(true);
    expect(result.accounts.map((a) => [a.key, a.implicit, a.path])).toEqual([
      ['claude-code:work', false, '/w'],
      ['codex:team', false, '/codex-team'],
      ['opencode:default', true, null],
    ]);
  });

  // Purpose: a config.json that is not JSON cannot be trusted to list every
  // account, so a caller that deletes by "unregistered" must not act on it.
  it('reports an unreadable registry', () => {
    writeFileSync(path.join(home, 'config.json'), '{oops');
    expect(loadAccounts(home).registryReadable).toBe(false);
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ runtimes: { codex: { accounts: 'nope' } } })
    );
    expect(loadAccounts(home).registryReadable).toBe(false);
  });
});

describe('fleet.json', () => {
  // Purpose: the policy lives at <dorkHome>/flow/fleet.json.
  it('lives under <dorkHome>/flow', () => {
    expect(fleetPolicyPath(home)).toBe(path.join(home, 'flow', 'fleet.json'));
  });

  // Purpose: writers store only what the operator set (defaults are never
  // written), keep fields they do not know, and never touch config.json.
  it('stores only what was set and keeps unknown fields', async () => {
    mkdirSync(path.join(home, 'flow'));
    writeFileSync(
      fleetPolicyPath(home),
      JSON.stringify({
        v: 1,
        future: 'kept',
        accounts: { other: { role: 'rotation', note: 'kept' } },
      })
    );
    const result = await updateFleetPolicy(home, (raw) =>
      setFleetSetting(
        setAccountPolicy(raw, 'claude-code:claude3', { role: 'rotation' }),
        'handoff',
        'ask'
      )
    );
    expect(result.status).toBe('written');
    expect(JSON.parse(readFileSync(fleetPolicyPath(home), 'utf8'))).toEqual({
      v: 1,
      future: 'kept',
      handoff: 'ask',
      accounts: {
        'claude-code:other': { role: 'rotation', note: 'kept' },
        'claude-code:claude3': { role: 'rotation' },
      },
    });
    expect(statSync(fleetPolicyPath(home)).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(home, 'config.json'))).toBe(false);
    expect(readdirSync(path.join(home, 'flow'))).toEqual(['fleet.json']);
  });

  // Purpose: `null` sets a field back to its default by deleting it, and an
  // entry (or scope) left empty is removed rather than stored as `{}`.
  it('deletes fields set back to default and drops empty entries', () => {
    const start = {
      v: 1,
      accounts: {
        'claude-code:org': { role: 'kept-out', reservePct: 10, scope: { repos: ['acme/app'] } },
      },
    };
    const step1 = setAccountPolicy(start, 'claude-code:org', { reservePct: null, repos: null });
    expect(step1).toEqual({ v: 1, accounts: { 'claude-code:org': { role: 'kept-out' } } });
    const step2 = setAccountPolicy(step1, 'claude-code:org', { role: null });
    expect(step2).toEqual({ v: 1, accounts: {} });
    expect(setFleetSetting({ v: 1, handoff: 'ask' }, 'handoff', null)).toEqual({ v: 1 });
    expect(start.accounts['claude-code:org'].reservePct).toBe(10);
  });

  // Purpose: a setter refuses values the contract does not allow, so a bad
  // value is never written for a reader to warn about later.
  it('refuses values the contract does not allow', () => {
    expect(() => setAccountPolicy(undefined, 'claude-code:Bad_ID', { role: 'main' })).toThrow(
      UsageError
    );
    expect(() => setAccountPolicy(undefined, 'a', { role: 'main' })).toThrow(UsageError);
    expect(() => setAccountPolicy(undefined, 'gemini:a', { role: 'main' })).toThrow(UsageError);
    const a = 'claude-code:a';
    expect(() => setAccountPolicy(undefined, a, { reservePct: 101 })).toThrow(UsageError);
    expect(() => setAccountPolicy(undefined, a, { spendDownWindowHours: -1 })).toThrow(UsageError);
    expect(() => setAccountPolicy(undefined, a, { repos: ['acme'] })).toThrow(UsageError);
    expect(() => setFleetSetting(undefined, 'handoff', 'later' as never)).toThrow(UsageError);
    expect(() => setFleetSetting(undefined, 'runtimes', ['codex', 'codex'])).toThrow(UsageError);
    expect(() => setFleetSetting(undefined, 'runtimes', ['gemini' as never])).toThrow(UsageError);
    expect(() => setFleetSetting(undefined, 'crossRuntimeFallback', 'yes' as never)).toThrow(
      UsageError
    );
  });

  // Purpose: a writer never downgrades a fleet.json of another version: the
  // write is refused naming the file and its version, and the file is untouched.
  it('refuses to write a fleet.json of another version', async () => {
    mkdirSync(path.join(home, 'flow'));
    const bytes = JSON.stringify({ v: 2, accounts: { a: { role: 'main', tier: 'new' } } });
    writeFileSync(fleetPolicyPath(home), bytes);
    const write = updateFleetPolicy(home, (raw) => setFleetSetting(raw, 'handoff', 'ask'));
    await expect(write).rejects.toThrow(PreconditionError);
    await expect(updateFleetPolicy(home, (raw) => raw)).rejects.toThrow(
      new RegExp(`${fleetPolicyPath(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is version 2`)
    );
    expect(readFileSync(fleetPolicyPath(home), 'utf8')).toBe(bytes);
    expect(() => setAccountPolicy({ v: 2 }, 'claude-code:a', { role: 'rotation' })).toThrow(
      PreconditionError
    );
    expect(() => setFleetSetting({ v: '1' }, 'handoff', 'ask')).toThrow(PreconditionError);
  });

  // Purpose: the file-reading wrapper resolves the file it finds.
  it('loads and resolves the file', () => {
    mkdirSync(path.join(home, 'flow'));
    writeFileSync(
      fleetPolicyPath(home),
      JSON.stringify({ v: 1, accounts: { a: { role: 'main' } } })
    );
    const resolved = loadFleetPolicy(home, [
      { runtime: 'claude-code', id: 'a', routable: true, implicit: false },
    ]);
    expect(resolved.mains).toEqual({ 'claude-code': 'a' });
    expect(resolved.accounts[0].reservePct).toBe(50);
  });
});

describe('fleet.json keys (contract 2.0.0)', () => {
  // Purpose: a fleet.json written before 2.0.0 has bare keys. They read as
  // Claude Code accounts, and the next write stores them as claude-code:<id>
  // while keeping every value; the prefixed key wins over a bare duplicate.
  it('migrates bare keys on read and on the next write', async () => {
    mkdirSync(path.join(home, 'flow'));
    writeFileSync(
      fleetPolicyPath(home),
      JSON.stringify({
        v: 1,
        accounts: {
          mine: { role: 'main', note: 'kept' },
          spare: { role: 'kept-out' },
          'claude-code:spare': { role: 'rotation' },
        },
      })
    );
    const subjects = [
      { runtime: 'claude-code' as const, id: 'mine', routable: true, implicit: false },
      { runtime: 'claude-code' as const, id: 'spare', routable: true, implicit: false },
    ];
    const read = loadFleetPolicy(home, subjects);
    expect(read.accounts.map((a) => [a.key, a.role])).toEqual([
      ['claude-code:mine', 'main'],
      ['claude-code:spare', 'rotation'],
    ]);
    expect(read.warnings.map((w) => w.code)).toEqual(['entry-duplicate']);

    await updateFleetPolicy(home, (raw) => setFleetSetting(raw, 'crossRuntimeFallback', 'on'));
    expect(JSON.parse(readFileSync(fleetPolicyPath(home), 'utf8'))).toEqual({
      v: 1,
      crossRuntimeFallback: 'on',
      accounts: {
        'claude-code:mine': { role: 'main', note: 'kept' },
        'claude-code:spare': { role: 'rotation' },
      },
    });
  });

  // Purpose: the policies `flow accounts` drops are exactly the stored keys that
  // name no account (a bare key counts by its claude-code: form), and dropping
  // them keeps everything else.
  it('finds and drops the policies of unregistered accounts', () => {
    const raw = {
      v: 1,
      handoff: 'ask',
      accounts: {
        gone: { role: 'rotation' },
        'claude-code:mine': { role: 'main' },
        'codex:default': { role: 'kept-out' },
        'codex:old': { role: 'rotation' },
      },
    };
    const accounts = [
      { runtime: 'claude-code' as const, id: 'mine' },
      { runtime: 'codex' as const, id: 'default' },
    ];
    const keys = unknownPolicyKeys(accounts, raw);
    expect(keys).toEqual(['claude-code:gone', 'codex:old']);
    expect(dropAccountPolicies(raw, keys)).toEqual({
      v: 1,
      handoff: 'ask',
      accounts: { 'claude-code:mine': { role: 'main' }, 'codex:default': { role: 'kept-out' } },
    });
    expect(unknownPolicyKeys(accounts, undefined)).toEqual([]);
  });
});

describe('the usage ledger file', () => {
  // Purpose: the id becomes a file name, so anything that fails the id pattern
  // is refused before it reaches a path (no traversal).
  it('refuses an id that is not an account id', async () => {
    expect(() => ledgerPath(home, 'claude-code', '../escape')).toThrow(/not a valid account id/);
    expect(readLedger(home, 'claude-code', '../escape').warnings.map((w) => w.code)).toEqual([
      'account-id-invalid',
    ]);
    const result = await recordUsage(
      home,
      'claude-code',
      '../escape',
      [obs()],
      '2026-09-26T16:00:00.000Z'
    );
    expect(result.status).toBe('dropped');
    expect(readdirSync(home)).toEqual([]);
  });

  // Purpose: the runtime becomes a folder name too, so only the three runtime
  // slugs reach a path; anything else is refused the same way.
  it('refuses a runtime that is not a runtime slug', async () => {
    const bad = '../../etc' as RuntimeSlug;
    expect(() => ledgerPath(home, bad, 'claude3')).toThrow(/not a runtime flow knows/);
    expect(() => ledgerDir(home, 'gemini' as RuntimeSlug)).toThrow(/not a runtime flow knows/);
    expect(readLedger(home, bad, 'claude3').warnings.map((w) => w.code)).toEqual([
      'runtime-invalid',
    ]);
    const result = await recordUsage(home, bad, 'claude3', [obs()], '2026-09-26T16:00:00.000Z');
    expect(result).toMatchObject({ status: 'dropped', warnings: [{ code: 'runtime-invalid' }] });
    expect(readdirSync(home)).toEqual([]);
  });

  // Purpose: each runtime has its own folder, <dorkHome>/runtimes/<runtime>/usage/,
  // and the file records its runtime, so two runtimes' `default` accounts never
  // share a file.
  it('writes each runtime to its own folder and records the runtime', async () => {
    for (const runtime of ['claude-code', 'codex', 'opencode'] as const) {
      const written = await recordUsage(home, runtime, 'default', [obs()], '2026-09-26T16:00:01Z');
      expect(written.status).toBe('written');
      const file = path.join(home, 'runtimes', runtime, 'usage', 'default.json');
      expect(ledgerPath(home, runtime, 'default')).toBe(file);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
        v: 1,
        runtime,
        accountId: 'default',
      });
    }
  });

  // Purpose: a write lands at <dorkHome>/runtimes/claude-code/usage/<id>.json, folder 0700, file 0600,
  // and a replay of the same observation does not rewrite it.
  it('writes <dorkHome>/runtimes/claude-code/usage/<id>.json and skips a replay', async () => {
    const first = await recordUsage(
      home,
      'claude-code',
      'claude3',
      [obs()],
      '2026-09-26T16:00:01.000Z'
    );
    expect(first.status).toBe('written');
    const file = path.join(home, 'runtimes', 'claude-code', 'usage', 'claude3.json');
    expect(statSync(path.join(home, 'runtimes', 'claude-code', 'usage')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(file, 'utf8');
    const replay = await recordUsage(
      home,
      'claude-code',
      'claude3',
      [obs()],
      '2026-09-26T16:00:02.000Z'
    );
    expect(replay.status).toBe('unchanged');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(readLedger(home, 'claude-code', 'claude3').ledger?.updatedAt).toBe(
      '2026-09-26T16:00:01.000Z'
    );
  });

  // Purpose: the ledger lives under runtimes/<runtime>/usage/ (contract 1.1.0, 2.0.0);
  // a file left at the old <dorkHome>/usage/ is never read, so a stale or
  // foreign reading there cannot steer routing.
  it('ignores a ledger at the old <dorkHome>/usage/ path', () => {
    mkdirSync(path.join(home, 'usage'), { recursive: true });
    writeFileSync(
      path.join(home, 'usage', 'claude3.json'),
      JSON.stringify({
        v: 1,
        accountId: 'claude3',
        updatedAt: '2026-09-26T16:00:00.000Z',
        windows: {
          five_hour: {
            usedPct: 99,
            resetsAt: null,
            status: 'rejected',
            observedAt: '2026-09-26T16:00:00.000Z',
            source: 'statusline',
          },
        },
      })
    );
    expect(readLedger(home, 'claude-code', 'claude3')).toEqual({ ledger: null, warnings: [] });
  });

  // Purpose: dropped observations come back as warnings, never as a throw.
  it('returns merge warnings', async () => {
    const result = await recordUsage(
      home,
      'claude-code',
      'claude3',
      [obs(), obs({ key: 'Bad Key' })],
      '2026-09-26T16:00:01.000Z'
    );
    expect(result.status).toBe('written');
    expect(result.warnings.map((w) => w.code)).toEqual(['observation-invalid']);
  });

  // Purpose: an unparsable ledger is quarantined by the writer and reads as
  // empty (with a warning) for a reader.
  it('reads an unparsable ledger as empty and quarantines it on write', async () => {
    mkdirSync(path.join(home, 'runtimes', 'claude-code', 'usage'), { recursive: true });
    writeFileSync(path.join(home, 'runtimes', 'claude-code', 'usage', 'claude3.json'), 'garbage');
    expect(readLedger(home, 'claude-code', 'claude3')).toMatchObject({
      ledger: null,
      warnings: [{ code: 'file-corrupt' }],
    });
    const result = await recordUsage(
      home,
      'claude-code',
      'claude3',
      [obs()],
      '2026-09-26T16:00:01.000Z'
    );
    expect(result.warnings.map((w) => w.code)).toEqual(['file-corrupt']);
    const names = readdirSync(path.join(home, 'runtimes', 'claude-code', 'usage')).sort();
    expect(names[0]).toBe('claude3.json');
    expect(names[1]).toMatch(/^claude3\.json\.corrupt-\d+$/);
  });
});

describe('listing and removing ledger files', () => {
  // Purpose: only `<valid-id>.json` files are ledgers. Locks, temp files,
  // corrupt backups and status-line stamps are never listed, so prune never
  // touches them.
  it('lists ledger ids and ignores every other file', () => {
    const dir = ledgerDir(home, 'codex');
    expect(listLedgerIds(home, 'codex')).toEqual([]);
    mkdirSync(dir, { recursive: true });
    for (const name of [
      'team.json',
      'default.json',
      'team.json.lock',
      'team.json.1.ab.tmp',
      'team.json.corrupt-1',
      '.statusline-x',
      'Bad_Name.json',
    ]) {
      writeFileSync(path.join(dir, name), '{}');
    }
    expect(listLedgerIds(home, 'codex')).toEqual(['default', 'team']);
  });

  // Purpose: removing a ledger takes its lock (so a merging writer is never cut
  // in half), deletes only that file, and a missing file is not an error.
  it('removes one ledger under its lock', async () => {
    await recordUsage(home, 'codex', 'old', [obs()], '2026-09-26T16:00:01Z');
    await recordUsage(home, 'codex', 'kept', [obs()], '2026-09-26T16:00:01Z');
    expect(await removeLedger(home, 'codex', 'old')).toEqual({ status: 'removed', warnings: [] });
    expect(await removeLedger(home, 'codex', 'old')).toEqual({ status: 'missing', warnings: [] });
    expect(readdirSync(ledgerDir(home, 'codex'))).toEqual(['kept.json']);
  });
});

describe('the fleet modules stay dependency-free', () => {
  // Purpose: the ledger is written from a status-line hook that may run before
  // `npm install`, so these modules (and everything they import) may use only
  // node builtins and other local modules, never a package such as zod.
  it('import only node: builtins and local modules, transitively', () => {
    const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
    const pending = ['atomic-json.ts', 'fleet/accounts.ts', 'fleet/usage-ledger.ts'].map((p) =>
      path.join(scripts, p)
    );
    const seen = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = match[1];
        if (/^\s*import\s+type\s/.test(match[0])) continue;
        if (spec.startsWith('.')) pending.push(path.resolve(path.dirname(file), spec));
        else expect(spec, `${path.relative(scripts, file)} imports ${spec}`).toMatch(/^node:/);
      }
    }
    expect([...seen].map((f) => path.relative(scripts, f)).sort()).toEqual([
      'atomic-json.ts',
      'errors.ts',
      'fleet/accounts.ts',
      'fleet/usage-ledger.ts',
    ]);
  });
});
