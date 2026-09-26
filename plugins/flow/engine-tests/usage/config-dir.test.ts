/**
 * Which registered account a Claude Code config dir belongs to (spec
 * `flow-usage` §2.1). The status line names no account, so a wrong match here
 * would write one account's usage into another's ledger.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountIdentity } from '../../scripts/fleet/accounts.ts';
import { accountForConfigDir, defaultConfigDir } from '../../scripts/fleet/config-dir.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'flow-config-dir-'));
  mkdirSync(path.join(home, '.claude'));
  mkdirSync(path.join(home, '.claude2'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function identity(id: string, dir: string, routable = true): AccountIdentity {
  return { id, path: dir, label: null, color: null, routable };
}

describe('defaultConfigDir', () => {
  it('uses CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    // Purpose: an unset or empty variable means the default install.
    expect(defaultConfigDir({ CLAUDE_CONFIG_DIR: '/x/.claude3' }, home)).toBe('/x/.claude3');
    expect(defaultConfigDir({ CLAUDE_CONFIG_DIR: '' }, home)).toBe(path.join(home, '.claude'));
    expect(defaultConfigDir({}, home)).toBe(path.join(home, '.claude'));
  });
});

describe('accountForConfigDir', () => {
  it('matches the default dir when CLAUDE_CONFIG_DIR is unset', () => {
    // Purpose: the main account usually runs with no variable at all.
    const ids = [
      identity('two', path.join(home, '.claude2')),
      identity('one', path.join(home, '.claude')),
    ];
    expect(accountForConfigDir(ids, defaultConfigDir({}, home), home)?.id).toBe('one');
  });

  it('ignores a trailing slash and expands ~', () => {
    // Purpose: config written by hand often carries either.
    const ids = [identity('two', '~/.claude2')];
    expect(accountForConfigDir(ids, path.join(home, '.claude2') + '/', home)?.id).toBe('two');
  });

  it('matches a symlinked dir to its target', () => {
    // Purpose: a registry row may name the link and the session the real folder, or the reverse.
    const link = path.join(home, 'link-to-2');
    symlinkSync(path.join(home, '.claude2'), link);
    const ids = [identity('two', link)];
    expect(accountForConfigDir(ids, path.join(home, '.claude2'), home)?.id).toBe('two');
  });

  it('never matches a row whose id fails the pattern', () => {
    // Purpose: such a row has no usage file.
    const ids = [identity('Bad_Id', path.join(home, '.claude2'), false)];
    expect(accountForConfigDir(ids, path.join(home, '.claude2'), home)).toBeNull();
  });

  it('takes the first of two matches, and null for no match', () => {
    // Purpose: registry order decides a duplicate path.
    const dir = path.join(home, '.claude2');
    const ids = [identity('first', dir), identity('second', dir)];
    expect(accountForConfigDir(ids, dir, home)?.id).toBe('first');
    expect(accountForConfigDir(ids, path.join(home, '.claude9'), home)).toBeNull();
  });
});
