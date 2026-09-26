/**
 * Contract suite for `scripts/config-files.ts`: where flow finds its settings
 * (DOR-2274). Every case runs against real temporary directories and real `git`,
 * because the rules under test are about real filesystems: which checkout a
 * worktree belongs to, what git ignores, and which files already exist.
 *
 * @see specs/flow-config-location/02-specification.md
 * @see specs/flow-generated-state-location/02-specification.md (adapters and the pause, DOR-2285)
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
  DECLINED_MARKER,
  MIGRATED_MARKER,
  PAUSE_FILE,
  SHIPPED_ADAPTERS,
  findConfigRoots,
  legacyAdapterDirs,
  legacyConfigDirs,
  migrateAdapter,
  migrateAll,
  migrateConfig,
  pauseFlow,
  pauseState,
  prepareConfigDirs,
  refusalFor,
  resolveAdapter,
  resolveConfigFiles,
  resumeFlow,
  trackerOf,
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

  // The other half of never mixing: an old folder with no local file leaves
  // `local` empty even when the project has one of its own.
  it('reports no local file when the old folder has none, whatever the project has', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.local.json'), '{}');
    const plugin = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'), {
      config: LEGACY_CONFIG,
    });
    expect(resolveConfigFiles(roots(repo, plugin))).toMatchObject({
      origin: 'legacy',
      local: null,
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
  const one = (repo: string) => {
    const dir = path.join(repo, '.agents/flow');
    return { dir, files: { committedDir: dir, localDir: dir } };
  };

  // The local file holds credentials, so the folder must make git ignore it,
  // and the temporary copies a write makes, before anything is written there.
  it('creates the folder and a .gitignore that git honours', () => {
    const repo = makeRepo();
    const { dir, files } = one(repo);
    const result = prepareConfigDirs(roots(repo, PLUGIN_DIR), files);
    expect(result).toMatchObject({
      ok: true,
      committed: path.join(dir, 'config.json'),
      local: path.join(dir, 'config.local.json'),
      ignoreFiles: [path.join(dir, '.gitignore')],
    });
    write(path.join(dir, 'config.local.json'), '{}');
    write(path.join(dir, '.config.local.json.1234.tmp'), '{}');
    expect(untracked(repo)).toBe('?? .agents/flow/.gitignore');
  });

  // In a worktree, config.json goes on the branch (a .gitignore travels with it)
  // and the local file goes to the main checkout, which is kept clean: its
  // folder is excluded through the repo's info/exclude, never an untracked
  // .gitignore. Fails if the main checkout gets a .gitignore.
  it('ignores the main checkout’s local file through info/exclude', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const result = prepareConfigDirs(roots(wt, PLUGIN_DIR, repo), {
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
    });
    expect(result.ok).toBe(true);
    expect(result.ignoreFiles).toEqual([
      path.join(wt, '.agents/flow/.gitignore'),
      path.join(repo, '.git/info/exclude'),
    ]);
    write(path.join(wt, '.agents/flow/config.local.json'), '{}');
    write(path.join(repo, '.agents/flow/config.local.json'), '{}');
    write(path.join(repo, '.agents/flow/.config.local.json.99.tmp'), '{}');
    expect(untracked(wt)).toBe('?? .agents/flow/.gitignore');
    expect(untracked(repo)).toBe('');
    expect(existsSync(path.join(repo, '.agents/flow/.gitignore'))).toBe(false);
  });

  // The review's merge case: once the branch's committed .gitignore and
  // config.json land, the main checkout can merge it, because flow left no
  // untracked file there in the way; the local file stays ignored after.
  it('leaves the main checkout free to merge the branch’s settings', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const r = roots(wt, PLUGIN_DIR, repo);
    const prepared = prepareConfigDirs(r, {
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
    });
    prepareConfigDirs(r, {
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
    });
    write(prepared.local, '{"secrets":{}}');
    write(prepared.committed, '{}');
    git(wt, 'add', '.agents');
    git(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'flow');
    git(repo, 'merge', '-q', '--ff-only', 'wt');
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    const exclude = readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').split('\n');
    expect(exclude.filter((l) => l === '/.agents/flow/config.local.json')).toHaveLength(1);
  });

  // An existing .gitignore is someone's file: add the lines once, keep the rest.
  it('appends to an existing .gitignore once, keeping its lines', () => {
    const repo = makeRepo();
    const { dir, files } = one(repo);
    write(path.join(dir, '.gitignore'), 'notes.md');
    prepareConfigDirs(roots(repo, PLUGIN_DIR), files);
    prepareConfigDirs(roots(repo, PLUGIN_DIR), files);
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
    const { dir, files } = one(repo);
    write(path.join(dir, '.gitignore'), 'config.local.json\n!config.local.json\n');
    expect(prepareConfigDirs(roots(repo, PLUGIN_DIR), files).ok).toBe(false);
  });

  // The folder that receives the credentials is the one that must be proven:
  // a "!config.local.json" rule in the main checkout, where the local file goes
  // from a worktree, refuses. Fails if only the worktree's folder is checked.
  it('refuses when the main checkout would track the local file', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    write(path.join(repo, '.agents/flow/.gitignore'), '!config.local.json\n');
    const result = prepareConfigDirs(roots(wt, PLUGIN_DIR, repo), {
      committedDir: path.join(wt, '.agents/flow'),
      localDir: path.join(repo, '.agents/flow'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(path.join(repo, '.agents/flow/config.local.json'));
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
    prepareConfigDirs(r, { committedDir: dir, localDir: dir });
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

  // From a worktree, the credentials go to the main checkout; a rule there that
  // keeps them tracked stops the whole migration before anything is written.
  it('writes nothing from a worktree when the main checkout would track the local file', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    write(path.join(repo, '.agents/flow/.gitignore'), '!config.local.json\n');
    const plugin = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    expect(migrateConfig(findConfigRoots(wt, plugin)).ok).toBe(false);
    expect(existsSync(path.join(repo, '.agents/flow/config.local.json'))).toBe(false);
    expect(existsSync(path.join(wt, '.agents/flow/config.json'))).toBe(false);
  });

  // "Not this project's" is remembered in the old folder: the project never
  // reads those settings, is never asked again (so an abandoned /flow:init does
  // not re-ask on every /flow), and other projects are unaffected.
  it('remembers a decline, for this project only', () => {
    const plugin = makePlugin(path.join(base, 'plugin'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const a = makeRepo('a');
    const b = makeRepo('b');
    expect(migrateConfig(roots(a, plugin), { decline: true })).toMatchObject({
      ok: true,
      migrated: false,
      wrote: [],
    });
    expect(readFileSync(path.join(plugin, 'config', DECLINED_MARKER), 'utf8')).toBe(`${a}\n`);
    expect(resolveConfigFiles(roots(a, plugin)).origin).toBe('none');
    expect(migrateConfig(roots(a, plugin))).toMatchObject({
      needsConfirmation: false,
      reason: 'nothing to migrate',
    });
    expect(existsSync(path.join(a, '.agents'))).toBe(false);
    expect(migrateConfig(roots(b, plugin)).needsConfirmation).toBe(true);
    migrateConfig(roots(b, plugin), { decline: true });
    expect(readFileSync(path.join(plugin, 'config', DECLINED_MARKER), 'utf8')).toBe(`${a}\n${b}\n`);
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

// ---------------------------------------------------------------------------
// DOR-2285: the adapter /flow:init generates, and the pause, live in the project.
// ---------------------------------------------------------------------------

const JIRA_ADAPTER = '---\nname: jira-adapter\ndescription: jira\n---\n\n# jira adapter\n';

/** Write the project's committed settings naming `tracker`. */
function projectConfig(checkout: string, tracker = 'jira'): string {
  return write(path.join(checkout, '.agents/flow/config.json'), JSON.stringify({ tracker }));
}

