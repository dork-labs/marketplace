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
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_SCHEMA_URL,
  MIGRATED_MARKER,
  findConfigRoots,
  legacyConfigDirs,
  migrateConfig,
  prepareConfigDirs,
  refusalFor,
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

/** What git would add under `.agents/` (the settings folder), one line per path. */
function untracked(repo: string): string {
  return git(repo, 'status', '--porcelain', '--untracked-files=all', '--', '.agents');
}

const LEGACY_CONFIG = `${JSON.stringify({ $schema: './config.schema.json', tracker: 'linear' }, null, 2)}\n`;
const LEGACY_LOCAL =
  '{\n  "secrets": { "trackerAccount": "me", "trackerToken": "tok" },\n  "connection": { "team": { "key": "ACME" }, "workspace": { "slug": "acme" } }\n}\n';

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
  return { checkout, mainCheckout, inGit: true, pluginRoot };
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
      inGit: true,
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
      inGit: true,
      pluginRoot: PLUGIN_DIR,
    });
  });

  // A submodule's common git dir is `<super>/.git/modules/<name>`, not a
  // `.git` folder, so it has no main checkout. Fails if the `.git` name check
  // is dropped (the main checkout would become `<super>/.git/modules`).
  it('gives a submodule no main checkout', () => {
    const sub = makeRepo('subrepo');
    const sup = makeRepo('super');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
    expect(findConfigRoots(path.join(sup, 'sub'), PLUGIN_DIR).mainCheckout).toBeNull();
  });

  // Outside git the folder itself is the project, so flow still works in a
  // plain directory.
  it('uses the folder itself outside a git repo', () => {
    const dir = path.join(base, 'plain');
    mkdirSync(dir);
    expect(findConfigRoots(dir, PLUGIN_DIR)).toEqual({
      checkout: dir,
      mainCheckout: null,
      inGit: false,
      pluginRoot: PLUGIN_DIR,
    });
  });
});

describe('refusalFor', () => {
  // The home folder is not a project: settings there would apply to every
  // folder beneath it. Only the non-git case is refused.
  it('refuses the home folder outside git, and nothing else', () => {
    const home = os.homedir();
    expect(
      refusalFor({ checkout: home, mainCheckout: null, inGit: false, pluginRoot: PLUGIN_DIR })
    ).toMatch(/home folder/);
    expect(
      refusalFor({ checkout: home, mainCheckout: null, inGit: true, pluginRoot: PLUGIN_DIR })
    ).toBeNull();
    expect(
      refusalFor({ checkout: base, mainCheckout: null, inGit: false, pluginRoot: PLUGIN_DIR })
    ).toBeNull();
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
      committedDir: path.join(repo, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
      shared: false,
      moved: [],
    });
  });

  // In a worktree the committed file comes from the branch when the branch has
  // it, and the ignored local file comes from the main checkout, where it lives.
  // Each is written back where it was found.
  it('reads the checkout first, then the main checkout, per file', () => {
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    const plugin = makePlugin(path.join(base, 'plugin'));
    write(path.join(main, '.agents/flow/config.json'), '{}');
    const local = write(path.join(main, '.agents/flow/config.local.json'), '{}');
    const committed = write(path.join(wt, '.agents/flow/config.json'), '{}');
    expect(resolveConfigFiles(roots(wt, plugin, main))).toMatchObject({
      origin: 'project',
      committed,
      local,
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(main, '.agents/flow'),
    });
  });

  // A fresh setup in a worktree puts config.json on the branch (current
  // checkout) and config.local.json in the main checkout, where every worktree
  // finds it.
  it('targets the checkout for config.json and the main checkout for the local file', () => {
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    const plugin = makePlugin(path.join(base, 'plugin'));
    expect(resolveConfigFiles(roots(wt, plugin, main))).toMatchObject({
      origin: 'none',
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(main, '.agents/flow'),
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
    expect(resolveConfigFiles(roots(wt, plugin, main))).toMatchObject({
      committed,
      committedDir: path.join(main, '.agents/flow'),
    });
  });

  // With no project settings, the plugin's own folder is used, and the local file
  // is taken from the same folder, never from another version.
  it('falls back to one legacy folder and never mixes folders', () => {
    const flowDir = path.join(base, 'plugins', 'cache', 'm', 'flow');
    const current = makePlugin(path.join(flowDir, '0.8.0'), { config: LEGACY_CONFIG });
    makePlugin(path.join(flowDir, '0.7.4'), { config: LEGACY_CONFIG, local: LEGACY_LOCAL });
    const repo = makeRepo();
    expect(resolveConfigFiles(roots(repo, current))).toMatchObject({
      origin: 'legacy',
      committed: path.join(current, 'config', 'config.json'),
      local: null,
      shared: true,
    });
  });

  // A project local file never pairs with a legacy config.json: the pair comes
  // from one place. Fails if the project local file is taken for a legacy origin.
  it('never pairs a legacy config.json with the project’s local file', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.local.json'), '{}');
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    expect(resolveConfigFiles(roots(repo, plugin))).toMatchObject({
      origin: 'legacy',
      local: path.join(plugin, 'config', 'config.local.json'),
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

  // A plugin installed inside the project (a DorkOS project-scope install) holds
  // that project's settings; one anywhere else may be shared by several projects.
  it('marks a plugin folder outside the project as shared, one inside as not', () => {
    const repo = makeRepo();
    const inside = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'), {
      config: LEGACY_CONFIG,
    });
    const outside = makePlugin(path.join(base, 'plugin'), { config: LEGACY_CONFIG });
    expect(resolveConfigFiles(roots(repo, inside)).shared).toBe(false);
    expect(resolveConfigFiles(roots(repo, outside)).shared).toBe(true);
  });

  // A folder whose settings moved to another project is never read again; the
  // resolver says where they went. Fails if the marker is ignored.
  it('skips a legacy folder marked as moved, and says where to', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), { config: LEGACY_CONFIG });
    write(path.join(plugin, 'config', MIGRATED_MARKER), '/work/project-a\n');
    expect(resolveConfigFiles(roots(repo, plugin))).toMatchObject({
      origin: 'none',
      committed: null,
      moved: [{ folder: path.join(plugin, 'config'), movedTo: '/work/project-a' }],
    });
  });

  // No settings anywhere means not configured; a local file alone is not a
  // configuration.
  it('is none when no config.json exists anywhere', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.local.json'), '{}');
    const plugin = makePlugin(path.join(base, 'plugin'), { local: LEGACY_LOCAL });
    expect(resolveConfigFiles(roots(repo, plugin))).toMatchObject({
      origin: 'none',
      committed: null,
      local: null,
    });
  });
});

