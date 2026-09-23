/**
 * `scripts/config-files.ts` on a filesystem without hard links (exFAT, FAT, some
 * network mounts), where `link()` fails with `ENOTSUP`. The migration must still
 * copy the settings, still never overwrite, and leave no temporary file behind.
 * `linkSync` is replaced for this file only, so every other `node:fs` call is real.
 *
 * @see specs/flow-config-location/02-specification.md
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** When set, the next exclusive create of a non-temp file writes one byte only: a torn write. */
const fault = vi.hoisted(() => ({ tearNextCreate: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const linkSync = () => {
    throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
  };
  const writeFileSync: typeof fs.writeFileSync = (file, data, options) => {
    const exclusive = typeof options === 'object' && options !== null && options.flag === 'wx';
    if (fault.tearNextCreate && exclusive && !String(file).endsWith('.tmp')) {
      fault.tearNextCreate = false;
      return fs.writeFileSync(file, Buffer.from(data as Buffer).subarray(0, 1), options);
    }
    return fs.writeFileSync(file, data, options);
  };
  return {
    ...fs,
    default: { ...fs, linkSync, writeFileSync },
    linkSync,
    writeFileSync,
  };
});

const fs = await import('node:fs');
const { migrateConfig } = await import('../scripts/config-files.ts');

let repo: string;
let plugin: string;
const LOCAL = '{"secrets":{"trackerAccount":"me"}}\n';

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-no-links-')));
  repo = path.join(base, 'project');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  plugin = path.join(repo, '.dork', 'plugins', 'flow');
  fs.mkdirSync(path.join(plugin, 'config'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'config', 'config.json'), '{"tracker":"linear"}');
  fs.writeFileSync(path.join(plugin, 'config', 'config.local.json'), LOCAL);
});

afterEach(() => {
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
});

const roots = () => ({ checkout: repo, mainCheckout: null, inGit: true, pluginRoot: plugin });

describe('migrateConfig without hard links', () => {
  // Fails if a link error other than EEXIST is fatal: the settings would never
  // move off such a disk.
  it('copies both files by exclusive create, owner-only, with no temp left', () => {
    const result = migrateConfig(roots());
    expect(result).toMatchObject({ ok: true, migrated: true });
    const dir = path.join(repo, '.agents/flow');
    expect(fs.readFileSync(path.join(dir, 'config.local.json'), 'utf8')).toBe(LOCAL);
    expect(fs.statSync(path.join(dir, 'config.local.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({
      tracker: 'linear',
    });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  // A copy that does not read back as written is removed, not left for flow to
  // read, and the migration stops. Fails if the read-back check is skipped.
  it('removes a torn copy and stops', () => {
    fault.tearNextCreate = true;
    const result = migrateConfig(roots());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('did not read back');
    const dir = path.join(repo, '.agents/flow');
    expect(fs.existsSync(path.join(dir, 'config.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  // The fallback must be exclusive too: a different local file already there is
  // kept, and the migration stops. Fails if the fallback writes without 'wx'.
  it('still never overwrites an existing file', () => {
    const dir = path.join(repo, '.agents/flow');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.local.json'), '{"mine":true}\n');
    expect(migrateConfig(roots()).ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'config.local.json'), 'utf8')).toBe('{"mine":true}\n');
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
  });
});
