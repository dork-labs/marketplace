/**
 * `flow accounts` (spec `flow-cli-core` §6, §1.1; task 3.5): listing the
 * accounts with their resolved policy and room, registering one in DorkOS
 * config, and setting flow's routing policy in `fleet.json`.
 *
 * Every case runs `main(argv, deps)` against a temp `<dorkHome>` named by
 * `DORK_HOME`, so no real home folder is read or written.
 *
 * @see specs/flow-cli-core/02-specification.md §6 "flow accounts"
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../../scripts/flow.ts';

let base: string;
let dorkHome: string;
let configFile: string;
let fleetFile: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-accounts-')));
  dorkHome = path.join(base, 'dork');
  configFile = path.join(dorkHome, 'config.json');
  fleetFile = path.join(dorkHome, 'flow', 'fleet.json');
  mkdirSync(dorkHome, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A folder that exists, to register as an account. */
function accountDir(name: string): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function flow(argv: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome, HOME: base, ...env },
    cwd: base,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      throw new Error('flow accounts must never build a tracker adapter');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

function writeConfig(value: unknown, indent: string | number = '\t'): string {
  const text = `${JSON.stringify(value, null, indent)}\n`;
  writeFileSync(configFile, text);
  return text;
}

function writeFleet(value: unknown): void {
  mkdirSync(path.dirname(fleetFile), { recursive: true });
  writeFileSync(fleetFile, `${JSON.stringify(value, null, 2)}\n`);
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('flow accounts list', () => {
  it('lists an unlisted account as kept-out and warns that there is no main', async () => {
    // Purpose: opt-in by default (§1.1b). An account with no fleet.json entry is
    // never spent, and flow never guesses a main account (D7), it warns. The row
    // is in the default folder, so `default` is its alias (rev 6d), not a
    // separate account that would be main by default.
    writeConfig({
      runtimes: { claudeCode: { accounts: [{ id: 'work', path: path.join(base, '.claude') }] } },
    });
    const result = await flow(['accounts', '--json']);
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out.accounts[0]).toMatchObject({
      runtime: 'claude-code',
      key: 'claude-code:work',
      id: 'work',
      implicit: false,
      isDefault: true,
      role: 'kept-out',
      reservePct: 0,
      scope: { repos: [] },
      fiveHourRoom: null,
      weeklyRoom: null,
      room: null,
    });
    expect(out.handoff).toBe('auto');
    expect(out.warnings.map((w: { code: string }) => w.code)).toContain('no-main');
    expect(result.stderr).toContain('No Claude Code account is main');
  });

  it('joins the policy and the ledger: reserve, room and the fleet handoff', async () => {
    // Purpose: list shows each account's resolved policy and its room from the
    // usage ledger, read through readWindow (an expired window reads as 0%).
    writeConfig({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'mine', path: '/a/mine', label: 'Mine' },
            { id: 'spare', path: '/a/spare' },
          ],
        },
      },
    });
    writeFleet({
      v: 1,
      handoff: 'ask',
      accounts: { mine: { role: 'main' }, spare: { role: 'rotation' } },
    });
    mkdirSync(path.join(dorkHome, 'runtimes', 'claude-code', 'usage'), { recursive: true });
    const entry = (usedPct: number, resetsAt: string) => ({
      usedPct,
      resetsAt,
      status: null,
      observedAt: '2026-09-26T11:00:00.000Z',
      source: 'statusline',
    });
    writeFileSync(
      path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'mine.json'),
      JSON.stringify({
        v: 1,
        accountId: 'mine',
        updatedAt: '2026-09-26T11:00:00.000Z',
        windows: {
          five_hour: entry(20, '2026-09-26T15:00:00.000Z'),
          seven_day: entry(60, '2026-09-30T00:00:00.000Z'),
        },
      })
    );
    const result = await flow(['accounts', 'list', '--json']);
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out.handoff).toBe('ask');
    expect(out.mains).toEqual({ 'claude-code': 'mine' });
    const [mine, spare] = out.accounts;
    // main keeps 50% back, and 60% used leaves no weekly room for flow.
    expect(mine).toMatchObject({
      role: 'main',
      reservePct: 50,
      effectiveReservePct: 50,
      fiveHourRoom: true,
      weeklyRoom: false,
    });
    expect(mine.windows.seven_day.usedPct).toBe(60);
    expect(spare).toMatchObject({ role: 'rotation', fiveHourRoom: null, weeklyRoom: null });
    expect(out.warnings).toEqual([]);

    const text = await flow(['accounts']);
    expect(text.stdout).toMatch(/^ID\s+ROLE\s+RESERVE\s+5-HOUR\s+7-DAY\s+ROOM\s+LABEL\s+PATH$/m);
    expect(text.stdout).toMatch(
      /^mine\s+main\s+50%\s+20%\s+60% \(no room\)\s+no\s+Mine\s+\/a\/mine$/m
    );
    expect(text.stdout).toMatch(/^spare\s+rotation\s+0%\s+unknown\s+unknown\s+unknown/m);
    expect(text.stdout).toContain('Handoff: ask');
  });

  it('reads both files from DORK_HOME, not the home folder', async () => {
    // Purpose: DORK_HOME redirects config.json and fleet.json together (§1.1).
    const other = path.join(base, 'other-home');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      path.join(other, 'config.json'),
      JSON.stringify({ runtimes: { claudeCode: { accounts: [{ id: 'redirected', path: '/r' }] } } })
    );
    mkdirSync(path.join(other, 'flow'), { recursive: true });
    writeFileSync(
      path.join(other, 'flow', 'fleet.json'),
      JSON.stringify({ v: 1, accounts: { redirected: { role: 'rotation' } } })
    );
    writeConfig({ runtimes: { claudeCode: { accounts: [{ id: 'default-home', path: '/d' }] } } });
    const out = (await flow(['accounts', '--json'], { DORK_HOME: other })).json();
    expect(out.dorkHome).toBe(other);
    // This computer's own sign-in stands beside the registered row, as main (rev 6d).
    expect(out.accounts.map((a: { key: string; role: string }) => [a.key, a.role])).toEqual([
      ['claude-code:redirected', 'rotation'],
      ['claude-code:default', 'main'],
      ['codex:default', 'rotation'],
      ['opencode:default', 'rotation'],
    ]);
  });

  it('lists every runtime, each with its implicit default when nothing is registered', async () => {
    // Purpose: every runtime flow runs on has one account at least (spec
    // 1.1a). With no registry it is the environment's own sign-in, in rotation,
    // and the text groups accounts by runtime.
    const result = await flow(['accounts', '--json']);
    expect(
      result
        .json()
        .accounts.map((a: { key: string; role: string; path: null }) => [a.key, a.role, a.path])
    ).toEqual([
      // Claude Code and Codex name their default folders (rev 6d); OpenCode has none.
      ['claude-code:default', 'rotation', path.join(base, '.claude')],
      ['codex:default', 'rotation', path.join(base, '.codex')],
      ['opencode:default', 'rotation', null],
    ]);
    const text = (await flow(['accounts'])).stdout;
    for (const heading of ['Claude Code', 'Codex', 'OpenCode']) {
      expect(text).toMatch(new RegExp(`^${heading}$`, 'm'));
    }
    expect(text).toMatch(/^default\s+rotation\s+0%.*\(this environment\)$/m);
    // A local-model OpenCode account has nothing to run out of.
    expect(text).toMatch(/^default\s+rotation\s+0%\s+unknown\s+unknown\s+yes\s/m);
  });

  it('drops the policy of an account that is no longer registered, with a note', async () => {
    // Purpose: a removed account leaves no routing policy behind (R8). A dry
    // run only says what it would drop, and an unreadable registry drops
    // nothing, because then every account would look removed.
    writeConfig({ runtimes: { claudeCode: { accounts: [{ id: 'mine', path: '/a/mine' }] } } });
    writeFleet({
      v: 1,
      accounts: { gone: { role: 'rotation' }, 'claude-code:mine': { role: 'main' } },
    });
    const dry = await flow(['accounts', '--dry-run', '--json']);
    expect(dry.json().dropped).toEqual(['claude-code:gone']);
    expect(dry.stderr).toContain('Would drop the policy for "claude-code:gone"');
    expect(readJson(fleetFile).accounts.gone).toEqual({ role: 'rotation' });

    writeFileSync(configFile, '{oops');
    expect((await flow(['accounts', '--json'])).json().dropped).toEqual([]);
    expect(readJson(fleetFile).accounts.gone).toEqual({ role: 'rotation' });

    writeConfig({ runtimes: { claudeCode: { accounts: [{ id: 'mine', path: '/a/mine' }] } } });
    const real = await flow(['accounts', '--json']);
    expect(real.json().dropped).toEqual(['claude-code:gone']);
    expect(real.stderr).toContain('Dropped the policy for "claude-code:gone"');
    expect(real.json().warnings.map((w: { code: string }) => w.code)).not.toContain(
      'entry-unknown-id'
    );
    expect(readJson(fleetFile)).toEqual({
      v: 1,
      accounts: { 'claude-code:mine': { role: 'main' } },
    });
  });

  it('says so plainly when no account is registered', async () => {
    // Purpose: an empty registry is a normal state, not an error, and the text names the fix.
    const result = await flow(['accounts']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('flow accounts add --path');
  });
});