/** A legacy generated adapter inside a plugin folder, as flow before 0.9.0 wrote it. */
function pluginAdapter(plugin: string, tracker = 'jira', content = JIRA_ADAPTER): string {
  return write(path.join(plugin, 'skills', `${tracker}-adapter`, 'SKILL.md'), content);
}

/** A plugin folder that ships the reference adapter, like a real install. */
function shippingPlugin(dir: string): string {
  makePlugin(dir);
  write(path.join(dir, 'skills', 'linear-adapter', 'SKILL.md'), '# shipped linear\n');
  return dir;
}

describe('trackerOf', () => {
  // The tracker names the adapter, so it must follow the documented precedence:
  // config.local.json over config.json, then the schema default. Fails if the
  // local override is ignored or the default is not the reference tracker.
  it('reads the local file over the committed one, then defaults to linear', () => {
    const repo = makeRepo();
    const committed = projectConfig(repo, 'jira');
    const local = write(path.join(repo, '.agents/flow/config.local.json'), '{"tracker":"github"}');
    expect(trackerOf({ committed, local })).toBe('github');
    expect(trackerOf({ committed, local: null })).toBe('jira');
    write(committed, '{}');
    expect(trackerOf({ committed, local: null })).toBe('linear');
  });

  // The tracker is joined into a path. A value that is not a slug must never
  // get that far, or `../x` would read an adapter from anywhere.
  it('is null for a value that cannot name a folder', () => {
    const repo = makeRepo();
    for (const bad of ['../evil', 'Jira', 'a/b', '', 42]) {
      const committed = write(
        path.join(repo, '.agents/flow/config.json'),
        JSON.stringify({ tracker: bad })
      );
      expect(trackerOf({ committed, local: null }), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('SHIPPED_ADAPTERS', () => {
  // The list decides whether `<flow-root>/skills/<tracker>-adapter/` is flow's
  // own adapter or one an older flow generated there. It must match what this
  // plugin really ships, or a shipped adapter is "migrated" out of the plugin, or
  // a generated one is mistaken for flow's own.
  it('is exactly the adapter skills this plugin ships', () => {
    const shipped = readdirSync(path.join(PLUGIN_DIR, 'skills'))
      .filter((name) => name.endsWith('-adapter'))
      .map((name) => name.slice(0, -'-adapter'.length))
      .sort();
    expect(shipped.length).toBeGreaterThan(0);
    expect([...SHIPPED_ADAPTERS].sort()).toEqual(shipped);
  });
});

describe('legacyAdapterDirs', () => {
  // A shipped adapter is never legacy: it belongs to the plugin, in every
  // version folder. Fails if a cache sibling's linear-adapter is offered.
  it('is empty for a tracker flow ships', () => {
    const flowDir = path.join(base, '.claude', 'plugins', 'cache', 'dork-labs', 'flow');
    const current = shippingPlugin(path.join(flowDir, '0.9.0'));
    shippingPlugin(path.join(flowDir, '0.8.0'));
    expect(legacyAdapterDirs(current, 'linear')).toEqual([]);
  });

  // After a Claude Code update the generated adapter is in the previous version
  // folder; the newest copy is tried first.
  it('lists the plugin’s own folder, then cache siblings newest first', () => {
    const flowDir = path.join(base, '.claude', 'plugins', 'cache', 'dork-labs', 'flow');
    const current = makePlugin(path.join(flowDir, '0.9.0'));
    const older = makePlugin(path.join(flowDir, '0.7.0'));
    const newer = makePlugin(path.join(flowDir, '0.8.0'));
    makePlugin(path.join(flowDir, '0.6.0'));
    const t = Date.now() / 1000;
    utimesSync(pluginAdapter(older), t - 100, t - 100);
    utimesSync(pluginAdapter(newer), t, t);
    expect(legacyAdapterDirs(current, 'jira')).toEqual([
      path.join(current, 'skills', 'jira-adapter'),
      path.join(newer, 'skills', 'jira-adapter'),
      path.join(older, 'skills', 'jira-adapter'),
    ]);
  });
});

describe('resolveAdapter', () => {
  // With no settings there is no tracker, so no adapter to look for.
  it('is none with no tracker when flow is not configured', () => {
    const repo = makeRepo();
    expect(resolveAdapter(roots(repo, shippingPlugin(path.join(base, 'p'))))).toMatchObject({
      tracker: null,
      origin: 'none',
      path: null,
      target: null,
    });
  });

  // The reference adapter needs no copy in the project: it is read from the
  // plugin, and a new version brings its own.
  it('reads a shipped adapter from the plugin', () => {
    const repo = makeRepo();
    const plugin = shippingPlugin(path.join(base, 'p'));
    projectConfig(repo, 'linear');
    expect(resolveAdapter(roots(repo, plugin))).toMatchObject({
      tracker: 'linear',
      origin: 'shipped',
      path: path.join(plugin, 'skills', 'linear-adapter', 'SKILL.md'),
      target: path.join(repo, '.agents/flow/adapters/linear/SKILL.md'),
      shared: false,
    });
  });

  // A broken install that lost its shipped adapter is reported, not papered over
  // with a path that does not exist.
  it('is none when a shipped adapter is missing from the plugin', () => {
    const repo = makeRepo();
    projectConfig(repo, 'linear');
    expect(resolveAdapter(roots(repo, makePlugin(path.join(base, 'p')))).origin).toBe('none');
  });

  // The project's own adapter wins, over a shipped one too, so a team can
  // override the reference adapter on purpose.
  it('prefers the project’s adapter, even over a shipped one', () => {
    const repo = makeRepo();
    const plugin = shippingPlugin(path.join(base, 'p'));
    projectConfig(repo, 'linear');
    const own = write(path.join(repo, '.agents/flow/adapters/linear/SKILL.md'), '# ours\n');
    expect(resolveAdapter(roots(repo, plugin))).toMatchObject({ origin: 'project', path: own });
  });

  // A worktree reads its own branch's adapter first, then the main checkout's.
  it('reads the checkout first, then the main checkout', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const plugin = makePlugin(path.join(base, 'p'));
    projectConfig(repo);
    const mainAdapter = write(path.join(repo, '.agents/flow/adapters/jira/SKILL.md'), 'main');
    expect(resolveAdapter(roots(wt, plugin, repo)).path).toBe(mainAdapter);
    const branchAdapter = write(path.join(wt, '.agents/flow/adapters/jira/SKILL.md'), 'branch');
    expect(resolveAdapter(roots(wt, plugin, repo)).path).toBe(branchAdapter);
  });

  // An adapter an older flow generated into the plugin keeps working until it
  // is moved. One inside the project is the project's; anywhere else it may be
  // another project's.
  it('falls back to a legacy adapter, shared unless the plugin is in the project', () => {
    const repo = makeRepo();
    projectConfig(repo);
    const inside = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'));
    pluginAdapter(inside);
    expect(resolveAdapter(roots(repo, inside))).toMatchObject({
      origin: 'legacy',
      path: path.join(inside, 'skills', 'jira-adapter', 'SKILL.md'),
      target: path.join(repo, '.agents/flow/adapters/jira/SKILL.md'),
      shared: false,
    });
    const outside = makePlugin(path.join(base, 'p'));
    pluginAdapter(outside);
    expect(resolveAdapter(roots(repo, outside))).toMatchObject({ origin: 'legacy', shared: true });
  });

  // A declined adapter is not this project's, so it is not read, but it is
  // remembered as a place a copy could come from. Another project still sees it.
  it('skips an adapter this project declined, and only for this project', () => {
    const repo = makeRepo();
    projectConfig(repo);
    const plugin = makePlugin(path.join(base, 'p'));
    const adapterDir = path.dirname(pluginAdapter(plugin));
    write(path.join(adapterDir, DECLINED_MARKER), `${repo}\n`);
    expect(resolveAdapter(roots(repo, plugin))).toMatchObject({
      origin: 'none',
      declined: [adapterDir],
    });
    const other = makeRepo('other');
    projectConfig(other);
    expect(resolveAdapter(roots(other, plugin))).toMatchObject({ origin: 'legacy', declined: [] });
  });

  // The target sits beside the config.json in use, so a generated adapter is
  // committed with the settings that name it.
  it('targets the folder of the config.json in use', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    projectConfig(repo);
    expect(resolveAdapter(roots(wt, makePlugin(path.join(base, 'p')), repo)).target).toBe(
      path.join(repo, '.agents/flow/adapters/jira/SKILL.md')
    );
  });
});

describe('migrateAdapter', () => {
  /** A project whose settings are already its own, on a plugin inside it holding a legacy adapter. */
  function inProject() {
    const repo = makeRepo();
    projectConfig(repo);
    const plugin = makePlugin(path.join(repo, '.dork', 'plugins', 'flow'));
    const skill = pluginAdapter(plugin);
    write(path.join(path.dirname(skill), 'references', 'mapping.md'), '# mapping\n');
    write(path.join(path.dirname(skill), 'fixture.json'), '[]\n');
    return { repo, plugin, legacy: path.dirname(skill), r: roots(repo, plugin) };
  }

  // The whole folder reaches the project byte for byte, the old one is marked
  // and kept, and the project's copy is what flow reads from then on.
  it('copies the whole adapter folder from a plugin inside the project, without asking', () => {
    const { repo, legacy, r } = inProject();
    const result = migrateAdapter(r);
    const dest = path.join(repo, '.agents/flow/adapters/jira');
    expect(result).toMatchObject({
      ok: true,
      migrated: true,
      needsConfirmation: false,
      from: legacy,
    });
    expect(result.wrote).toEqual([
      path.join(dest, 'fixture.json'),
      path.join(dest, 'references', 'mapping.md'),
      path.join(dest, 'SKILL.md'),
    ]);
    expect(readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe(JIRA_ADAPTER);
    expect(readFileSync(path.join(dest, 'references', 'mapping.md'), 'utf8')).toBe('# mapping\n');
    // An adapter holds no credentials and may serve other projects: never locked.
    expect(existsSync(path.join(legacy, MIGRATED_MARKER))).toBe(false);
    expect(existsSync(path.join(legacy, 'SKILL.md'))).toBe(true);
    expect(resolveAdapter(r)).toMatchObject({
      origin: 'project',
      path: path.join(dest, 'SKILL.md'),
    });
    expect(readdirSync(dest).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Nothing of the adapter is ignored: it is team code, committed.
    expect(untracked(repo)).toContain('.agents/flow/adapters/jira/SKILL.md');
  });

  // A second run finds the project's copy and does nothing.
  it('is a no-op once the adapter is in the project', () => {
    const { r } = inProject();
    migrateAdapter(r);
    expect(migrateAdapter(r)).toMatchObject({
      ok: true,
      migrated: false,
      reason: 'already in the project',
    });
  });

  // A shared plugin folder's adapter may be another project's; nothing moves
  // until a person says it is this one's, and "no" is remembered.
  it('asks before copying from a shared folder; confirm copies, decline is remembered', () => {
    const repo = makeRepo();
    projectConfig(repo);
    const plugin = makePlugin(path.join(base, 'p'));
    const legacy = path.dirname(pluginAdapter(plugin));
    expect(migrateAdapter(roots(repo, plugin))).toMatchObject({
      ok: true,
      migrated: false,
      needsConfirmation: true,
      found: { folder: legacy, tracker: 'jira', name: 'jira-adapter', excerpt: '# jira adapter' },
      wrote: [],
    });
    expect(existsSync(path.join(repo, '.agents/flow/adapters'))).toBe(false);

    const other = makeRepo('other');
    projectConfig(other);
    expect(migrateAdapter(roots(other, plugin), { decline: true })).toMatchObject({
      ok: true,
      migrated: false,
    });
    expect(readFileSync(path.join(legacy, DECLINED_MARKER), 'utf8')).toBe(`${other}\n`);
    expect(resolveAdapter(roots(other, plugin)).origin).toBe('none');

    expect(migrateAdapter(roots(repo, plugin), { confirm: true }).migrated).toBe(true);
    expect(readFileSync(path.join(repo, '.agents/flow/adapters/jira/SKILL.md'), 'utf8')).toBe(
      JIRA_ADAPTER
    );
    // The other project's "not mine" stays with the old folder; it is not this
    // project's file and must not be committed into it.
    expect(existsSync(path.join(repo, '.agents/flow/adapters/jira', DECLINED_MARKER))).toBe(false);
  });

  // The review's lock-out case: on a shared install, the first project to
  // confirm must not take the adapter away from the others. A third project is
  // still offered it, and can confirm it for itself.
  it('keeps a shared adapter available to every project after one confirms', () => {
    const plugin = makePlugin(path.join(base, 'p'));
    pluginAdapter(plugin);
    const a = makeRepo('a');
    const b = makeRepo('b');
    projectConfig(a);
    projectConfig(b);
    expect(migrateAdapter(roots(a, plugin), { confirm: true }).migrated).toBe(true);
    expect(resolveAdapter(roots(b, plugin))).toMatchObject({ origin: 'legacy', shared: true });
    expect(migrateAdapter(roots(b, plugin)).needsConfirmation).toBe(true);
    expect(migrateAdapter(roots(b, plugin), { confirm: true }).migrated).toBe(true);
    expect(resolveAdapter(roots(b, plugin)).origin).toBe('project');
  });

  // The excerpt a person is shown is the adapter's own opening lines, never
  // the frontmatter, and at most a few of them.
  it('summarises an adapter by its name and first lines', () => {
    const repo = makeRepo();
    projectConfig(repo);
    const plugin = makePlugin(path.join(base, 'p'));
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n\n');
    pluginAdapter(plugin, 'jira', `---\nname: acme-jira\ndescription: x\n---\n\n${body}\n`);
    const { found } = migrateAdapter(roots(repo, plugin));
    expect(found).toMatchObject({ name: 'acme-jira' });
    expect(found?.excerpt).toBe(
      ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n')
    );
  });

  // A different adapter already in the project is never overwritten.
  it('stops without overwriting a different adapter already in the project', () => {
    const { repo, legacy, r } = inProject();
    const existing = write(path.join(repo, '.agents/flow/adapters/jira/fixture.json'), '[1]\n');
    const result = migrateAdapter(r);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(existing);
    expect(readFileSync(existing, 'utf8')).toBe('[1]\n');
    expect(existsSync(path.join(repo, '.agents/flow/adapters/jira/SKILL.md'))).toBe(false);
  });

  // A symlink in the old folder could point anywhere on the machine; it is not
  // followed, so nothing outside the adapter folder is copied into the project.
  it('does not follow a symlink out of the adapter folder', () => {
    const { repo, legacy, r } = inProject();
    const secret = write(path.join(base, 'secret.txt'), 'secret');
    symlinkSync(secret, path.join(legacy, 'link.txt'));
    migrateAdapter(r);
    expect(existsSync(path.join(repo, '.agents/flow/adapters/jira/link.txt'))).toBe(false);
  });

  // A shipped adapter stays in the plugin; nothing to move.
  it('leaves a shipped adapter alone', () => {
    const repo = makeRepo();
    projectConfig(repo, 'linear');
    const plugin = shippingPlugin(path.join(repo, '.dork', 'plugins', 'flow'));
    expect(migrateAdapter(roots(repo, plugin))).toMatchObject({
      migrated: false,
      reason: 'flow ships this adapter',
    });
    expect(existsSync(path.join(repo, '.agents/flow/adapters'))).toBe(false);
  });
});

describe('migrateAll', () => {
  // Settings already in the project, adapter still in a shared folder: the
  // top-level answer must still say a person has to confirm, and a stopped
  // adapter copy must still make the whole migration not ok. Fails if either
  // top-level field looks at the settings half alone.
  it('reports the adapter half at the top level', () => {
    const repo = makeRepo();
    projectConfig(repo);
    const plugin = makePlugin(path.join(base, 'p'));
    pluginAdapter(plugin);
    expect(migrateAll(roots(repo, plugin))).toMatchObject({
      ok: true,
      needsConfirmation: true,
      reason: 'already in the project',
    });
    write(path.join(repo, '.agents/flow/adapters/jira/extra.md'), 'x');
    write(path.join(path.dirname(pluginAdapter(plugin)), 'extra.md'), 'y');
    expect(migrateAll(roots(repo, plugin), { confirm: true })).toMatchObject({
      ok: false,
      adapter: { ok: false },
    });
  });

  /** Settings and a generated adapter, both still in a shared plugin folder. */
  function sharedLegacy() {
    const repo = makeRepo();
    const plugin = makePlugin(path.join(base, 'p'), {
      config: `${JSON.stringify({ tracker: 'jira' })}\n`,
      local: LEGACY_LOCAL,
    });
    const legacy = path.dirname(pluginAdapter(plugin));
    return { repo, plugin, legacy, r: roots(repo, plugin) };
  }

  // One question covers both: nothing moves until a person confirms.
  it('asks once for settings and adapter from a shared folder', () => {
    const { repo, r } = sharedLegacy();
    const result = migrateAll(r);
    expect(result).toMatchObject({ ok: true, needsConfirmation: true, migrated: false });
    expect(result.adapter).toMatchObject({ needsConfirmation: true, found: { tracker: 'jira' } });
    expect(existsSync(path.join(repo, '.agents'))).toBe(false);
  });

  // Yes moves both, the adapter beside the settings.
  it('moves both on confirm', () => {
    const { repo, r } = sharedLegacy();
    const result = migrateAll(r, { confirm: true });
    expect(result).toMatchObject({ ok: true, migrated: true, needsConfirmation: false });
    expect(result.adapter.migrated).toBe(true);
    expect(resolveAdapter(r)).toMatchObject({
      origin: 'project',
      path: path.join(repo, '.agents/flow/adapters/jira/SKILL.md'),
    });
  });

  // No declines both, so neither /flow nor a fresh /flow:init asks about the
  // old adapter again. Fails if the settings decline hides the adapter before
  // it is declined too.
  it('declines both on decline', () => {
    const { repo, legacy, plugin, r } = sharedLegacy();
    migrateAll(r, { decline: true });
    expect(readFileSync(path.join(legacy, DECLINED_MARKER), 'utf8')).toBe(`${repo}\n`);
    expect(readFileSync(path.join(plugin, 'config', DECLINED_MARKER), 'utf8')).toBe(`${repo}\n`);
    projectConfig(repo);
    expect(resolveAdapter(r).origin).toBe('none');
  });
});

describe('pause', () => {
  // The pause is one machine's decision about the autonomy running there. It
  // lives beside the local settings, in the main checkout, so the scheduler's
  // checkout and every worktree see one flag. Fails if it lands in the worktree.
  it('writes the flag into the main checkout from a worktree, where both see it', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const plugin = makePlugin(path.join(base, 'p'));
    const now = new Date('2026-09-23T12:00:00.000Z');
    const result = pauseFlow(roots(wt, plugin, repo), now);
    const file = path.join(repo, '.agents/flow', PAUSE_FILE);
    expect(result).toMatchObject({ ok: true, file, alreadyPaused: false, ignored: true });
    const expected = { file, pausedAt: '2026-09-23T12:00:00.000Z', hostSchedules: [] };
    expect(pauseState(roots(wt, plugin, repo))).toEqual(expected);
    expect(pauseState(roots(repo, plugin))).toEqual(expected);
    expect(untracked(repo)).toBe('');
  });

  // The review's repro: a worktree with its own config.local.json used to get
  // its own flag, which the main checkout (where the scheduler runs) never saw,
  // and a resume there removed nothing. The flag belongs to the project.
  it('uses the main checkout even when the worktree has its own local settings', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    write(path.join(wt, '.agents/flow/config.json'), '{}');
    write(path.join(wt, '.agents/flow/config.local.json'), '{}');
    const plugin = makePlugin(path.join(base, 'p'));
    const w = roots(wt, plugin, repo);
    const m = roots(repo, plugin);
    pauseFlow(w);
    expect(pauseState(m)?.file).toBe(path.join(repo, '.agents/flow', PAUSE_FILE));
    expect(existsSync(path.join(wt, '.agents/flow', PAUSE_FILE))).toBe(false);
    expect(resumeFlow(m).wasPaused).toBe(true);
    expect(pauseState(w)).toBeNull();
  });

  // Host schedule rows the pause switched off are recorded, merged across
  // calls without duplicates, and handed back by resume, so exactly those are
  // switched back on.
  it('records host schedules and hands them back on resume', () => {
    const repo = makeRepo();
    const r = roots(repo, makePlugin(path.join(base, 'p')));
    pauseFlow(r);
    expect(pauseFlow(r, new Date(), ['s1', 's2']).hostSchedules).toEqual(['s1', 's2']);
    expect(pauseFlow(r, new Date(), ['s2', 's3']).hostSchedules).toEqual(['s1', 's2', 's3']);
    expect(pauseState(r)?.hostSchedules).toEqual(['s1', 's2', 's3']);
    expect(resumeFlow(r).hostSchedules).toEqual(['s1', 's2', 's3']);
    expect(resumeFlow(r)).toEqual({ ok: true, wasPaused: false, removed: [], hostSchedules: [] });
  });

  // An install set up by flow 0.8.0 has a .gitignore without the pause line;
  // pausing adds it rather than leaving the flag to be committed.
  it('keeps the flag out of git in a folder an older flow prepared', () => {
    const repo = makeRepo();
    write(
      path.join(repo, '.agents/flow/.gitignore'),
      'config.local.json\n.config.local.json.*.tmp\n'
    );
    projectConfig(repo);
    expect(pauseFlow(roots(repo, makePlugin(path.join(base, 'p')))).ignored).toBe(true);
    expect(untracked(repo)).not.toContain(PAUSE_FILE);
  });

  // Pausing twice keeps the first time, so "paused since" stays true.
  it('is idempotent and keeps when it started', () => {
    const repo = makeRepo();
    const r = roots(repo, makePlugin(path.join(base, 'p')));
    pauseFlow(r, new Date('2026-01-01T00:00:00.000Z'));
    expect(pauseFlow(r, new Date('2026-02-02T00:00:00.000Z'))).toMatchObject({
      alreadyPaused: true,
      pausedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  // A flag nobody can read is still a pause: when in doubt, autonomy stays off.
  it('treats an unreadable flag as paused', () => {
    const repo = makeRepo();
    const file = write(path.join(repo, '.agents/flow', PAUSE_FILE), 'not json');
    expect(pauseState(roots(repo, makePlugin(path.join(base, 'p'))))).toEqual({
      file,
      pausedAt: null,
      hostSchedules: [],
    });
  });

  // A hand-edited flag may hold junk ids. Only non-empty strings are schedule
  // ids; anything else would make resume call the host with nonsense.
  it('reads only non-empty string ids from a hand-edited flag', () => {
    const repo = makeRepo();
    write(
      path.join(repo, '.agents/flow', PAUSE_FILE),
      JSON.stringify({ pausedAt: 'x', hostSchedules: ['', 3, 'ok', null] })
    );
    const r = roots(repo, makePlugin(path.join(base, 'p')));
    expect(pauseState(r)?.hostSchedules).toEqual(['ok']);
    expect(resumeFlow(r).hostSchedules).toEqual(['ok']);
  });

  // Resume from a worktree lifts the project's one flag.
  it('resume from a worktree removes the main checkout’s flag', () => {
    const repo = makeRepo();
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'wt');
    const r = roots(wt, makePlugin(path.join(base, 'p')), repo);
    pauseFlow(r);
    expect(resumeFlow(r)).toEqual({
      ok: true,
      wasPaused: true,
      removed: [path.join(repo, '.agents/flow', PAUSE_FILE)],
      hostSchedules: [],
    });
    expect(pauseState(r)).toBeNull();
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
    for (const name of ['config-files.ts', 'validate-config.ts', '_shared.ts', 'git-exclude.ts']) {
      copyFileSync(path.join(PLUGIN_DIR, 'scripts', name), path.join(plugin, 'scripts', name));
    }
    copyFileSync(
      path.join(PLUGIN_DIR, 'config', 'config.schema.json'),
      path.join(plugin, 'config', 'config.schema.json')
    );
    write(path.join(plugin, 'skills', 'linear-adapter', 'SKILL.md'), '# shipped linear\n');
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
    const plugin = shared();
    const { status, out } = run(plugin, repo);
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
      flowRoot: plugin,
      adapter: {
        tracker: 'linear',
        origin: 'shipped',
        path: path.join(plugin, 'skills', 'linear-adapter', 'SKILL.md'),
        target: path.join(repo, '.agents/flow/adapters/linear/SKILL.md'),
        shared: false,
        declined: [],
      },
      paused: null,
      journal: { path: path.join(repo, '.dork/flow/journal.jsonl'), enabled: true },
      errors: [],
      warnings: [],
    });
  });

  // A tracker with no adapter anywhere is not configured: /flow routes to
  // /flow:init, which generates one. Fails if resolve says ok with nothing to read.
  it('resolve refuses a tracker with no adapter', () => {
    const repo = makeRepo();
    projectConfig(repo, 'jira');
    const { status, out } = run(shared(), repo);
    expect(status).toBe(1);
    expect(out.adapter).toMatchObject({ origin: 'none', path: null });
    expect(out.errors).toEqual([
      {
        path: '(adapter)',
        message: `no adapter for tracker "jira"; run /flow:init to generate one into ${path.join(repo, '.agents/flow/adapters/jira')}`,
      },
    ]);
  });

  // Fail closed, as for settings: an adapter nobody confirmed may be another
  // project's, so a headless run stops. One inside the project still works,
  // with a nudge to move it.
  it('resolve refuses a shared legacy adapter and warns about an in-project one', () => {
    const repo = makeRepo();
    projectConfig(repo, 'jira');
    const outside = shared();
    pluginAdapter(outside);
    const refused = run(outside, repo);
    expect(refused.status).toBe(1);
    expect(refused.out.errors.map((e: { message: string }) => e.message).join('\n')).toContain(
      'may belong to another project; run /flow in this project to confirm'
    );
    const inside = installCopy(path.join(repo, '.dork', 'plugins', 'flow'));
    pluginAdapter(inside);
    const accepted = run(inside, repo);
    expect(accepted.status).toBe(0);
    expect(accepted.out.adapter).toMatchObject({ origin: 'legacy', shared: false });
    expect(accepted.out.warnings.map((w: { message: string }) => w.message).join('\n')).toContain(
      'run config-files.ts migrate'
    );
  });

  // migrate carries the adapter too, under the same one confirmation.
  it('migrate moves a legacy adapter with the settings, after one confirmation', () => {
    const repo = makeRepo();
    const plugin = installCopy(path.join(base, 'install'), {
      config: `${JSON.stringify({ tracker: 'jira' })}\n`,
    });
    pluginAdapter(plugin);
    const asked = run(plugin, repo, ['migrate']);
    expect(asked.status).toBe(0);
    expect(asked.out).toMatchObject({
      needsConfirmation: true,
      adapter: { needsConfirmation: true, found: { tracker: 'jira' } },
    });
    const moved = run(plugin, repo, ['migrate', '--confirm']);
    expect(moved.status).toBe(0);
    expect(moved.out).toMatchObject({ migrated: true, adapter: { migrated: true } });
    const resolved = run(plugin, repo);
    expect(resolved.status).toBe(0);
    expect(resolved.out.adapter).toMatchObject({
      origin: 'project',
      path: path.join(repo, '.agents/flow/adapters/jira/SKILL.md'),
    });
  });

  // Settings already moved, adapter still shared: migrate must ask, at the top
  // level the /flow guard reads, and show the adapter's opening lines.
  it('migrate asks about a shared adapter when the settings are already in the project', () => {
    const repo = makeRepo();
    projectConfig(repo, 'jira');
    const plugin = shared();
    pluginAdapter(plugin);
    const asked = run(plugin, repo, ['migrate']);
    expect(asked.status).toBe(0);
    expect(asked.out).toMatchObject({ ok: true, needsConfirmation: true });
    expect(asked.stderr).toContain('# jira adapter');
    const declined = run(plugin, repo, ['migrate', '--decline']);
    expect(declined.status).toBe(0);
    const resolved = run(plugin, repo);
    expect(resolved.status).toBe(1);
    expect(resolved.out.errors[0].message).toContain(
      `if the one in ${path.join(plugin, 'skills', 'jira-adapter')} is this project's after all`
    );
  });

  // --host-schedule only makes sense with pause; elsewhere it is a usage error.
  it('pause records --host-schedule ids; other commands refuse the flag', () => {
    const repo = makeRepo();
    const plugin = shared();
    const paused = run(plugin, repo, ['pause', '--host-schedule', 'a', '--host-schedule', 'b']);
    expect(paused.out.hostSchedules).toEqual(['a', 'b']);
    expect(run(plugin, repo, ['resume']).out.hostSchedules).toEqual(['a', 'b']);
    expect(run(plugin, repo, ['resolve', '--host-schedule', 'a']).status).toBe(2);
  });

  // pause and resume round trip through resolve, which reports the flag without
  // failing: being paused is state each caller acts on, not a broken setup.
  it('pause and resume round trip, and resolve reports the pause', () => {
    const repo = makeRepo();
    write(path.join(repo, '.agents/flow/config.json'), '{"tracker":"linear"}');
    const plugin = shared();
    const paused = run(plugin, repo, ['pause']);
    expect(paused.status).toBe(0);
    expect(paused.out).toMatchObject({ ok: true, alreadyPaused: false, ignored: true });
    const resolved = run(plugin, repo);
    expect(resolved.status).toBe(0);
    expect(resolved.out.paused).toMatchObject({
      file: path.join(repo, '.agents/flow', PAUSE_FILE),
    });
    expect(run(plugin, repo, ['resume']).out).toMatchObject({ ok: true, wasPaused: true });
    expect(run(plugin, repo).out.paused).toBeNull();
  });

  // A pause is a safety control: it works before flow is configured.
  it('pause works when flow is not configured', () => {
    const repo = makeRepo();
    const { status, out } = run(shared(), repo, ['pause']);
    expect(status).toBe(0);
    expect(out.file).toBe(path.join(repo, '.agents/flow', PAUSE_FILE));
  });

  // Fail closed: settings nobody has confirmed are this project's must not drive
  // it, so a headless run (a scheduled tick) stops with a plain reason instead
  // of claiming another project's work. The reason names what was found, never
  // a credential.
  it('resolve refuses shared legacy settings nobody confirmed', () => {
    const repo = makeRepo();
    const plugin = installCopy(path.join(base, 'install'), {
      config: LEGACY_CONFIG,
      local: LEGACY_LOCAL,
    });
    const { status, out } = run(plugin, repo);
    expect(status).toBe(1);
    expect(out).toMatchObject({ ok: false, origin: 'legacy', shared: true });
    const text = out.errors.map((e: { message: string }) => e.message).join('\n');
    expect(text).toContain('may belong to another project; run /flow in this project to confirm');
    expect(text).toContain('team ACME');
    expect(text).not.toContain('tok');
  });

  // A plugin inside the project (DorkOS project scope) is that project's: its
  // legacy settings still work before they are moved, with a nudge to move them.
  it('resolve accepts legacy settings from a plugin inside the project', () => {
    const repo = makeRepo();
    const plugin = installCopy(path.join(repo, '.dork', 'plugins', 'flow'), {
      config: LEGACY_CONFIG,
    });
    const { status, out } = run(plugin, repo);
    expect(status).toBe(0);
    expect(out).toMatchObject({ ok: true, origin: 'legacy', shared: false, errors: [] });
    expect(out.warnings.map((w: { message: string }) => w.message).join('\n')).toContain(
      'run config-files.ts migrate'
    );
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
    expect(run(plugin, base, ['migrate', '--confirm', '--decline']).status).toBe(2);
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
