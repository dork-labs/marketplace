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
  fleetPolicyPath,
  loadFleetPolicy,
  loadIdentities,
  resolveDorkHome,
  setAccountPolicy,
  setHandoff,
  updateFleetPolicy,
} from '../scripts/fleet/accounts.ts';
import { PreconditionError, UsageError } from '../scripts/errors.ts';
import {
  ledgerPath,
  readLedger,
  recordUsage,
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
    expect(loadIdentities(home)).toEqual({ accounts: [], warnings: [] });
  });

  // Purpose: an unparsable config.json is not an error either, but it warns and
  // is left untouched (only DorkOS writes that file's other sections).
  it('reads an unparsable file as no accounts, with a warning, untouched', () => {
    writeFileSync(path.join(home, 'config.json'), '{oops');
    const result = loadIdentities(home);
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
    expect(loadIdentities(home).accounts).toEqual([
      { id: 'work', path: '/w', label: null, color: null, routable: true },
    ]);
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
      setHandoff(setAccountPolicy(raw, 'claude3', { role: 'rotation' }), 'ask')
    );
    expect(result.status).toBe('written');
    expect(JSON.parse(readFileSync(fleetPolicyPath(home), 'utf8'))).toEqual({
      v: 1,
      future: 'kept',
      handoff: 'ask',
      accounts: {
        other: { role: 'rotation', note: 'kept' },
        claude3: { role: 'rotation' },
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
      accounts: { org: { role: 'kept-out', reservePct: 10, scope: { repos: ['acme/app'] } } },
    };
    const step1 = setAccountPolicy(start, 'org', { reservePct: null, repos: null });
    expect(step1).toEqual({ v: 1, accounts: { org: { role: 'kept-out' } } });
    const step2 = setAccountPolicy(step1, 'org', { role: null });
    expect(step2).toEqual({ v: 1, accounts: {} });
    expect(setHandoff({ v: 1, handoff: 'ask' }, null)).toEqual({ v: 1 });
    expect(start.accounts.org.reservePct).toBe(10);
  });

  // Purpose: a setter refuses values the contract does not allow, so a bad
  // value is never written for a reader to warn about later.
  it('refuses values the contract does not allow', () => {
    expect(() => setAccountPolicy(undefined, 'Bad_ID', { role: 'main' })).toThrow(UsageError);
    expect(() => setAccountPolicy(undefined, 'a', { reservePct: 101 })).toThrow(UsageError);
    expect(() => setAccountPolicy(undefined, 'a', { spendDownWindowHours: -1 })).toThrow(
      UsageError
    );
    expect(() => setAccountPolicy(undefined, 'a', { repos: ['acme'] })).toThrow(UsageError);
    expect(() => setHandoff(undefined, 'later' as never)).toThrow(UsageError);
  });

  // Purpose: a writer never downgrades a fleet.json of another version: the
  // write is refused naming the file and its version, and the file is untouched.
  it('refuses to write a fleet.json of another version', async () => {
    mkdirSync(path.join(home, 'flow'));
    const bytes = JSON.stringify({ v: 2, accounts: { a: { role: 'main', tier: 'new' } } });
    writeFileSync(fleetPolicyPath(home), bytes);
    const write = updateFleetPolicy(home, (raw) => setHandoff(raw, 'ask'));
    await expect(write).rejects.toThrow(PreconditionError);
    await expect(updateFleetPolicy(home, (raw) => raw)).rejects.toThrow(
      new RegExp(`${fleetPolicyPath(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is version 2`)
    );
    expect(readFileSync(fleetPolicyPath(home), 'utf8')).toBe(bytes);
    expect(() => setAccountPolicy({ v: 2 }, 'a', { role: 'rotation' })).toThrow(PreconditionError);
    expect(() => setHandoff({ v: '1' }, 'ask')).toThrow(PreconditionError);
  });

  // Purpose: the file-reading wrapper resolves the file it finds.
  it('loads and resolves the file', () => {
    mkdirSync(path.join(home, 'flow'));
    writeFileSync(
      fleetPolicyPath(home),
      JSON.stringify({ v: 1, accounts: { a: { role: 'main' } } })
    );
    const resolved = loadFleetPolicy(home, [{ id: 'a', routable: true }]);
    expect(resolved.mainId).toBe('a');
    expect(resolved.accounts[0].reservePct).toBe(50);
  });
});

describe('the usage ledger file', () => {
  // Purpose: the id becomes a file name, so anything that fails the id pattern
  // is refused before it reaches a path (no traversal).
  it('refuses an id that is not an account id', async () => {
    expect(() => ledgerPath(home, '../escape')).toThrow(/not a valid account id/);
    expect(readLedger(home, '../escape').warnings.map((w) => w.code)).toEqual([
      'account-id-invalid',
    ]);
    const result = await recordUsage(home, '../escape', [obs()], '2026-09-26T16:00:00.000Z');
    expect(result.status).toBe('dropped');
    expect(readdirSync(home)).toEqual([]);
  });

  // Purpose: a write lands at <dorkHome>/usage/<id>.json, folder 0700, file 0600,
  // and a replay of the same observation does not rewrite it.
  it('writes <dorkHome>/usage/<id>.json and skips a replay', async () => {
    const first = await recordUsage(home, 'claude3', [obs()], '2026-09-26T16:00:01.000Z');
    expect(first.status).toBe('written');
    const file = path.join(home, 'usage', 'claude3.json');
    expect(statSync(path.join(home, 'usage')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(file, 'utf8');
    const replay = await recordUsage(home, 'claude3', [obs()], '2026-09-26T16:00:02.000Z');
    expect(replay.status).toBe('unchanged');
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(readLedger(home, 'claude3').ledger?.updatedAt).toBe('2026-09-26T16:00:01.000Z');
  });

  // Purpose: dropped observations come back as warnings, never as a throw.
  it('returns merge warnings', async () => {
    const result = await recordUsage(
      home,
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
    mkdirSync(path.join(home, 'usage'));
    writeFileSync(path.join(home, 'usage', 'claude3.json'), 'garbage');
    expect(readLedger(home, 'claude3')).toMatchObject({
      ledger: null,
      warnings: [{ code: 'file-corrupt' }],
    });
    const result = await recordUsage(home, 'claude3', [obs()], '2026-09-26T16:00:01.000Z');
    expect(result.warnings.map((w) => w.code)).toEqual(['file-corrupt']);
    const names = readdirSync(path.join(home, 'usage')).sort();
    expect(names[0]).toBe('claude3.json');
    expect(names[1]).toMatch(/^claude3\.json\.corrupt-\d+$/);
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
