/**
 * Contract suite for `scripts/config-files.ts`: where flow finds its settings
 * (DOR-2274). Every case runs against real temporary directories and real `git`,
 * because the rules under test are about real filesystems: which checkout a
 * worktree belongs to, what git ignores, and which files already exist.
 *
 * @see specs/flow-config-location/02-specification.md
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_SCHEMA_URL,
  findConfigRoots,
  legacyConfigDirs,
  migrateConfig,
  prepareProjectDir,
  resolveConfigFiles,
  type ConfigRoots,
} from '../scripts/config-files.ts';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let base: string;

beforeEach(() => {
  // realpath: macOS hands out /var/... but git answers with /private/var/...
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-config-files-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A git repo with one commit, so worktrees can be added to it. */
function makeRepo(name = 'project'): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(
    dir,
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  return dir;
}

function write(file: string, content: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const LEGACY_CONFIG = `${JSON.stringify({ $schema: './config.schema.json', tracker: 'linear' }, null, 2)}\n`;
const LEGACY_LOCAL = '{\n  "secrets": { "trackerAccount": "me" }\n}\n';

/** A flow install folder holding legacy settings in its own `config/`. */
function makePlugin(dir: string, files: { config?: string; local?: string } = {}): string {
  mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (files.config !== undefined) write(path.join(dir, 'config', 'config.json'), files.config);
  if (files.local !== undefined) write(path.join(dir, 'config', 'config.local.json'), files.local);
  return dir;
}

function roots(
  checkout: string,
  pluginRoot: string,
  mainCheckout: string | null = null
): ConfigRoots {
  return { checkout, mainCheckout, pluginRoot };
}

describe('findConfigRoots', () => {
  // The checkout is the repo top level even when flow runs from a subfolder, and a
  // plain checkout has no separate main checkout to fall back to.
  it('finds the top level from a subfolder, with no main checkout', () => {
    const repo = makeRepo();
    const sub = path.join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(findConfigRoots(sub, PLUGIN_DIR)).toEqual({
      checkout: repo,
      mainCheckout: null,
      pluginRoot: PLUGIN_DIR,
    });
  });

  // A linked worktree points back at the checkout that owns the repo, which is
  // where ignored settings live. Fails if the common dir is not consulted.
  it('names the main checkout from a linked worktree', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    expect(findConfigRoots(wt, PLUGIN_DIR)).toEqual({
      checkout: wt,
      mainCheckout: repo,
      pluginRoot: PLUGIN_DIR,
    });
  });

  // Outside git the folder itself is the project, so flow still works in a
  // plain directory.
  it('uses the folder itself outside a git repo', () => {
    const dir = path.join(base, 'plain');
    mkdirSync(dir);
    expect(findConfigRoots(dir, PLUGIN_DIR)).toEqual({
      checkout: dir,
      mainCheckout: null,
      pluginRoot: PLUGIN_DIR,
    });
  });
});

describe('legacyConfigDirs', () => {
  // An install outside Claude Code's cache has exactly one legacy place: its own
  // config folder. Fails if siblings of an arbitrary folder are ever searched.
  it('is only the plugin’s own config folder outside the Claude Code cache', () => {
    const plugin = makePlugin(path.join(base, 'somewhere', 'flow'));
    makePlugin(path.join(base, 'somewhere', 'other'), { config: LEGACY_CONFIG });
    expect(legacyConfigDirs(plugin)).toEqual([path.join(plugin, 'config')]);
  });

  // In Claude Code's cache an update installs into a new version folder and the
  // old settings stay in the previous one. Newest settings first; folders with
  // no config.json are skipped.
  it('adds sibling version folders in the cache, newest config first', () => {
    const flowDir = path.join(base, '.claude', 'plugins', 'cache', 'dork-labs', 'flow');
    const current = makePlugin(path.join(flowDir, '0.8.0'));
    const older = makePlugin(path.join(flowDir, '0.7.3'), { config: LEGACY_CONFIG });
    const newer = makePlugin(path.join(flowDir, '0.7.4'), { config: LEGACY_CONFIG });
    makePlugin(path.join(flowDir, '0.7.0'));
    const t = Date.now() / 1000;
    utimesSync(path.join(older, 'config', 'config.json'), t - 100, t - 100);
    utimesSync(path.join(newer, 'config', 'config.json'), t, t);
    expect(legacyConfigDirs(current)).toEqual([
      path.join(current, 'config'),
      path.join(newer, 'config'),
      path.join(older, 'config'),
    ]);
  });
});

