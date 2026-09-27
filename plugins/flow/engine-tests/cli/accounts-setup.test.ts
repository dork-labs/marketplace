/**
 * `flow accounts setup` and the folder detection behind it (spec
 * `flow-cli-core` Amendment "account setup", S1).
 *
 * Every case builds fake account folders in a temp OS home and runs
 * `main(argv, deps)` with `HOME` and the injected OS home both pointing there,
 * so no real account folder is ever read, listed or written. The first test
 * holds that line.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAccounts } from '../../scripts/fleet/accounts.ts';
import { detectAccountFolders } from '../../scripts/fleet/detect-accounts.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const FLOW_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FLEET_SCHEMA = path.join(FLOW_ROOT, 'conformance', 'fleet', 'fleet-policy.schema.json');

let base: string;
let home: string;
let dorkHome: string;

/** Make a folder (and its parents) under the temp home. */
function dir(...parts: string[]): string {
  const full = path.join(home, ...parts);
  mkdirSync(full, { recursive: true });
  return full;
}

/**
 * The fixture most cases use: the default `~/.claude`, two personal folders
 * (`.claude-2` with projects/, `.claude3` with sessions/), an org-managed
 * `.claude-work`, a `.claude-empty` with neither subfolder, and a
 * `.claude.json` file that is not a folder at all.
 */