describe('prepareConfigDirs', () => {
  // The local file holds credentials, so the folder must make git ignore it,
  // and the temporary copies a write makes, before anything is written there.
  it('creates the folder and a .gitignore that git honours', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.agents/flow');
    const result = prepareConfigDirs({ committedDir: dir, localDir: dir });
    expect(result).toMatchObject({
      ok: true,
      committed: path.join(dir, 'config.json'),
      local: path.join(dir, 'config.local.json'),
    });
    write(path.join(dir, 'config.local.json'), '{}');
    write(path.join(dir, '.config.local.json.1234.tmp'), '{}');
    expect(untracked(repo)).toBe('?? .agents/flow/.gitignore');
  });

  // In a worktree the two files go to two folders; both get the .gitignore,
  // because a local file may be written in either. Fails if only one does.
  it('prepares both folders when they differ', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const result = prepareConfigDirs({
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
    });
    expect(result.ok).toBe(true);
    write(path.join(wt, '.agents/flow/config.local.json'), '{}');
    write(path.join(repo, '.agents/flow/config.local.json'), '{}');
    expect(untracked(wt)).toBe('?? .agents/flow/.gitignore');
    expect(untracked(repo)).toBe('?? .agents/flow/.gitignore');
  });

  // An existing .gitignore is someone's file: add the lines once, keep the rest.
  it('appends to an existing .gitignore once, keeping its lines', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, '.gitignore'), 'notes.md');
    prepareConfigDirs({ committedDir: dir, localDir: dir });
    prepareConfigDirs({ committedDir: dir, localDir: dir });
    const lines = readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('notes.md');
    expect(lines.filter((l) => l === 'config.local.json')).toHaveLength(1);
    expect(lines.filter((l) => l === '.config.local.json.*.tmp')).toHaveLength(1);
  });

  // A negation rule can keep the file tracked no matter what the folder's
  // .gitignore says. Then nothing secret may be written. Fails if the result
  // trusts the .gitignore line without asking git.
  it('refuses when git would still track the local file', () => {
    const repo = makeRepo();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, '.gitignore'), 'config.local.json\n!config.local.json\n');
    expect(prepareConfigDirs({ committedDir: dir, localDir: dir }).ok).toBe(false);
  });
});

