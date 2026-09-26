/**
 * The default-account rule (spec `flow-cli-core` §1.1a, rev 6d): an account is
 * its folder, not its id. `<runtime>:default` names the runtime's default folder,
 * and is an alias of the registered row in that folder when there is one.
 *
 * The pure rules are pinned by the shared fixture (`accounts.cases.json`,
 * `fleet-policy.cases.json`) with injected real paths. These cases run the same
 * resolver against a real temp folder, so the filesystem's own real paths,
 * symlinks and missing folders are covered too, plus the policy writers that
 * fold an alias's entry into its row.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ACCOUNT_LABEL,
  accountForPath,
  ambientAccountPath,
  canonicalAccountPath,
  resolveAccountRef,
  resolveAccounts,
  setAccountPolicy,
  unknownPolicyKeys,
  type RuntimeAccount,
} from '../../scripts/fleet/accounts.ts';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), 'flow-default-account-')));
  mkdirSync(path.join(home, '.claude'));
  mkdirSync(path.join(home, '.claude3'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A config with these Claude Code rows and, when given, DorkOS's defaultAccount. */
function claudeConfig(
  rows: { id: string; path: string; label?: string }[],
  defaultAccount?: string | null
): unknown {
  return {
    runtimes: {
      claudeCode: { ...(defaultAccount === undefined ? {} : { defaultAccount }), accounts: rows },
    },
  };
}

/** Claude Code's resolved accounts for this config and environment. */
function claude(config: unknown, env: Record<string, string> = {}): RuntimeAccount[] {
  return resolveAccounts('claude-code', { config, env, home }).accounts;
}

describe('canonicalAccountPath', () => {
  it('reads ~ and the absolute path as one folder', () => {
    // Purpose: DorkOS may store `~/.claude3` and a row the absolute path.
    expect(canonicalAccountPath('~/.claude3', home)).toBe(path.join(home, '.claude3'));
    expect(canonicalAccountPath('~', home)).toBe(home);
  });

  it('drops trailing slashes', () => {
    // Purpose: hand-written config often ends a folder with `/`.
    expect(canonicalAccountPath(`${home}/.claude3//`, home)).toBe(path.join(home, '.claude3'));
  });

  it('resolves a symlink to its target', () => {
    // Purpose: a row may name the link and the default the real folder, or the reverse.
    const link = path.join(home, 'link-to-claude');
    symlinkSync(path.join(home, '.claude'), link);
    expect(canonicalAccountPath(link, home)).toBe(path.join(home, '.claude'));
  });

  it('normalizes a folder that does not exist without resolving it', () => {
    // Purpose: a default folder not created yet must still compare, as written.
    expect(canonicalAccountPath(`${home}/nope/../.fresh/`, home)).toBe(path.join(home, '.fresh'));
  });
});

describe('resolveAccounts', () => {
  it("makes this computer's sign-in its own account beside rows elsewhere (the operator's case)", () => {
    // Purpose: DorkOS defaultAccount null, CLAUDE_CONFIG_DIR unset, one row in
    // ~/.claude3: `default` is ~/.claude, its own account, never invisible.
    const accounts = claude(
      claudeConfig([{ id: 'claude3', path: path.join(home, '.claude3') }], null)
    );
    expect(accounts.map((a) => [a.id, a.isDefault, a.implicit, a.ledgerId])).toEqual([
      ['claude3', false, false, 'claude3'],
      ['default', true, true, 'default'],
    ]);
    expect(accounts[1]).toMatchObject({
      path: path.join(home, '.claude'),
      label: DEFAULT_ACCOUNT_LABEL,
    });
  });

  it('makes default an alias of the row in its folder, through ~, a trailing slash or a symlink', () => {
    // Purpose: one real account never gets two ids, whichever way the folder is written.
    const link = path.join(home, 'main-link');
    symlinkSync(path.join(home, '.claude'), link);
    for (const [rowPath, defaultAccount] of [
      [`${home}/.claude3/`, '~/.claude3'],
      [link, null],
      [path.join(home, '.claude'), `${home}/.claude/`],
    ] as const) {
      const accounts = claude(claudeConfig([{ id: 'mine', path: rowPath }], defaultAccount));
      expect(accounts.map((a) => [a.id, a.isDefault])).toEqual([['mine', true]]);
    }
  });

  it('takes defaultAccount over CLAUDE_CONFIG_DIR, and CLAUDE_CONFIG_DIR over ~/.claude', () => {
    // Purpose: the precedence DorkOS applies when it launches a session.
    const rows = [{ id: 'claude3', path: path.join(home, '.claude3') }];
    const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude3') };
    expect(claude(claudeConfig(rows, null), env).map((a) => a.id)).toEqual(['claude3']);
    const chosen = claude(claudeConfig(rows, path.join(home, 'work')), env);
    expect(chosen.map((a) => [a.id, a.path])).toEqual([
      ['claude3', path.join(home, '.claude3')],
      ['default', path.join(home, 'work')],
    ]);
  });

  it('gives Codex a default in CODEX_HOME, else ~/.codex, and OpenCode none beside rows', () => {
    // Purpose: rule 1 for Codex; OpenCode keeps its ambient default only with no row.
    const config = {
      runtimes: {
        codex: { accounts: [{ id: 'team', path: path.join(home, '.codex-team') }] },
        opencode: { accounts: [{ id: 'router', path: path.join(home, 'oc') }] },
      },
    };
    const codex = (env: Record<string, string>) =>
      resolveAccounts('codex', { config, env, home }).accounts.map((a) => [a.id, a.path]);
    expect(codex({})).toEqual([
      ['team', path.join(home, '.codex-team')],
      ['default', path.join(home, '.codex')],
    ]);
    expect(codex({ CODEX_HOME: path.join(home, '.codex-team') })).toEqual([
      ['team', path.join(home, '.codex-team')],
    ]);
    const opencode = resolveAccounts('opencode', { config, env: {}, home }).accounts;
    expect(opencode.map((a) => [a.id, a.isDefault])).toEqual([['router', false]]);
  });
});