function fleetHome(): void {
  dir('.claude');
  dir('.claude-2', 'projects');
  dir('.claude3', 'sessions');
  dir('.claude-work', 'projects');
  writeFileSync(path.join(home, '.claude-work', 'remote-settings.json'), '{}');
  dir('.claude-empty');
  writeFileSync(path.join(home, '.claude.json'), '{}');
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-setup-')));
  home = path.join(base, 'home');
  dorkHome = path.join(home, '.dork');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A scripted terminal: each question takes the next answer. */
function terminal(answers: string[]) {
  const asked: string[] = [];
  return {
    asked,
    stdin: {
      isTTY: true,
      read: async () => '',
      readLine: async () => (answers.length === 0 ? null : (answers.shift() as string)),
    },
  };
}

async function flow(
  argv: string[],
  opts: { stdin?: ReturnType<typeof terminal>['stdin']; env?: Record<string, string> } = {}
) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: { HOME: home, ...opts.env },
    cwd: base,
    now: () => new Date('2026-09-27T12:00:00.000Z'),
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      throw new Error('flow accounts setup must never build a tracker adapter');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: FLOW_ROOT,
    io: {
      osHome: home,
      stdin: opts.stdin ?? { isTTY: false, read: async () => '' },
    },
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

const configFile = () => path.join(dorkHome, 'config.json');
const fleetFile = () => path.join(dorkHome, 'flow', 'fleet.json');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** The fleet.json a run wrote must be what the contract lets a writer store. */
function expectValidFleet(): void {
  const ajv = new (Ajv as unknown as typeof import('ajv').default)({
    strict: true,
    allErrors: true,
  });
  const validate = ajv.compile(JSON.parse(readFileSync(FLEET_SCHEMA, 'utf8')) as object);
  expect(validate(readJson(fleetFile())), JSON.stringify(validate.errors)).toBe(true);
}

describe('test isolation', () => {
  it('never uses the real home folder', () => {
    // Purpose: every case here runs in a temp home, never the operator's own.
    expect(home.startsWith(realpathSync(os.tmpdir()))).toBe(true);
    expect(home).not.toBe(os.homedir());
    expect(path.relative(os.homedir(), home).startsWith('..')).toBe(true);
  });
});

describe('detectAccountFolders', () => {
  it('finds ~/.claude, ~/.claude* with sessions/ or projects/, and CLAUDE_CONFIG_DIR; ignores the rest', () => {
    fleetHome();
    const outside = path.join(base, 'elsewhere', 'claude-x');
    mkdirSync(outside, { recursive: true });
    const accounts = loadAccounts(dorkHome, { home }).accounts;
    const found = detectAccountFolders({
      home,
      env: { CLAUDE_CONFIG_DIR: outside },
      config: undefined,
      accounts,
    }).filter((c) => c.runtime === 'claude-code');
    expect(found.map((c) => path.basename(c.path))).toEqual([
      '.claude',
      '.claude-2',
      '.claude-work',
      '.claude3',
      'claude-x',
    ]);
    expect(found[0]).toMatchObject({ isDefault: true, sources: ['default', 'home'] });
    expect(found.find((c) => c.path === outside)?.sources).toEqual(['env']);
    // The org-managed folder is marked, with a reason; the personal ones are not.
    const work = found.find((c) => c.path.endsWith('.claude-work'));
    expect(work?.orgMarker).toMatchObject({ file: 'remote-settings.json' });
    expect(work?.orgMarker?.reason).toMatch(/organization manages/);
    expect(found.find((c) => c.path.endsWith('.claude-2'))?.orgMarker).toBeNull();
  });

  it('marks policy-limits.json as org-managed too', () => {
    dir('.claude-client', 'sessions');
    writeFileSync(path.join(home, '.claude-client', 'policy-limits.json'), '{}');
    const found = detectAccountFolders({ home, env: {}, config: undefined, accounts: [] });
    expect(found.find((c) => c.path.endsWith('.claude-client'))?.orgMarker?.file).toBe(
      'policy-limits.json'
    );
  });

  it('merges a symlink with its target, and a registered folder with the one found', () => {
    fleetHome();
    symlinkSync(path.join(home, '.claude-2'), path.join(home, '.claude-link'));
    mkdirSync(dorkHome, { recursive: true });
    writeFileSync(
      configFile(),
      JSON.stringify({
        runtimes: {
          claudeCode: { accounts: [{ id: 'three', path: path.join(home, '.claude3') }] },
        },
      })
    );
    const accounts = loadAccounts(dorkHome, { home }).accounts;
    const found = detectAccountFolders({ home, env: {}, config: undefined, accounts }).filter(
      (c) => c.runtime === 'claude-code'
    );
    expect(found.filter((c) => c.canonicalPath.endsWith('.claude-2'))).toHaveLength(1);
    const three = found.find((c) => c.path.endsWith('.claude3'));
    expect(three?.sources).toEqual(['glob', 'registered']);
    expect(three?.account?.id).toBe('three');
  });

  it('finds Codex (~/.codex, CODEX_HOME) and the OpenCode data folder', () => {
    dir('.codex');
    const codexHome = path.join(base, 'codex-2');
    mkdirSync(codexHome);
    const xdg = path.join(base, 'xdg');
    mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
    const found = detectAccountFolders({
      home,
      env: { CODEX_HOME: codexHome, XDG_DATA_HOME: xdg },
      config: undefined,
      accounts: loadAccounts(dorkHome, { home }).accounts,
    });
    expect(found.map((c) => [c.runtime, c.path, c.isDefault])).toEqual([
      ['codex', path.join(home, '.codex'), true],
      ['codex', codexHome, false],
      ['opencode', path.join(xdg, 'opencode'), true],
    ]);
  });

  it('finds nothing in an empty home', () => {
    expect(detectAccountFolders({ home, env: {}, config: undefined, accounts: [] })).toEqual([]);
  });
});

describe('flow accounts setup: the proposal', () => {
  it('proposes main for the default, rotation for the rest, kept out for the org-managed one; writes nothing without --yes', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup', '--json']);
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out).toMatchObject({ mode: 'propose', applied: false });
    const proposed = Object.fromEntries(
      out.candidates
        .filter((c: { runtime: string }) => c.runtime === 'claude-code')
        .map((c: { path: string; proposedRole: string }) => [path.basename(c.path), c.proposedRole])
    );
    expect(proposed).toEqual({
      '.claude': 'main',
      '.claude-2': 'rotation',
      '.claude3': 'rotation',
      '.claude-work': 'kept-out',
    });
    const work = out.candidates.find((c: { path: string }) => c.path.endsWith('.claude-work'));
    expect(work.orgManaged.reason).toMatch(/remote-settings\.json/);
    expect(out.plan.map((w: { command: string }) => w.command)).toEqual([
      `flow accounts add --path ${path.join(home, '.claude-2')}`,
      `flow accounts add --path ${path.join(home, '.claude3')}`,
      'flow accounts set claude-code:claude-2 --role rotation',
      'flow accounts set claude-code:claude3 --role rotation',
      'flow accounts set claude-code:default --role main',
    ]);
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(fleetFile())).toBe(false);
  });

  it('in human mode, shows the folders, the reason, the plan and the --yes command to run', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('~/.claude-work');
    expect(result.stdout).toContain('looks org-managed');
    expect(result.stdout).toContain('Changes (5):');
    expect(result.stdout).toContain(
      'flow accounts setup --yes --rotation ~/.claude-2,~/.claude3 --keep-out ~/.claude-work'
    );
    expect(existsSync(configFile())).toBe(false);
  });

  it('shows the latest usage from the ledger when there is one', async () => {
    fleetHome();
    const ledger = path.join(dorkHome, 'runtimes', 'claude-code', 'usage');
    mkdirSync(ledger, { recursive: true });
    writeFileSync(
      path.join(ledger, 'default.json'),
      JSON.stringify({
        v: 1,
        account: 'default',
        runtime: 'claude-code',
        windows: {
          five_hour: {
            usedPct: 42,
            status: null,
            resetsAt: '2026-09-27T14:00:00.000Z',
            observedAt: '2026-09-27T11:00:00.000Z',
            source: 'statusline',
          },
        },
      })
    );
    const out = (await flow(['accounts', 'setup', '--json'])).json();
    const main = out.candidates.find((c: { isDefault: boolean }) => c.isDefault);
    expect(main.usage.fiveHour).toBe(42);
    expect(main.usage.sevenDay).toBeNull();
  });

  it('offers nothing when this computer has one account folder', async () => {
    dir('.claude');
    const out = (await flow(['accounts', 'setup', '--json'])).json();
    expect(out.plan).toEqual([]);
    expect(out.candidates).toHaveLength(1);
  });
});