describe('resolveConfigFiles', () => {
  // The project's own file beats anything in the plugin: once a project has
  // settings, the plugin folder is never read for it again.
  it('prefers the project over the legacy plugin folder', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const committed = write(path.join(repo, '.agents/flow/config.json'), '{}');
    expect(resolveConfigFiles(roots(repo, plugin))).toEqual({
      origin: 'project',
      committed,
      local: null,
      projectDir: path.join(repo, '.agents/flow'),
    });
  });

  // In a worktree the committed file comes from the branch when the branch has
  // it, and the ignored local file comes from the main checkout, where it lives.
  it('reads the checkout first, then the main checkout, per file', () => {
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    const plugin = makePlugin(path.join(base, 'plugin'));
    write(path.join(main, '.agents/flow/config.json'), '{}');
    const local = write(path.join(main, '.agents/flow/config.local.json'), '{}');
    const committed = write(path.join(wt, '.agents/flow/config.json'), '{}');
    expect(resolveConfigFiles(roots(wt, plugin, main))).toEqual({
      origin: 'project',
      committed,
      local,
      projectDir: path.join(main, '.agents/flow'),
    });
  });

  // A worktree whose branch predates the settings still finds them in the main
  // checkout, so a new worktree needs nothing copied into it.
  it('finds the main checkout’s files from a worktree that has none', () => {
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    mkdirSync(wt);
    const plugin = makePlugin(path.join(base, 'plugin'), { config: LEGACY_CONFIG });
    const committed = write(path.join(main, '.agents/flow/config.json'), '{}');
    expect(resolveConfigFiles(roots(wt, plugin, main)).committed).toBe(committed);
  });

  // With no project settings, the plugin's own folder is used, and the local file
  // is taken from the same folder, never from another version.
  it('falls back to one legacy folder and never mixes folders', () => {
    const flowDir = path.join(base, 'plugins', 'cache', 'm', 'flow');
    const current = makePlugin(path.join(flowDir, '0.8.0'), { config: LEGACY_CONFIG });
    makePlugin(path.join(flowDir, '0.7.4'), { config: LEGACY_CONFIG, local: LEGACY_LOCAL });
    const repo = makeRepo();
    expect(resolveConfigFiles(roots(repo, current))).toEqual({
      origin: 'legacy',
      committed: path.join(current, 'config', 'config.json'),
      local: null,
      projectDir: path.join(repo, '.agents/flow'),
    });
  });

  // The upgrade case: the new version folder is empty, the old one has the
  // settings. Fails if the cache siblings are not searched.
  it('finds settings left in the previous cache version folder', () => {
    const flowDir = path.join(base, 'plugins', 'cache', 'm', 'flow');
    const current = makePlugin(path.join(flowDir, '0.8.0'));
    const old = makePlugin(path.join(flowDir, '0.7.4'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const repo = makeRepo();
    expect(resolveConfigFiles(roots(repo, current))).toMatchObject({
      origin: 'legacy',
      committed: path.join(old, 'config', 'config.json'),
      local: path.join(old, 'config', 'config.local.json'),
    });
  });

  // No settings anywhere means not configured; a local file alone is not a
  // configuration.
  it('is none when no config.json exists anywhere', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.local.json'), '{}');
    const plugin = makePlugin(path.join(base, 'plugin'), { local: LEGACY_LOCAL });
    expect(resolveConfigFiles(roots(repo, plugin))).toEqual({
      origin: 'none',
      committed: null,
      local: null,
      projectDir: path.join(repo, '.agents/flow'),
    });
  });
});

describe('prepareProjectDir', () => {
  // The local file holds credentials, so the folder must make git ignore it
  // before anything is written there.
  it('creates the folder and a .gitignore that git honours', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.agents/flow');
    const result = prepareProjectDir(dir);
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('config.local.json');
    write(path.join(dir, 'config.local.json'), '{}');
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'config.local.json'
    );
  });

  // An existing .gitignore is someone's file: add the line once, keep the rest.
  it('appends to an existing .gitignore once, keeping its lines', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, '.gitignore'), 'notes.md');
    prepareProjectDir(dir);
    prepareProjectDir(dir);
    const lines = readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('notes.md');
    expect(lines.filter((l) => l === 'config.local.json')).toHaveLength(1);
  });

  // A negation rule deeper down can keep the file tracked no matter what the
  // folder's .gitignore says. Then nothing secret may be written. Fails if the
  // result trusts the .gitignore line without asking git.
  it('refuses when git would still track the local file', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, '.gitignore'), 'config.local.json\n!config.local.json\n');
    const result = prepareProjectDir(dir);
    expect(result.ok).toBe(false);
  });
});