describe('resolveAccountRef and accountForPath', () => {
  it('resolves default to the row it aliases, and a folder to its account', () => {
    // Purpose: every verb that takes an id or a session folder names one file.
    const accounts = claude(claudeConfig([{ id: 'mine', path: path.join(home, '.claude') }]));
    expect(resolveAccountRef(accounts, 'claude-code', 'default')?.id).toBe('mine');
    expect(resolveAccountRef(accounts, 'claude-code', 'mine')?.id).toBe('mine');
    expect(resolveAccountRef(accounts, 'claude-code', 'ghost')).toBeNull();
    expect(accountForPath(accounts, 'claude-code', `${home}/.claude/`, { home })?.id).toBe('mine');
    expect(
      accountForPath(accounts, 'claude-code', path.join(home, '.claude9'), { home })
    ).toBeNull();
  });

  it('never resolves default to a hand-edited row with the reserved id', () => {
    // Purpose: that row has no usage file; `default` must stay the real default.
    const accounts = claude(claudeConfig([{ id: 'default', path: path.join(home, '.claude3') }]));
    const found = resolveAccountRef(accounts, 'claude-code', 'default');
    expect(found).toMatchObject({ implicit: true, path: path.join(home, '.claude') });
  });

  it('never matches a row whose id fails the pattern, and takes the first of two matches', () => {
    // Purpose: an unroutable row has no ledger; registry order decides a duplicate folder.
    const dir = path.join(home, '.claude3');
    const accounts = claude(
      claudeConfig([
        { id: 'Bad_Id', path: dir },
        { id: 'first', path: dir },
        { id: 'second', path: dir },
      ])
    );
    expect(accountForPath(accounts, 'claude-code', dir, { home })?.id).toBe('first');
  });

  it('reads the session folder from CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    // Purpose: the folder a status-line session runs in; an empty variable is unset.
    expect(ambientAccountPath('claude-code', { CLAUDE_CONFIG_DIR: '/x' }, home)).toBe('/x');
    expect(ambientAccountPath('claude-code', { CLAUDE_CONFIG_DIR: '' }, home)).toBe(
      path.join(home, '.claude')
    );
    expect(ambientAccountPath('opencode', {}, home)).toBeNull();
  });
});

describe('policy writers and an aliased default', () => {
  it("folds a default entry into the row it aliases, the row's own entry winning", () => {
    // Purpose: one fleet.json policy per real account, whichever key was written first.
    const raw = {
      v: 1,
      accounts: { 'claude-code:default': { reservePct: 20, role: 'main' } },
    };
    expect(
      setAccountPolicy(raw, 'claude-code:mine', { spendDownWindowHours: 6 }, { aliased: true })
    ).toEqual({
      v: 1,
      accounts: { 'claude-code:mine': { reservePct: 20, role: 'main', spendDownWindowHours: 6 } },
    });
    const both = {
      v: 1,
      accounts: {
        'claude-code:default': { role: 'main' },
        'claude-code:mine': { role: 'rotation' },
      },
    };
    expect(setAccountPolicy(both, 'claude-code:mine', {}, { aliased: true }).accounts).toEqual({
      'claude-code:mine': { role: 'rotation' },
    });
  });

  it('never reports a default entry as unknown while default names an account', () => {
    // Purpose: `flow accounts` must not drop an alias entry before a write moves it.
    const accounts = claude(claudeConfig([{ id: 'mine', path: path.join(home, '.claude') }]));
    const raw = { v: 1, accounts: { 'claude-code:default': { role: 'main' }, ghost: {} } };
    expect(unknownPolicyKeys(accounts, raw)).toEqual(['claude-code:ghost']);
  });
});