describe('flow accounts setup: in a terminal', () => {
  it('asks, prints every change before the last question, and writes only after yes', async () => {
    fleetHome();
    // main? (yes) · .claude-2 work? (no) · .claude-work work? (default: yes) ·
    // .claude3 work? (yes) · status lines for .claude and .claude-2 (no, no) · make them? (y)
    const term = terminal(['', 'n', '', 'y', '', '', 'y']);
    const result = await flow(['accounts', 'setup'], { stdin: term.stdin });
    expect(result.code).toBe(0);
    const err = result.stderr;
    expect(err).toContain('Keep ~/.claude as your main Claude Code account');
    expect(err).toContain('~/.claude-work looks org-managed');
    expect(err).toMatch(/Is ~\/\.claude-work a work, organization or client account\? .* \[Y\/n\]/);
    expect(err).toMatch(/Is ~\/\.claude-2 a work, organization or client account\? .* \[y\/N\]/);
    // Every change is on screen before the confirmation.
    expect(err.indexOf('Changes (3):')).toBeGreaterThan(-1);
    expect(err.indexOf('Changes (3):')).toBeLessThan(err.indexOf('Make these 3 changes?'));

    const config = readJson(configFile());
    expect(config.runtimes.claudeCode.accounts).toEqual([
      { id: 'claude-2', path: path.join(home, '.claude-2'), label: null, color: null },
    ]);
    expect(readJson(fleetFile()).accounts).toEqual({
      'claude-code:claude-2': { role: 'rotation' },
      'claude-code:default': { role: 'main' },
    });
    expectValidFleet();
    expect(result.stdout).toContain('Made 3 changes.');
  });

  it('writes nothing when the last answer is no', async () => {
    fleetHome();
    const term = terminal(['', 'n', '', 'n', '', '', '', 'n']);
    const result = await flow(['accounts', 'setup'], { stdin: term.stdin });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nothing changed.');
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(fleetFile())).toBe(false);
  });

  it('writes nothing when input ends before the confirmation', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup'], { stdin: terminal(['', 'n']).stdin });
    expect(result.code).toBe(0);
    expect(existsSync(configFile())).toBe(false);
  });

  it('with --dry-run, asks but never writes', async () => {
    fleetHome();
    const term = terminal(['', 'n', '', 'n', '', '', '']);
    const result = await flow(['accounts', 'setup', '--dry-run'], { stdin: term.stdin });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('Make these');
    expect(result.stdout).toContain('Dry run: nothing changed.');
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(fleetFile())).toBe(false);
  });
});

