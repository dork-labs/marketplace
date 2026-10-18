/**
 * The extension's two bypass tools (DOR-3062): `set_drain_bypass` records a
 * person's grant under the project's exact root, next to the other owners'
 * data, and `get_drain_bypass` reports whether it still holds. The grant they
 * write is the one the flow CLI reads.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import manifest from '../extension.json' with { type: 'json' };
import {
  DRAIN_BYPASS_KEY,
  effectivePermissionMode,
  extensionDataFile,
  settingsFiles,
} from '../../../../scripts/drain-bypass.ts';
import { getDrainBypass, setDrainBypass } from '../lib/drain-bypass-tools.ts';
import { SharedStorage } from '../lib/shared-storage.ts';

const NOW = new Date('2026-10-18T12:00:00.000Z');

let base: string;
let root: string;
let dorkHome: string;

/** Host storage backed by the file DorkOS uses, so the CLI can read what the tool wrote. */
function fileStorage() {
  const file = extensionDataFile(dorkHome);
  return {
    async loadData<T>(): Promise<T | null> {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch {
        return null;
      }
    },
    async saveData<T>(data: T): Promise<void> {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(data));
    },
  };
}

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bypass-tools-')));
  root = path.join(base, 'project');
  dorkHome = path.join(base, 'dork');
  mkdirSync(root);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const files = settingsFiles(root);
  mkdirSync(path.dirname(files.committed), { recursive: true });
  writeFileSync(files.committed, '{}\n');
  writeFileSync(files.local, '{"drain":{"permissionMode":"bypassPermissions"}}\n');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('set_drain_bypass and get_drain_bypass', () => {
  it('records a grant the CLI then honours, and keeps the other owners’ data', async () => {
    const host = fileStorage();
    await host.saveData({ adapterTrust: { x: 'kept' } });
    const view = new SharedStorage(host);

    const set = await setDrainBypass(view, { project: root, allow: true }, NOW);
    expect(set).toMatchObject({ project: root, allowed: true });

    const stored = JSON.parse(readFileSync(extensionDataFile(dorkHome), 'utf8'));
    expect(stored.adapterTrust).toEqual({ x: 'kept' });
    expect(stored[DRAIN_BYPASS_KEY][root].grantedAt).toBe(NOW.toISOString());

    expect(await getDrainBypass(view, { project: root }, NOW)).toMatchObject({ allowed: true });
    const files = settingsFiles(root);
    expect(
      effectivePermissionMode({
        configured: 'bypassPermissions',
        root,
        dorkHome,
        loadedFrom: { committed: files.committed, local: files.local },
        now: NOW,
      })
    ).toEqual({ mode: 'bypassPermissions' });
  });

  it('never loses a revoke that races a grant for another project', async () => {
    // Purpose: both read and write inside the storage queue.
    const other = path.join(base, 'other');
    mkdirSync(other);
    execFileSync('git', ['init', '-q'], { cwd: other });
    const view = new SharedStorage(fileStorage());
    await setDrainBypass(view, { project: root, allow: true }, NOW);
    await Promise.all([
      setDrainBypass(view, { project: root, allow: false }, NOW),
      setDrainBypass(view, { project: realpathSync(other), allow: true }, NOW),
    ]);
    expect(await getDrainBypass(view, { project: root }, NOW)).toMatchObject({ allowed: false });
    expect(await getDrainBypass(view, { project: realpathSync(other) }, NOW)).toMatchObject({
      allowed: true,
    });
  });

  it('takes a grant back with allow false', async () => {
    const view = new SharedStorage(fileStorage());
    await setDrainBypass(view, { project: root, allow: true }, NOW);
    await setDrainBypass(view, { project: root, allow: false }, NOW);
    expect(await getDrainBypass(view, { project: root }, NOW)).toMatchObject({
      allowed: false,
      reason: 'no grant',
    });
  });

  it('reports why a grant no longer holds', async () => {
    const view = new SharedStorage(fileStorage());
    await setDrainBypass(view, { project: root, allow: true }, NOW);
    writeFileSync(settingsFiles(root).local, '{"changed":true}\n');
    expect(await getDrainBypass(view, { project: root }, NOW)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/config\.local\.json changed/),
    });
  });

  it.each([
    ['a relative path', () => 'project'],
    ['a missing folder', () => path.join(base, 'nope')],
    ['a subfolder of the project', () => path.join(root, '.agents')],
  ])('refuses %s, so the card always names the exact project', async (_name, project) => {
    const view = new SharedStorage(fileStorage());
    await expect(setDrainBypass(view, { project: project(), allow: true }, NOW)).rejects.toThrow();
  });

  it('refuses a linked worktree: the grant belongs to the main checkout', async () => {
    const wt = path.join(base, 'wt');
    git('worktree', 'add', '-q', wt, '-b', 'side');
    const view = new SharedStorage(fileStorage());
    await expect(setDrainBypass(view, { project: wt, allow: true }, NOW)).rejects.toThrow(
      /its root is/
    );
  });
});

describe('the declared tools', () => {
  it('declares set_drain_bypass destructive, showing the exact input on the card', () => {
    const set = manifest.tools.find((t) => t.name === 'set_drain_bypass');
    expect(set?.tier).toBe('destructive');
    expect(set?.approvalDisplayFields).toEqual(['project', 'allow']);
    expect(set?.inputSchema.additionalProperties).toBe(false);
    const get = manifest.tools.find((t) => t.name === 'get_drain_bypass');
    expect(get?.tier).toBe('observe');
    expect(manifest.minHostVersion).toBe('0.98.0');
  });
});
