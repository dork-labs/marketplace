/**
 * The permission mode flow's launched sessions start in (DOR-3062). Anything
 * above `acceptEdits` needs a person's grant from DorkOS, kept outside the
 * project; every way that grant can fail to hold falls back to `acceptEdits`
 * with a line saying why.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DRAIN_BYPASS_KEY,
  effectivePermissionMode,
  extensionDataFile,
  GRANT_DAYS,
  makeGrant,
  settingsFiles,
  type BypassGrant,
} from '../scripts/drain-bypass.ts';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let base: string;
let root: string;
let dorkHome: string;

function writeSettings(committed: string, local: string): void {
  const files = settingsFiles(root);
  mkdirSync(path.dirname(files.committed), { recursive: true });
  writeFileSync(files.committed, committed);
  writeFileSync(files.local, local);
}

function storeGrant(grant: BypassGrant, forRoot = root): void {
  const file = extensionDataFile(dorkHome);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ other: 1, [DRAIN_BYPASS_KEY]: { [forRoot]: grant } }));
}

function resolve(
  configured = 'bypassPermissions',
  extra: Partial<Parameters<typeof effectivePermissionMode>[0]> = {}
) {
  const files = settingsFiles(root);
  return effectivePermissionMode({
    configured,
    root,
    dorkHome,
    loadedFrom: { committed: files.committed, local: files.local },
    now: NOW,
    ...extra,
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'drain-bypass-')));
  root = path.join(base, 'project');
  dorkHome = path.join(base, 'dork');
  mkdirSync(root);
  writeSettings('{"drain":{}}\n', '{"drain":{"permissionMode":"bypassPermissions"}}\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('effectivePermissionMode', () => {
  it.each(['default', 'acceptEdits', 'plan'])('takes %s as configured, with no grant', (mode) => {
    expect(resolve(mode)).toEqual({ mode });
  });

  it('honours bypassPermissions while a fresh grant matches both files', () => {
    storeGrant(makeGrant(root, new Date(NOW.getTime() - DAY)));
    expect(resolve()).toEqual({ mode: 'bypassPermissions' });
  });

  it('falls back with no grant, and says how to get one', () => {
    const result = resolve();
    expect(result.mode).toBe('acceptEdits');
    expect(result.notice).toMatch(/no person has granted it/);
    expect(result.notice).toMatch(/DorkOS/);
  });

  it('gates any mode not on the list, not just bypassPermissions', () => {
    // Purpose: an allow-list, so dontAsk, auto and modes not yet invented are covered.
    for (const mode of ['dontAsk', 'auto', 'somethingNew']) {
      expect(resolve(mode).mode).toBe('acceptEdits');
    }
  });

  it('lapses when config.local.json changes after the grant', () => {
    storeGrant(makeGrant(root, NOW));
    writeSettings('{"drain":{}}\n', '{"drain":{"permissionMode":"bypassPermissions"},"x":1}\n');
    expect(resolve().notice).toMatch(/config\.local\.json changed/);
  });

  it('lapses when config.json changes after the grant', () => {
    storeGrant(makeGrant(root, NOW));
    writeSettings(
      '{"drain":{"parallel":9}}\n',
      '{"drain":{"permissionMode":"bypassPermissions"}}\n'
    );
    expect(resolve().notice).toMatch(/config\.json changed/);
  });

  it(`lapses ${GRANT_DAYS} days after the grant`, () => {
    storeGrant(makeGrant(root, new Date(NOW.getTime() - (GRANT_DAYS * DAY + 1000))));
    expect(resolve().notice).toMatch(/more than 30 days old/);
  });

  it('refuses a grant dated in the future', () => {
    storeGrant(makeGrant(root, new Date(NOW.getTime() + DAY)));
    expect(resolve().notice).toMatch(/impossible date/);
  });

  it('refuses a grant made for another folder (a copy of the project)', () => {
    storeGrant(makeGrant(root, NOW), path.join(base, 'elsewhere'));
    expect(resolve().mode).toBe('acceptEdits');
  });

  it('refuses a data file that is a symlink', () => {
    const real = path.join(base, 'planted.json');
    writeFileSync(real, JSON.stringify({ [DRAIN_BYPASS_KEY]: { [root]: makeGrant(root, NOW) } }));
    mkdirSync(path.dirname(extensionDataFile(dorkHome)), { recursive: true });
    symlinkSync(real, extensionDataFile(dorkHome));
    expect(resolve().mode).toBe('acceptEdits');
  });

  it('refuses when flow read its settings from somewhere else', () => {
    storeGrant(makeGrant(root, NOW));
    const result = resolve('bypassPermissions', {
      loadedFrom: { committed: path.join(base, 'plugin', 'config.json'), local: null },
    });
    expect(result.notice).toMatch(/read settings from outside/);
  });

  it('falls back with no git root or no DorkOS folder', () => {
    expect(resolve('bypassPermissions', { root: null }).notice).toMatch(/no git root/);
    expect(resolve('bypassPermissions', { dorkHome: null }).notice).toMatch(/DorkOS is not here/);
  });

  it('ignores a malformed grant', () => {
    storeGrant({ grantedAt: 'soon', configHash: 'x', localHash: 'y' });
    expect(resolve().mode).toBe('acceptEdits');
    writeFileSync(extensionDataFile(dorkHome), 'not json');
    expect(resolve().mode).toBe('acceptEdits');
  });
});