describe('flow accounts add', () => {
  it('appends one row with all four keys and keeps every other key byte-for-byte', async () => {
    // Purpose: flow writes into a file DorkOS owns. Every other section and every
    // unknown key must survive exactly, and the row must carry label and color as
    // null so DorkOS's schema (label nullable, no default) accepts it.
    const dir = accountDir('claude-work');
    const original = {
      __internal__: { migrated: true },
      version: '1.2.3',
      server: { port: 4242, weird: [1, 'two', { three: null }] },
      runtimes: {
        claudeCode: {
          defaultAccount: 'x',
          accounts: [{ id: 'first', path: '/a/first', label: 'First', color: null, extra: 7 }],
        },
        codex: { enabled: false },
      },
      unknownTopLevel: 'keep me',
    };
    writeConfig(original);
    const result = await flow(['accounts', 'add', '--path', dir, '--json']);
    expect(result.code).toBe(0);
    const written = readFileSync(configFile, 'utf8');
    const expected = structuredClone(original) as typeof original & Record<string, unknown>;
    (expected.runtimes.claudeCode.accounts as unknown[]).push({
      id: 'claude-work',
      path: dir,
      label: null,
      color: null,
    });
    expect(written).toBe(`${JSON.stringify(expected, null, '\t')}\n`);
    expect(result.json().account).toEqual({
      id: 'claude-work',
      path: dir,
      label: null,
      color: null,
    });
  });

  it('writes no policy, so the new account lists as kept-out', async () => {
    // Purpose: add never touches fleet.json (a new account starts kept out, D6).
    const dir = accountDir('fresh');
    expect((await flow(['accounts', 'add', '--path', dir, '--label', 'Spare Seat'])).code).toBe(0);
    expect(existsSync(fleetFile)).toBe(false);
    const out = (await flow(['accounts', '--json'])).json();
    expect(out.accounts[0]).toMatchObject({
      key: 'claude-code:spare-seat',
      label: 'Spare Seat',
      role: 'kept-out',
    });
  });

  it("creates a missing config.json with mode 0600 and keeps an existing file's mode", async () => {
    // Purpose: config.json can hold secrets; a new one is private, and an
    // existing one keeps whatever mode its owner gave it.
    const first = accountDir('one');
    await flow(['accounts', 'add', '--path', first]);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(readJson(configFile)).toEqual({
      runtimes: {
        claudeCode: { accounts: [{ id: 'one', path: first, label: null, color: null }] },
      },
    });
    chmodSync(configFile, 0o640);
    await flow(['accounts', 'add', '--path', accountDir('two')]);
    expect(statSync(configFile).mode & 0o777).toBe(0o640);
  });

  it('prints the DorkOS note only when the file carries __internal__', async () => {
    // Purpose: DorkOS-managed config gets a pointer to DorkOS settings, and the write still happens (D12).
    writeConfig({ __internal__: {} });
    const managed = await flow(['accounts', 'add', '--path', accountDir('m')]);
    expect(managed.code).toBe(0);
    expect(managed.stdout).toContain(
      'DorkOS manages this file; you can also add accounts in its settings'
    );
    expect(readJson(configFile).runtimes.claudeCode.accounts).toHaveLength(1);

    writeConfig({ server: {} });
    const plain = await flow(['accounts', 'add', '--path', accountDir('p')]);
    expect(plain.stdout).not.toContain('DorkOS manages');
  });

  it('expands ~, mints a free id, and refuses a path already registered (exit 5)', async () => {
    // Purpose: ids never collide, and one folder is never two accounts.
    const dir = accountDir('seat');
    writeConfig({ runtimes: { claudeCode: { accounts: [{ id: 'seat', path: '/elsewhere' }] } } });
    const added = await flow(['accounts', 'add', '--path', '~/seat', '--json']);
    expect(added.code).toBe(0);
    expect(added.json().account).toMatchObject({ id: 'seat-2', path: dir });
    const again = await flow(['accounts', 'add', '--path', `${dir}/`]);
    expect(again.code).toBe(5);
    expect(again.stderr).toContain('already registered as "seat-2"');
  });

  it('refuses a relative path (exit 2), a missing folder (exit 5) and a bad color (exit 2)', async () => {
    // Purpose: add only registers a real, absolute CLAUDE_CONFIG_DIR.
    expect((await flow(['accounts', 'add', '--path', 'relative/dir'])).code).toBe(2);
    expect((await flow(['accounts', 'add', '--path', path.join(base, 'nope')])).code).toBe(5);
    expect(
      (await flow(['accounts', 'add', '--path', accountDir('c'), '--color', 'red'])).code
    ).toBe(2);
    expect(existsSync(configFile)).toBe(false);
  });

  it('--dry-run prints the row and writes nothing', async () => {
    // Purpose: the common --dry-run contract.
    const result = await flow([
      'accounts',
      'add',
      '--path',
      accountDir('dry'),
      '--dry-run',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.json()).toMatchObject({ dryRun: true, account: { id: 'dry' } });
    expect(existsSync(configFile)).toBe(false);
  });

  it('refuses a config.json it cannot parse and leaves it alone (exit 3)', async () => {
    // Purpose: never replace a file flow could not read; that would erase DorkOS's settings.
    writeFileSync(configFile, '{ not json');
    const result = await flow(['accounts', 'add', '--path', accountDir('x')]);
    expect(result.code).toBe(3);
    expect(readFileSync(configFile, 'utf8')).toBe('{ not json');
  });
});

describe('flow accounts set', () => {
  beforeEach(() => {
    writeConfig({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'mine', path: '/a/mine' },
            { id: 'spare', path: '/a/spare' },
          ],
        },
      },
    });
  });

  it('writes only what was set to fleet.json and never touches config.json', async () => {
    // Purpose: writers store only the operator's choices (defaults resolve at
    // read time), and policy never goes into DorkOS config (D6).
    const before = readFileSync(configFile, 'utf8');
    const result = await flow([
      'accounts',
      'set',
      'spare',
      '--role',
      'kept-out',
      '--repos',
      'acme/app, acme/api',
    ]);
    expect(result.code).toBe(0);
    expect(readJson(fleetFile)).toEqual({
      v: 1,
      accounts: {
        'claude-code:spare': { role: 'kept-out', scope: { repos: ['acme/app', 'acme/api'] } },
      },
    });
    expect(readFileSync(configFile, 'utf8')).toBe(before);

    await flow(['accounts', 'set', 'claude-code:mine', '--role', 'main']);
    // No reservePct or spendDownWindowHours written: main's 50% is a read-time default.
    expect(readJson(fleetFile).accounts['claude-code:mine']).toEqual({ role: 'main' });
  });

  it('"default" deletes a field, and "none" stores an empty repo list', async () => {
    // Purpose: every policy flag can return to its default without hand-editing.
    writeFleet({
      v: 1,
      custom: 'kept',
      accounts: { spare: { role: 'rotation', reservePct: 10, spendDownWindowHours: 6, note: 'x' } },
    });
    await flow([
      'accounts',
      'set',
      'spare',
      '--reserve',
      'default',
      '--spend-down-hours',
      '12',
      '--repos',
      'none',
    ]);
    // The bare key written before contract 2.0.0 is stored in its new form.
    expect(readJson(fleetFile)).toEqual({
      v: 1,
      custom: 'kept',
      accounts: {
        'claude-code:spare': {
          role: 'rotation',
          spendDownWindowHours: 12,
          note: 'x',
          scope: { repos: [] },
        },
      },
    });
  });

  it('refuses an unregistered id and a second main, naming the current one (exit 5)', async () => {
    // Purpose: at most one main, and no policy for an account DorkOS does not know.
    const unknown = await flow(['accounts', 'set', 'ghost', '--role', 'rotation']);
    expect(unknown.code).toBe(5);
    expect(existsSync(fleetFile)).toBe(false);

    await flow(['accounts', 'set', 'mine', '--role', 'main']);
    const second = await flow(['accounts', 'set', 'spare', '--role', 'main']);
    expect(second.code).toBe(5);
    expect(second.stderr).toContain('"claude-code:mine" is already the main Claude Code account');
    expect(readJson(fleetFile).accounts['claude-code:spare']).toBeUndefined();
    // One main per runtime: Codex's implicit default may be main too.
    expect((await flow(['accounts', 'set', 'codex:default', '--role', 'main'])).code).toBe(0);
    expect((await flow(['accounts', 'set', 'gemini:x', '--role', 'main'])).code).toBe(2);
  });

  it('set with no id takes only the fleet-wide settings, one at a time', async () => {
    // Purpose: the fleet-wide switches are separate from per-account policy.
    expect((await flow(['accounts', 'set', '--handoff', 'ask'])).code).toBe(0);
    expect(readJson(fleetFile)).toEqual({ v: 1, handoff: 'ask' });
    expect((await flow(['accounts', 'set', '--role', 'main'])).code).toBe(2);
    expect((await flow(['accounts', 'set', 'mine', '--handoff', 'ask'])).code).toBe(2);
    expect((await flow(['accounts', 'set', '--handoff', 'default'])).code).toBe(0);
    expect(readJson(fleetFile)).toEqual({ v: 1 });
  });

  it('sets the runtime preference and cross-runtime fallback', async () => {
    // Purpose: the two runtime settings (spec 1.1b) are stored as written,
    // "default" clears them, and a value outside the contract is a usage error.
    expect((await flow(['accounts', 'set', '--runtimes', 'codex, claude-code'])).code).toBe(0);
    expect((await flow(['accounts', 'set', '--cross-runtime-fallback', 'on'])).code).toBe(0);
    expect(readJson(fleetFile)).toEqual({
      v: 1,
      runtimes: ['codex', 'claude-code'],
      crossRuntimeFallback: 'on',
    });
    const out = (await flow(['accounts', '--json'])).json();
    expect(out).toMatchObject({ runtimes: ['codex', 'claude-code'], crossRuntimeFallback: 'on' });
    for (const bad of [
      ['--runtimes', 'codex,codex'],
      ['--runtimes', 'gemini'],
      ['--cross-runtime-fallback', 'maybe'],
      ['--handoff', 'ask', '--runtimes', 'codex'],
    ]) {
      expect((await flow(['accounts', 'set', ...bad])).code, bad.join(' ')).toBe(2);
    }
    expect((await flow(['accounts', 'set', '--runtimes', 'default'])).code).toBe(0);
    expect(readJson(fleetFile)).toEqual({ v: 1, crossRuntimeFallback: 'on' });
  });

  it('rejects out-of-range values (exit 2) and --dry-run writes nothing', async () => {
    // Purpose: bad input never reaches the file; a dry run shows the change only.
    expect((await flow(['accounts', 'set', 'spare', '--reserve', '120'])).code).toBe(2);
    expect((await flow(['accounts', 'set', 'spare', '--spend-down-hours', 'soon'])).code).toBe(2);
    const dry = await flow([
      'accounts',
      'set',
      'spare',
      '--role',
      'rotation',
      '--dry-run',
      '--json',
    ]);
    expect(dry.code).toBe(0);
    expect(dry.json()).toMatchObject({
      dryRun: true,
      changed: true,
      before: null,
      after: { role: 'rotation' },
    });
    expect(existsSync(fleetFile)).toBe(false);
  });
});