describe('migrateConfig', () => {
  function legacySetup() {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    return { repo, plugin, r: roots(repo, plugin) };
  }

  // The whole point: settings reach the project, the local file byte for byte
  // and owner-only, the committed file with a $schema that works from there.
  it('copies both files into the project', () => {
    const { repo, plugin, r } = legacySetup();
    const result = migrateConfig(r);
    const dir = path.join(repo, '.agents/flow');
    expect(result).toMatchObject({ ok: true, migrated: true, from: path.join(plugin, 'config') });
    expect(readFileSync(path.join(dir, 'config.local.json'), 'utf8')).toBe(LEGACY_LOCAL);
    expect(statSync(path.join(dir, 'config.local.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({
      $schema: CONFIG_SCHEMA_URL,
      tracker: 'linear',
    });
    expect(resolveConfigFiles(r).origin).toBe('project');
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).not.toContain(
      'config.local.json'
    );
  });

  // The old files may still serve another project on the same install, so they
  // are never removed.
  it('leaves the legacy files in place', () => {
    const { plugin, r } = legacySetup();
    const result = migrateConfig(r);
    expect(readFileSync(path.join(plugin, 'config', 'config.json'), 'utf8')).toBe(LEGACY_CONFIG);
    expect(readFileSync(path.join(plugin, 'config', 'config.local.json'), 'utf8')).toBe(
      LEGACY_LOCAL
    );
    expect(result.leftInPlace).toEqual([
      path.join(plugin, 'config', 'config.json'),
      path.join(plugin, 'config', 'config.local.json'),
    ]);
  });

  // Running it again, as every /flow start does, changes nothing.
  it('is a no-op once the project has its settings', () => {
    const { r } = legacySetup();
    migrateConfig(r);
    expect(migrateConfig(r)).toMatchObject({ ok: true, migrated: false, wrote: [] });
  });

  // A crash after the local copy and before the committed one leaves the project
  // still reading the legacy pair; the next run finishes the job. Fails if the
  // committed file is written first, or if an identical local file is a conflict.
  it('finishes a migration interrupted between the two files', () => {
    const { repo, r } = legacySetup();
    const dir = path.join(repo, '.agents/flow');
    prepareProjectDir(dir);
    write(path.join(dir, 'config.local.json'), LEGACY_LOCAL);
    expect(resolveConfigFiles(r).origin).toBe('legacy');
    const result = migrateConfig(r);
    expect(result).toMatchObject({ ok: true, migrated: true });
    expect(result.unchanged).toEqual([path.join(dir, 'config.local.json')]);
    expect(result.wrote).toEqual([path.join(dir, 'config.json')]);
  });

  // A different file already at the destination is the person's; it is never
  // overwritten, and the committed file is not written either.
  it('stops without overwriting a different existing local file', () => {
    const { repo, r } = legacySetup();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, 'config.local.json'), '{"mine":true}\n');
    const result = migrateConfig(r);
    expect(result.ok).toBe(false);
    expect(readFileSync(path.join(dir, 'config.local.json'), 'utf8')).toBe('{"mine":true}\n');
    expect(existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  // A broken legacy config.json cannot be carried over faithfully; nothing is
  // written, so /flow:init can start clean.
  it('writes nothing when the legacy config.json is not JSON', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), { config: '{ nope', local: LEGACY_LOCAL });
    const result = migrateConfig(roots(repo, plugin));
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(repo, '.agents/flow'))).toBe(false);
  });

  // Only a $schema that is not a URL is rewritten; a URL is kept as is.
  it('keeps a $schema that is already a URL', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: '{"$schema":"https://example.com/s.json","tracker":"linear"}',
    });
    migrateConfig(roots(repo, plugin));
    expect(
      JSON.parse(readFileSync(path.join(repo, '.agents/flow/config.json'), 'utf8')).$schema
    ).toBe('https://example.com/s.json');
  });

  // Two projects on one shared install each get their own copy, and the second
  // still finds the legacy files the first one migrated from.
  it('migrates two projects from one shared install', () => {
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const a = makeRepo('a');
    const b = makeRepo('b');
    expect(migrateConfig(roots(a, plugin)).migrated).toBe(true);
    expect(migrateConfig(roots(b, plugin)).migrated).toBe(true);
    expect(readFileSync(path.join(b, '.agents/flow/config.local.json'), 'utf8')).toBe(LEGACY_LOCAL);
  });

  // From a worktree the files go to the main checkout, where every worktree
  // looks for them.
  it('writes to the main checkout from a worktree', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const plugin = makePlugin(path.join(base, 'plugin'), { config: LEGACY_CONFIG });
    migrateConfig(findConfigRoots(wt, plugin));
    expect(existsSync(path.join(repo, '.agents/flow/config.json'))).toBe(true);
    expect(existsSync(path.join(wt, '.agents/flow'))).toBe(false);
  });

  // Nothing to do is not a failure.
  it('reports nothing to migrate when there are no settings anywhere', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'));
    expect(migrateConfig(roots(repo, plugin))).toMatchObject({
      ok: true,
      migrated: false,
      wrote: [],
    });
  });
});