describe('migrateConfig', () => {
  /** A DorkOS project-scope install: the plugin folder is inside the project. */
  function inProjectSetup(
    files: { config?: string; local?: string } = { config: LEGACY_CONFIG, local: LEGACY_LOCAL }
  ) {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'), files);
    return { repo, plugin, r: roots(repo, plugin) };
  }

  // The whole point: settings reach the project, the local file byte for byte
  // and owner-only, the committed file with a $schema that works from there.
  it('copies both files from a plugin folder inside the project, without asking', () => {
    const { repo, plugin, r } = inProjectSetup();
    const result = migrateConfig(r);
    const dir = path.join(repo, '.agents/flow');
    expect(result).toMatchObject({
      ok: true,
      migrated: true,
      needsConfirmation: false,
      from: path.join(plugin, 'config'),
    });
    expect(readFileSync(path.join(dir, 'config.local.json'), 'utf8')).toBe(LEGACY_LOCAL);
    expect(statSync(path.join(dir, 'config.local.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({
      $schema: CONFIG_SCHEMA_URL,
      tracker: 'linear',
    });
    expect(resolveConfigFiles(r).origin).toBe('project');
    expect(untracked(repo)).not.toContain('config.local.json');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  // Settings in a folder several projects may share (Claude Code's cache,
  // --plugin-dir, a user-scope install) could be another project's, credentials
  // included. Without a person's confirmation nothing is copied; what was found
  // is described without any secret.
  it('refuses to copy settings from a shared plugin folder without confirmation', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const result = migrateConfig(roots(repo, plugin));
    expect(result).toMatchObject({
      ok: true,
      migrated: false,
      needsConfirmation: true,
      wrote: [],
      found: {
        folder: path.join(plugin, 'config'),
        tracker: 'linear',
        team: 'ACME',
        workspace: 'acme',
      },
    });
    expect(JSON.stringify(result)).not.toContain('tok');
    expect(existsSync(path.join(repo, '.agents'))).toBe(false);
  });

  // Once a person confirms, the settings move, and the old folder is marked with
  // this project so the next project is not handed them.
  it('copies confirmed shared settings and marks the old folder as moved', () => {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const result = migrateConfig(roots(repo, plugin), { confirm: true });
    expect(result).toMatchObject({ ok: true, migrated: true });
    expect(readFileSync(path.join(repo, '.agents/flow/config.local.json'), 'utf8')).toBe(
      LEGACY_LOCAL
    );
    expect(readFileSync(path.join(plugin, 'config', MIGRATED_MARKER), 'utf8')).toBe(`${repo}\n`);
  });

  // The cross-project leak, closed: after project A migrates from a shared
  // install, project B finds nothing to inherit and is sent to /flow:init.
  it('gives a second project on a shared install nothing of the first one’s', () => {
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const a = makeRepo('a');
    const b = makeRepo('b');
    expect(migrateConfig(roots(a, plugin), { confirm: true }).migrated).toBe(true);
    expect(resolveConfigFiles(roots(b, plugin))).toMatchObject({
      origin: 'none',
      moved: [{ movedTo: a }],
    });
    expect(migrateConfig(roots(b, plugin), { confirm: true })).toMatchObject({
      migrated: false,
      reason: 'nothing to migrate',
    });
    expect(existsSync(path.join(b, '.agents'))).toBe(false);
  });

  // The old files may still be needed if the move is undone, so they are never
  // removed.
  it('leaves the legacy files in place', () => {
    const { plugin, r } = inProjectSetup();
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
    const { r } = inProjectSetup();
    migrateConfig(r);
    expect(migrateConfig(r)).toMatchObject({ ok: true, migrated: false, wrote: [] });
  });

  // A crash after the local copy and before the committed one leaves the project
  // still reading the legacy pair; the next run finishes the job. Fails if the
  // committed file is written first, or if an identical local file is a conflict.
  it('finishes a migration interrupted between the two files', () => {
    const { repo, r } = inProjectSetup();
    const dir = path.join(repo, '.agents/flow');
    prepareConfigDirs({ committedDir: dir, localDir: dir });
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
    const { repo, r } = inProjectSetup();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, 'config.local.json'), '{"mine":true}\n');
    const result = migrateConfig(r);
    expect(result.ok).toBe(false);
    expect(readFileSync(path.join(dir, 'config.local.json'), 'utf8')).toBe('{"mine":true}\n');
    expect(existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  // Something already at the config.json destination that is not our settings
  // (here a dangling link, which resolve does not count as a config.json) stops
  // the migration; nothing is written through it.
  it('stops when something else occupies the config.json destination', () => {
    const { repo, r } = inProjectSetup({ config: LEGACY_CONFIG });
    const dir = path.join(repo, '.agents/flow');
    mkdirSync(dir, { recursive: true });
    symlinkSync(path.join(base, 'nowhere.json'), path.join(dir, 'config.json'));
    const result = migrateConfig(r);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('nothing was overwritten');
    expect(existsSync(path.join(base, 'nowhere.json'))).toBe(false);
  });

  // When git would still track the local file, no credential and no settings are
  // written. Fails if the prepare verdict is ignored.
  it('writes nothing when git would track the local file', () => {
    const { repo, r } = inProjectSetup();
    const dir = path.join(repo, '.agents/flow');
    write(path.join(dir, '.gitignore'), 'config.local.json\n!config.local.json\n');
    expect(migrateConfig(r).ok).toBe(false);
    expect(existsSync(path.join(dir, 'config.local.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'config.json'))).toBe(false);
  });

  // A broken legacy config.json cannot be carried over faithfully; nothing is
  // written, so /flow:init can start clean.
  it('writes nothing when the legacy config.json is not JSON', () => {
    const { repo, r } = inProjectSetup({ config: '{ nope', local: LEGACY_LOCAL });
    expect(migrateConfig(r).ok).toBe(false);
    expect(existsSync(path.join(repo, '.agents/flow'))).toBe(false);
  });

  // Any $schema that is not a URL (with or without "./") is rewritten; a URL is
  // kept as is.
  it('rewrites a bare relative $schema and keeps a URL', () => {
    const bare = inProjectSetup({ config: '{"$schema":"config.schema.json","tracker":"linear"}' });
    migrateConfig(bare.r);
    expect(
      JSON.parse(readFileSync(path.join(bare.repo, '.agents/flow/config.json'), 'utf8')).$schema
    ).toBe(CONFIG_SCHEMA_URL);
    rmSync(bare.repo, { recursive: true, force: true });
    const url = inProjectSetup({
      config: '{"$schema":"https://example.com/s.json","tracker":"linear"}',
    });
    migrateConfig(url.r);
    expect(
      JSON.parse(readFileSync(path.join(url.repo, '.agents/flow/config.json'), 'utf8')).$schema
    ).toBe('https://example.com/s.json');
  });

  // From a worktree, config.json goes on the branch (where resolve reads it
  // first) and the local file goes to the main checkout; both folders get the
  // .gitignore.
  it('splits the files between the worktree and the main checkout', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const plugin = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const r = findConfigRoots(wt, plugin);
    expect(migrateConfig(r)).toMatchObject({
      ok: true,
      wrote: [
        path.join(repo, '.agents/flow/config.local.json'),
        path.join(wt, '.agents/flow/config.json'),
      ],
    });
    expect(existsSync(path.join(wt, '.agents/flow/.gitignore'))).toBe(true);
    expect(resolveConfigFiles(r)).toMatchObject({
      origin: 'project',
      committed: path.join(wt, '.agents/flow/config.json'),
      local: path.join(repo, '.agents/flow/config.local.json'),
    });
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
  function installCopy(dir: string, files: { config?: string; local?: string } = {}): string {
    const plugin = makePlugin(dir, files);
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

  function run(plugin: string, cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    const res = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(plugin, 'scripts', 'config-files.ts'), ...args],
      { cwd, encoding: 'utf8', env: { ...process.env, ...env } }
    );
    return {
      status: res.status,
      out: res.stdout ? JSON.parse(res.stdout) : null,
      stderr: res.stderr,
    };
  }

  const shared = () => installCopy(path.join(base, 'install'));

  // Not configured is exit 1, so the /flow guard routes to /flow:init.
  it('resolve exits 1 when nothing is configured', () => {
    const repo = makeRepo();
    const { status, out } = run(shared(), repo);
    expect(status).toBe(1);
    expect(out).toMatchObject({ ok: false, origin: 'none', committed: null });
  });

  // A valid project config is ok, with the paths the skills read.
  it('resolve exits 0 with the project files', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.json'), '{"tracker":"linear"}');
    const { status, out } = run(shared(), repo);
    expect(status).toBe(0);
    expect(out).toEqual({
      ok: true,
      origin: 'project',
      committed: path.join(repo, '.agents/flow/config.json'),
      local: null,
      committedDir: path.join(repo, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
      shared: false,
      moved: [],
      errors: [],
      warnings: [],
    });
  });

  // Shared legacy settings still work, and the warning names what they are, so a
  // person can tell whether they are this project's.
  it('resolve describes shared legacy settings in its warning', () => {
    const repo = makeRepo();
    const plugin = installCopy(path.join(base, 'install'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const { status, out } = run(plugin, repo);
    expect(status).toBe(0);
    expect(out).toMatchObject({ origin: 'legacy', shared: true });
    const text = out.warnings.map((w: { message: string }) => w.message).join('\n');
    expect(text).toContain('team ACME');
    expect(text).toContain('migrate --confirm');
    expect(text).not.toContain('tok');
  });

  // validate-config's findings come through unchanged: a wrong value is an
  // error, and credentials in the committed file are a warning.
  it('resolve reports validation errors and the secrets warning', () => {
    const repo = makeRepo();
    write(
      path.join(repo, '.agents/flow/config.json'),
      '{"tracker":"Not A Slug","secrets":{"trackerToken":"x"}}'
    );
    const { status, out } = run(shared(), repo);
    expect(status).toBe(1);
    expect(out.errors.map((e: { path: string }) => e.path)).toEqual(['/tracker']);
    expect(out.warnings.map((w: { path: string }) => w.path)).toEqual(['/secrets']);
  });

  // Broken JSON is an error at the root, not a crash.
  it('resolve reports unreadable JSON as an error', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.json'), '{ nope');
    const { status, out } = run(shared(), repo);
    expect(status).toBe(1);
    expect(out.errors[0].path).toBe('(root)');
  });

  // Team settings that git ignores still work but are not shared; say so.
  it('resolve warns when the committed file is ignored by git', () => {
    const repo = makeRepo();
    write(path.join(repo, '.gitignore'), '.agents/\n');
    write(path.join(repo, '.agents/flow/config.json'), '{}');
    const { status, out } = run(shared(), repo);
    expect(status).toBe(0);
    expect(out.warnings.map((w: { message: string }) => w.message).join('\n')).toContain(
      'ignored by git'
    );
  });

  // The confirmation round trip, end to end: migrate asks, --confirm moves, and
  // --project picks the folder. prepare prints the targets.
  it('migrate asks first, then moves with --confirm; prepare prints targets', () => {
    const repo = makeRepo();
    const plugin = installCopy(path.join(base, 'install'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const asked = run(plugin, base, ['migrate', '--project', repo]);
    expect(asked.status).toBe(0);
    expect(asked.out).toMatchObject({ migrated: false, needsConfirmation: true });
    const moved = run(plugin, base, ['migrate', '--confirm', '--project', repo]);
    expect(moved.out.migrated).toBe(true);
    expect(moved.stderr).not.toContain('tok');
    const prepared = run(plugin, base, ['prepare', '--project', repo]);
    expect(prepared.out).toMatchObject({
      ok: true,
      committed: path.join(repo, '.agents/flow/config.json'),
      local: path.join(repo, '.agents/flow/config.local.json'),
    });
  });

  // The home folder outside git is refused for every command, and nothing is
  // written there.
  it('refuses to act in the home folder', () => {
    const home = path.join(base, 'home');
    mkdirSync(home);
    const { status, out } = run(shared(), home, ['prepare'], { HOME: home, USERPROFILE: home });
    expect(status).toBe(1);
    expect(out.reason).toMatch(/home folder/);
    expect(existsSync(path.join(home, '.agents'))).toBe(false);
  });

  // An unknown subcommand is a usage error, not a silent resolve.
  it('rejects an unknown subcommand', () => {
    const repo = makeRepo();
    expect(run(shared(), repo, ['mirgate']).status).toBe(2);
  });
});