it('never builds a tracker adapter or reads project config', async () => {
  // Purpose: accounts runs anywhere, even outside a flow project (spec §6).
  // The deps' createAdapter throws; a call to it would surface as exit 70.
  expect((await flow(['accounts'])).code).toBe(0);
});

describe('the default account (rev 6d)', () => {
  /** The operator's shape: defaultAccount null, one registered row outside ~/.claude. */
  const operator = () =>
    writeConfig({
      runtimes: {
        claudeCode: {
          defaultAccount: null,
          accounts: [{ id: 'claude3', path: path.join(base, '.claude3'), label: 'Claude3' }],
        },
      },
    });
  /** The same row, but DorkOS's default names its folder, so default is its alias. */
  const aliased = () =>
    writeConfig({
      runtimes: {
        claudeCode: {
          defaultAccount: '~/.claude3/',
          accounts: [{ id: 'claude3', path: path.join(base, '.claude3'), label: 'Claude3' }],
        },
      },
    });
  /** The listed rows of one runtime. */
  const claudeRows = (out: { accounts: { runtime: string }[] }) =>
    out.accounts.filter((row) => row.runtime === 'claude-code') as Record<string, unknown>[];

  it("lists this computer's own sign-in as its own main account when no row names it", async () => {
    // Purpose: the gap found in the operator's real config. Without this rule
    // the main account in ~/.claude was invisible; beside rotation accounts it
    // is the operator's own, so it defaults to main with a 50% reserve.
    operator();
    const out = (await flow(['accounts', '--json'])).json();
    const claude = claudeRows(out);
    expect(claude.map((row) => row.id)).toEqual(['claude3', 'default']);
    expect(claude[1]).toMatchObject({
      implicit: true,
      isDefault: true,
      label: "Main (this computer's sign-in)",
      path: path.join(base, '.claude'),
      role: 'main',
      reservePct: 50,
    });
    expect(out.mains).toEqual({ 'claude-code': 'default' });
    expect(out.warnings.map((w: { code: string }) => w.code)).not.toContain('no-main');

    // An explicit main elsewhere wins; default then falls back to rotation.
    expect((await flow(['accounts', 'set', 'claude3', '--role', 'main'])).code).toBe(0);
    const after = (await flow(['accounts', '--json'])).json();
    expect(after.mains).toEqual({ 'claude-code': 'claude3' });
    expect(claudeRows(after)[1]).toMatchObject({ id: 'default', role: 'rotation', reservePct: 0 });
  });

  it('shows an alias once, as "Claude3 (default)", with no separate default row', async () => {
    // Purpose: one real account, one row: the registered id carries the default mark.
    aliased();
    const out = (await flow(['accounts', '--json'])).json();
    expect(claudeRows(out).map((row) => [row.id, row.isDefault])).toEqual([['claude3', true]]);
    const text = (await flow(['accounts'])).stdout;
    expect(text).toMatch(/^claude3\s+kept-out\s.*Claude3 \(default\)\s/m);
  });

  it('stores a policy for default under the id it aliases, folding any old default entry in', async () => {
    // Purpose: one fleet.json policy per real account. `set default` on an
    // alias writes claude-code:claude3, and an entry stored under
    // claude-code:default reads as claude3's until that write moves it.
    aliased();
    writeFleet({ v: 1, accounts: { 'claude-code:default': { reservePct: 20 } } });
    const listed = (await flow(['accounts', '--json'])).json();
    expect(listed.dropped).toEqual([]);
    expect(claudeRows(listed)[0]).toMatchObject({ id: 'claude3', reservePct: 20 });

    const set = await flow(['accounts', 'set', 'default', '--role', 'rotation']);
    expect(set.code, set.stderr).toBe(0);
    expect(readJson(fleetFile)).toEqual({
      v: 1,
      accounts: { 'claude-code:claude3': { reservePct: 20, role: 'rotation' } },
    });
  });

  it('stores a policy for a default that stands alone under default', async () => {
    // Purpose: the standalone default is its own account with its own key.
    operator();
    expect((await flow(['accounts', 'set', 'default', '--role', 'kept-out'])).code).toBe(0);
    expect(readJson(fleetFile).accounts).toEqual({ 'claude-code:default': { role: 'kept-out' } });
  });
});