describe('config-files CLI', () => {
  /**
   * A copy of the flow scripts in a throwaway install folder, so the CLI's own
   * plugin root (found from its file location, as in a real install) is under the
   * test's control rather than this checkout's.
   */
  function installCopy(files: { config?: string; local?: string } = {}): string {
    const plugin = makePlugin(path.join(base, 'install'), files);
    mkdirSync(path.join(plugin, 'scripts'));
    for (const name of ['config-files.ts', 'validate-config.ts', '_shared.ts']) {
      copyFileSync(path.join(PLUGIN_DIR, 'scripts', name), path.join(plugin, 'scripts', name));
    }
    copyFileSync(
      path.join(PLUGIN_DIR, 'config', 'config.schema.json'),
      path.join(plugin, 'config', 'config.schema.json')
    );
    return plugin;
  }

  function run(plugin: string, cwd: string, ...args: string[]) {
    const res = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(plugin, 'scripts', 'config-files.ts'), ...args],
      { cwd, encoding: 'utf8' }
    );
    return {
      status: res.status,
      out: res.stdout ? JSON.parse(res.stdout) : null,
      stderr: res.stderr,
    };
  }

  // Not configured is exit 1, so the /flow guard routes to /flow:init.
  it('resolve exits 1 when nothing is configured', () => {
    const repo = makeRepo();
    const { status, out } = run(installCopy(), repo);
    expect(status).toBe(1);
    expect(out).toMatchObject({ ok: false, origin: 'none', committed: null });
  });

  // A valid project config is ok, with the paths the skills read.
  it('resolve exits 0 with the project files', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.json'), '{"tracker":"linear"}');
    const { status, out } = run(installCopy(), repo);
    expect(status).toBe(0);
    expect(out).toEqual({
      ok: true,
      origin: 'project',
      committed: path.join(repo, '.agents/flow/config.json'),
      local: null,
      projectDir: path.join(repo, '.agents/flow'),
      errors: [],
      warnings: [],
    });
  });

  // Legacy settings still work, and the output says to migrate them.
  it('resolve warns that legacy settings should be migrated', () => {
    const repo = makeRepo();
    const plugin = installCopy({ config: LEGACY_CONFIG });
    const { status, out } = run(plugin, repo);
    expect(status).toBe(0);
    expect(out.origin).toBe('legacy');
    expect(out.warnings.map((w: { message: string }) => w.message).join('\n')).toContain('migrate');
  });

  // validate-config's findings come through unchanged: a wrong value is an
  // error, and credentials in the committed file are a warning.
  it('resolve reports validation errors and the secrets warning', () => {
    const repo = makeRepo();
    write(
      path.join(repo, '.agents/flow/config.json'),
      '{"tracker":"Not A Slug","secrets":{"trackerToken":"x"}}'
    );
    const { status, out } = run(installCopy(), repo);
    expect(status).toBe(1);
    expect(out.errors.map((e: { path: string }) => e.path)).toEqual(['/tracker']);
    expect(out.warnings.map((w: { path: string }) => w.path)).toEqual(['/secrets']);
  });

  // Broken JSON is an error at the root, not a crash.
  it('resolve reports unreadable JSON as an error', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.json'), '{ nope');
    const { status, out } = run(installCopy(), repo);
    expect(status).toBe(1);
    expect(out.errors[0].path).toBe('(root)');
  });

  // Team settings that git ignores still work but are not shared; say so.
  it('resolve warns when the committed file is ignored by git', () => {
    const repo = makeRepo();
    write(path.join(repo, '.gitignore'), '.agents/\n');
    write(path.join(repo, '.agents/flow/config.json'), '{}');
    const { status, out } = run(installCopy(), repo);
    expect(status).toBe(0);
    expect(out.warnings.map((w: { message: string }) => w.message).join('\n')).toContain(
      'ignored by git'
    );
  });

  // migrate and prepare run end to end, and --project picks the folder.
  it('migrate copies settings for the --project folder, prepare prints targets', () => {
    const repo = makeRepo();
    const plugin = installCopy({ config: LEGACY_CONFIG, local: LEGACY_LOCAL });
    const migrated = run(plugin, base, 'migrate', '--project', repo);
    expect(migrated.status).toBe(0);
    expect(migrated.out.migrated).toBe(true);
    expect(migrated.stderr).not.toContain('trackerAccount');
    const prepared = run(plugin, base, 'prepare', '--project', repo);
    expect(prepared.out).toMatchObject({
      ok: true,
      committed: path.join(repo, '.agents/flow/config.json'),
      local: path.join(repo, '.agents/flow/config.local.json'),
    });
  });

  // An unknown subcommand is a usage error, not a silent resolve.
  it('rejects an unknown subcommand', () => {
    const repo = makeRepo();
    const { status } = run(installCopy(), repo, 'mirgate');
    expect(status).toBe(2);
  });
});