describe('flow accounts setup --yes', () => {
  it('--rotation all spends every personal folder, keeps the org-managed one out and unregistered', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup', '--yes', '--rotation', 'all', '--json']);
    expect(result.code).toBe(0);
    const out = result.json();
    expect(out).toMatchObject({ mode: 'yes', applied: true });
    const ids = readJson(configFile()).runtimes.claudeCode.accounts.map(
      (row: { id: string }) => row.id
    );
    expect(ids).toEqual(['claude-2', 'claude3']);
    expect(readJson(fleetFile()).accounts).toEqual({
      'claude-code:claude-2': { role: 'rotation' },
      'claude-code:claude3': { role: 'rotation' },
      'claude-code:default': { role: 'main' },
    });
    expectValidFleet();
    // flow accounts agrees: the new ones are rotation, the default main.
    const listed = (await flow(['accounts', '--json'])).json();
    const roles = Object.fromEntries(
      listed.accounts
        .filter((a: { runtime: string }) => a.runtime === 'claude-code')
        .map((a: { id: string; role: string }) => [a.id, a.role])
    );
    expect(roles).toEqual({ 'claude-2': 'rotation', claude3: 'rotation', default: 'main' });
  });

  it('prints the planned writes in human mode too', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup', '--yes', '--rotation', 'all']);
    expect(result.stdout).toContain('Changes (5):');
    expect(result.stdout).toContain('(flow accounts set claude-code:default --role main)');
    expect(result.stdout).toContain('Made 5 changes.');
  });

  it('never puts an account in rotation unless a flag names it', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup', '--yes', '--json']);
    expect(result.code).toBe(0);
    expect(existsSync(configFile())).toBe(false);
    expect(readJson(fleetFile()).accounts).toEqual({ 'claude-code:default': { role: 'main' } });
  });

  it('--keep-out wins over --rotation all; --main picks another main by folder name', async () => {
    fleetHome();
    const result = await flow([
      'accounts',
      'setup',
      '--yes',
      '--rotation',
      'all',
      '--keep-out',
      '.claude3',
      '--main',
      '~/.claude-2',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(readJson(fleetFile()).accounts).toEqual({
      'claude-code:claude-2': { role: 'main' },
      'claude-code:default': { role: 'rotation' },
    });
    expect(readJson(configFile()).runtimes.claudeCode.accounts).toHaveLength(1);
    expectValidFleet();
  });

  it('an org-managed folder goes to rotation only when named', async () => {
    fleetHome();
    await flow(['accounts', 'setup', '--yes', '--rotation', '.claude-work', '--json']);
    expect(readJson(fleetFile()).accounts['claude-code:claude-work']).toEqual({
      role: 'rotation',
    });
  });

  it('refuses a ref that names no folder found (exit 2)', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup', '--yes', '--rotation', 'nope']);
    expect(result.code).toBe(2);
    expect(existsSync(fleetFile())).toBe(false);
  });

  it('is a no-op the second time', async () => {
    fleetHome();
    await flow(['accounts', 'setup', '--yes', '--rotation', 'all']);
    const again = (
      await flow(['accounts', 'setup', '--yes', '--rotation', 'all', '--json'])
    ).json();
    expect(again.plan).toEqual([]);
  });

  it('--statusline adds the recorder to each spent account, through the install-statusline writer', async () => {
    fleetHome();
    const script = path.join(home, '.claude-2', 'statusline.sh');
    writeFileSync(script, '#!/bin/bash\ninput=$(cat)\necho "$input"\n');
    chmodSync(script, 0o755);
    writeFileSync(
      path.join(home, '.claude-2', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: `bash ${script}` } })
    );
    const out = (
      await flow([
        'accounts',
        'setup',
        '--yes',
        '--rotation',
        '.claude-2',
        '--statusline',
        '--json',
      ])
    ).json();
    expect(out.plan.map((w: { kind: string }) => w.kind)).toEqual([
      'add',
      'set',
      'set',
      'statusline',
    ]);
    expect(readFileSync(script, 'utf8')).toContain('# flow usage recorder');
    // ~/.claude has no status line: said, not guessed.
    expect(out.notes.join('\n')).toMatch(/~\/\.claude: add the usage recorder by hand/);
  });
});

describe('flow accounts setup --dry-run', () => {
  it('with --yes, prints the plan and writes nothing', async () => {
    fleetHome();
    const result = await flow(['accounts', 'setup', '--yes', '--rotation', 'all', '--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Changes (5):');
    expect(result.stdout).toContain('Dry run: nothing changed.');
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(fleetFile())).toBe(false);
  });
});

describe('flow accounts setup: flags', () => {
  it('the setup flags belong to setup only, and setup refuses the others', async () => {
    fleetHome();
    expect((await flow(['accounts', 'list', '--yes'])).code).toBe(2);
    expect((await flow(['accounts', 'setup', '--role', 'main'])).code).toBe(2);
  });
});
