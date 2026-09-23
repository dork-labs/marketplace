/**
 * Where flow's settings live, and the one place that knows it (DOR-2274).
 *
 * flow keeps two settings files in the project it runs in, never inside the
 * installed plugin:
 *
 * - `.agents/flow/config.json`: team policy, committed with the project.
 * - `.agents/flow/config.local.json`: this machine's credentials and overrides,
 *   kept out of git by a `.agents/flow/.gitignore` flow writes.
 *
 * They used to live in `<flow-root>/config/`, inside the plugin. A host that
 * installs each plugin version into its own folder (Claude Code's plugin cache)
 * leaves them behind on every update. The project is the one place every host
 * keeps, that team policy can be committed to, and that a script run from a skill
 * can find without a host variable. `${CLAUDE_PLUGIN_DATA}` is none of those: in
 * Claude Code it is one folder per user for every project, it is not in the repo,
 * and the Bash tool does not see it.
 *
 * The first `config.json` found wins:
 *
 * 1. The project: the current checkout's `.agents/flow/`, then the main checkout's
 *    when this is a linked git worktree. `config.local.json` is looked up the
 *    same way, independently.
 * 2. Legacy, only while the project has no `config.json`: the plugin's own
 *    `config/` folder, then, when the plugin sits in Claude Code's cache, the
 *    other version folders beside it, newest settings first. Both files come from
 *    one folder, never mixed. A folder whose settings were already moved to a
 *    project (it holds a {@link MIGRATED_MARKER}) is skipped.
 * 3. None: flow is not configured yet.
 *
 * Where files are written: `config.json` (and its `.gitignore`) next to the
 * `config.json` in use, or in the current checkout for a fresh setup;
 * `config.local.json` next to the one in use, or in the main checkout, where every
 * worktree of the project finds it.
 *
 * `migrateConfig` copies legacy settings into the project. A plugin folder inside
 * this project (a DorkOS project-scope install) belongs to it, so its settings
 * are copied without asking. A folder anywhere else may be shared by several
 * projects, so its settings are only copied once a person confirms they are this
 * project's. Nothing is ever overwritten or deleted; after a migration the old
 * folder gets a {@link MIGRATED_MARKER} naming the project, so no other project
 * silently inherits those settings.
 *
 * Like `validate-config.ts`, this imports nothing outside Node, so it runs before
 * `npm install`.
 *
 * @module @dorkos/flow/cli/config-files
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { invokedDirectly, isPlainObject } from './_shared.ts';
import { validateConfig, type ValidationIssue } from './validate-config.ts';

/** The project folder, relative to a checkout, that holds flow's settings. */
export const PROJECT_CONFIG_DIR = '.agents/flow';
/** The committed team-policy file. */
export const CONFIG_FILE = 'config.json';
/** The per-machine file: credentials and overrides, never committed. */
export const LOCAL_CONFIG_FILE = 'config.local.json';
/**
 * The file a migration leaves in the old plugin `config/` folder, holding the
 * path of the project the settings moved to. A folder carrying it is never read
 * again, so a second project on the same install is not handed the first one's
 * settings.
 */
export const MIGRATED_MARKER = 'MIGRATED_TO';
/**
 * The `$schema` a project's `config.json` points at. A relative path to the
 * plugin cannot resolve from the project, and an absolute one would name one
 * machine's install folder in a committed file.
 */
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/plugins/flow/config/config.schema.json';

/**
 * What the flow-written `.gitignore` must hold: the local file, and the
 * temporary copies of it a write makes before linking it into place.
 */
const GITIGNORE_LINES = [LOCAL_CONFIG_FILE, `.${LOCAL_CONFIG_FILE}.*.tmp`] as const;
const GITIGNORE_HEADER = "# flow: this machine's settings and credentials. Never commit them.\n";

/** Link errors that mean "this filesystem has no hard links" (exFAT, FAT, some network mounts). */
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EPERM', 'ENOSYS']);

/** The folders flow's settings are looked up from. */
export interface ConfigRoots {
  /** The checkout flow runs in: the git top level, or the folder itself outside git. */
  checkout: string;
  /** The main checkout when `checkout` is a linked git worktree, else `null`. */
  mainCheckout: string | null;
  /** Whether `checkout` is inside a git repo. */
  inGit: boolean;
  /** The installed flow plugin's root folder (`<flow-root>`). */
  pluginRoot: string;
}

/** Where the settings in use came from. */
export type ConfigOrigin = 'project' | 'legacy' | 'none';

/** A legacy folder skipped because its settings were moved to a project. */
export interface MovedSettings {
  /** The old plugin `config/` folder. */
  folder: string;
  /** The project its settings were moved to. */
  movedTo: string;
}

/** The settings files flow reads, and where the project's own files belong. */
export interface ConfigFiles {
  /** Which kind of place the files below were found in. */
  origin: ConfigOrigin;
  /** Absolute path of the `config.json` in use, or `null` when not configured. */
  committed: string | null;
  /** Absolute path of the `config.local.json` in use, or `null` when there is none. */
  local: string | null;
  /** The folder the project's `config.json` is in, or will be written to. */
  committedDir: string;
  /** The folder the project's `config.local.json` is in, or will be written to. */
  localDir: string;
  /**
   * Origin `legacy` from a plugin folder outside this project: it may belong to
   * another project, so it is only migrated once a person confirms.
   */
  shared: boolean;
  /** Legacy folders skipped because their settings belong to another project now. */
  moved: MovedSettings[];
}

/** The outcome of preparing the project folders for settings. */
export interface PrepareResult {
  /** `false` when git would still track a local file, so nothing secret may be written. */
  ok: boolean;
  /** Where the project's `config.json` goes. */
  committed: string;
  /** Where the project's `config.local.json` goes. */
  local: string;
  /** The `.gitignore` files that keep the local file out of git. */
  gitignores: string[];
  /** Why `ok` is false. */
  reason?: string;
}

/** Non-secret facts about a set of settings, shown to a person before moving them. */
export interface SettingsSummary {
  /** The plugin `config/` folder the settings are in. */
  folder: string;
  /** The configured tracker adapter. */
  tracker: string | null;
  /** The tracker team key. */
  team: string | null;
  /** The tracker workspace slug. */
  workspace: string | null;
}

/** The outcome of copying legacy settings into the project. */
export interface MigrationResult {
  /** `false` when the migration stopped; nothing was overwritten or deleted. */
  ok: boolean;
  /** Whether this call completed a migration from the plugin folder. */
  migrated: boolean;
  /**
   * The settings sit in a plugin folder outside this project and were not
   * copied: a person must confirm they are this project's (`--confirm`).
   */
  needsConfirmation: boolean;
  /** What was found in the legacy folder, when there was one. */
  found: SettingsSummary | null;
  /** The legacy folder the settings came from, or `null`. */
  from: string | null;
  /** Project files this call created. */
  wrote: string[];
  /** Project files that already held the same settings. */
  unchanged: string[];
  /** Legacy files left where they were (they are never deleted). */
  leftInPlace: string[];
  /** A plain explanation of the outcome. */
  reason: string;
}

/** Run git in `cwd`, returning trimmed stdout, or `null` when it fails. */
function gitOutput(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether git ignores `file`. `false` outside a git repo, and for a file git
 * already tracks (exclude rules do not apply to it).
 */
function gitIgnores(file: string): boolean {
  const res = spawnSync(
    'git',
    ['-C', path.dirname(file), 'check-ignore', '-q', path.basename(file)],
    { stdio: 'ignore' }
  );
  return res.status === 0;
}

/** Whether `dir` is inside a git work tree. */
function inGitRepo(dir: string): boolean {
  return gitOutput(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The file's bytes, or `null` when it cannot be read as a file. */
function readOrNull(file: string): Buffer | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/** Parse JSON, or `undefined` when it is not JSON. */
function parseOrUndefined(bytes: Buffer | null): unknown {
  if (bytes === null) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Whether `child` is `parent` or inside it. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A path with symlinks resolved when it exists, so containment checks compare like with like. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Find the checkout flow runs in and, for a linked worktree, the main checkout.
 *
 * @param cwd - The folder flow was started from.
 * @param pluginRoot - The installed flow plugin's root folder.
 * @returns The roots settings are looked up from.
 */
export function findConfigRoots(cwd: string, pluginRoot: string): ConfigRoots {
  const top = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) {
    return { checkout: path.resolve(cwd), mainCheckout: null, inGit: false, pluginRoot };
  }
  const checkout = path.resolve(top);
  // A linked worktree's common git dir is `<main checkout>/.git`. A bare repo or
  // a submodule has some other common dir and no main checkout to fall back to.
  const common = gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let mainCheckout: string | null = null;
  if (common !== null && path.basename(common) === '.git') {
    const main = path.dirname(path.resolve(common));
    if (main !== checkout) mainCheckout = main;
  }
  return { checkout, mainCheckout, inGit: true, pluginRoot };
}

/**
 * Why flow must not act for these roots, or `null` when it may. Outside git,
 * flow's project is the folder it started in; when that is the home folder, the
 * settings would land in `~/.agents/flow/` and apply to every folder beneath it.
 *
 * @param roots - The roots flow would act for.
 * @returns A plain reason to refuse, or `null`.
 */
export function refusalFor(roots: ConfigRoots): string | null {
  if (!roots.inGit && real(roots.checkout) === real(os.homedir())) {
    return 'flow was started in your home folder, which is not a project; start it inside a project folder';
  }
  return null;
}

/**
 * The plugin folders legacy settings may be in, most likely first: the plugin's
 * own `config/`, then, when the plugin sits in Claude Code's cache
 * (`…/plugins/cache/<marketplace>/<plugin>/<version>`), the `config/` of each
 * other version folder that holds a `config.json`, newest first. An update
 * installs into a new version folder, so this is how the first run after one
 * finds the settings the previous version kept.
 *
 * @param pluginRoot - The installed flow plugin's root folder.
 * @returns Candidate legacy `config/` folders, in the order to try them.
 */
export function legacyConfigDirs(pluginRoot: string): string[] {
  const own = path.join(pluginRoot, 'config');
  const segments = path.resolve(pluginRoot).split(path.sep);
  const n = segments.length;
  if (n < 5 || segments[n - 4] !== 'cache' || segments[n - 5] !== 'plugins') return [own];

  const versionsDir = path.dirname(pluginRoot);
  const self = path.basename(pluginRoot);
  const siblings = readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== self)
    .map((entry) => path.join(versionsDir, entry.name, 'config'))
    .filter((dir) => isFile(path.join(dir, CONFIG_FILE)))
    .map((dir) => ({ dir, mtime: statSync(path.join(dir, CONFIG_FILE)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ dir }) => dir);
  return [own, ...siblings];
}

/** The project a legacy folder's settings were moved to, or `null`. */
function movedTo(dir: string): string | null {
  const marker = readOrNull(path.join(dir, MIGRATED_MARKER));
  if (marker === null) return null;
  return marker.toString('utf8').trim() || '(unknown project)';
}

/**
 * Decide which settings files flow reads, and where the project's files belong
 * (see the module doc).
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @returns The files in use and their folders.
 */
export function resolveConfigFiles(roots: ConfigRoots): ConfigFiles {
  const checkoutDir = path.join(roots.checkout, PROJECT_CONFIG_DIR);
  const mainDir =
    roots.mainCheckout === null ? null : path.join(roots.mainCheckout, PROJECT_CONFIG_DIR);
  const projectDirs = mainDir === null ? [checkoutDir] : [checkoutDir, mainDir];
  const first = (name: string) =>
    projectDirs.map((dir) => path.join(dir, name)).find(isFile) ?? null;

  const committed = first(CONFIG_FILE);
  const projectLocal = first(LOCAL_CONFIG_FILE);
  const committedDir = committed === null ? checkoutDir : path.dirname(committed);
  const localDir = projectLocal === null ? (mainDir ?? checkoutDir) : path.dirname(projectLocal);
  const base = { committedDir, localDir, shared: false, moved: [] as MovedSettings[] };

  if (committed !== null) {
    return { origin: 'project', committed, local: projectLocal, ...base };
  }
  for (const dir of legacyConfigDirs(roots.pluginRoot)) {
    const legacy = path.join(dir, CONFIG_FILE);
    if (!isFile(legacy)) continue;
    const moved = movedTo(dir);
    if (moved !== null) {
      base.moved.push({ folder: dir, movedTo: moved });
      continue;
    }
    const local = path.join(dir, LOCAL_CONFIG_FILE);
    const inProject = [roots.checkout, roots.mainCheckout]
      .filter((root): root is string => root !== null)
      .some((root) => isWithin(real(dir), real(root)));
    return {
      origin: 'legacy',
      committed: legacy,
      local: isFile(local) ? local : null,
      ...base,
      shared: !inProject,
    };
  }
  return { origin: 'none', committed: null, local: null, ...base };
}

/** Make `dir/.gitignore` hold every {@link GITIGNORE_LINES} entry, keeping its other lines. */
function ensureGitignore(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  const text = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : null;
  const present = new Set((text ?? '').split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (text === null) {
    writeFileSync(gitignore, `${GITIGNORE_HEADER}${missing.join('\n')}\n`);
  } else if (missing.length > 0) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    writeFileSync(gitignore, `${text}${separator}${missing.join('\n')}\n`);
  }
  return gitignore;
}

/**
 * Make the project ready for settings: in the folder `config.json` goes in and
 * the folder `config.local.json` goes in, create the folder and a `.gitignore`
 * that keeps the local file out of git (created, or the lines appended), then ask
 * git to prove the local file would be ignored in each. Safe to repeat.
 *
 * @param files - The resolved files, whose `committedDir` and `localDir` are prepared.
 * @returns The paths to write, and `ok: false` when git would still track a local file.
 */
export function prepareConfigDirs(
  files: Pick<ConfigFiles, 'committedDir' | 'localDir'>
): PrepareResult {
  const dirs = [...new Set([files.committedDir, files.localDir])];
  const gitignores = dirs.map(ensureGitignore);
  const result = {
    committed: path.join(files.committedDir, CONFIG_FILE),
    local: path.join(files.localDir, LOCAL_CONFIG_FILE),
    gitignores,
  };
  // The line alone proves nothing: a negation rule, or a copy git already
  // tracks, keeps the file in git. Only git's own answer counts.
  const tracked = dirs
    .map((dir) => path.join(dir, LOCAL_CONFIG_FILE))
    .find((local) => inGitRepo(path.dirname(local)) && !gitIgnores(local));
  if (tracked !== undefined) {
    return {
      ok: false,
      ...result,
      reason: `git would still track ${tracked} (check for a "!${LOCAL_CONFIG_FILE}" rule, or a copy already committed), so flow will not put credentials there`,
    };
  }
  return { ok: true, ...result };
}

type Placement = 'wrote' | 'unchanged' | 'conflict';

/**
 * Put `bytes` at `dest` without ever replacing what is there. The file is
 * written beside `dest` and hard-linked into place, so `dest` appears whole or
 * not at all and a file that appeared meanwhile is never clobbered. On a
 * filesystem without hard links it is created exclusively instead. Anything
 * already at `dest` that cannot be read as the same content is a conflict.
 */
function placeFile(
  dest: string,
  bytes: Buffer,
  same: (existing: Buffer) => boolean,
  mode?: number
): Placement {
  const matches = () => {
    const current = readOrNull(dest);
    return current !== null && same(current);
  };
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, bytes, { flag: 'wx', mode });
  try {
    try {
      linkSync(tmp, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return matches() ? 'unchanged' : 'conflict';
      if (!NO_HARD_LINKS.has(code)) throw err;
      try {
        writeFileSync(dest, bytes, { flag: 'wx', mode });
      } catch (createErr) {
        if ((createErr as NodeJS.ErrnoException).code !== 'EEXIST') throw createErr;
        return matches() ? 'unchanged' : 'conflict';
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!matches()) {
    // This call created `dest`, so a bad copy is removed rather than left to be read.
    rmSync(dest, { force: true });
    throw new Error(`${dest} did not read back as written`);
  }
  return 'wrote';
}

/**
 * Non-secret facts about the settings in a legacy folder: the tracker, and the
 * team and workspace (from `config.local.json` over `config.json`). Never a
 * credential.
 */
function summarise(folder: string): SettingsSummary {
  const read = (name: string) => {
    const value = parseOrUndefined(readOrNull(path.join(folder, name)));
    return isPlainObject(value) ? value : {};
  };
  const committed = read(CONFIG_FILE);
  const local = read(LOCAL_CONFIG_FILE);
  const pick = (obj: Record<string, unknown>, ...keys: string[]): string | null => {
    let cursor: unknown = obj;
    for (const key of keys) cursor = isPlainObject(cursor) ? cursor[key] : undefined;
    return typeof cursor === 'string' ? cursor : null;
  };
  return {
    folder,
    tracker: pick(committed, 'tracker'),
    team: pick(local, 'connection', 'team', 'key') ?? pick(committed, 'connection', 'team', 'key'),
    workspace:
      pick(local, 'connection', 'workspace', 'slug') ??
      pick(committed, 'connection', 'workspace', 'slug'),
  };
}

/**
 * Copy legacy settings from the plugin folder into the project.
 *
 * A plugin folder inside this project is copied without asking. One anywhere
 * else may be shared by several projects, so it is only copied with
 * `confirm: true`, which a person gives after seeing {@link MigrationResult.found}.
 * The local file goes first, byte for byte and owner-only; the committed file goes
 * last, because its presence is what makes the project the source, with a
 * `$schema` that is not a URL replaced by {@link CONFIG_SCHEMA_URL}. A destination
 * holding the same settings counts as done, anything else there stops the
 * migration, and the legacy files are never deleted. Afterwards the legacy folder
 * gets a {@link MIGRATED_MARKER} naming this project, so no other project reads it.
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @param options - `confirm`: a person said these settings are this project's.
 * @returns What was written, what already matched, and what was left in place.
 */
export function migrateConfig(
  roots: ConfigRoots,
  options: { confirm?: boolean } = {}
): MigrationResult {
  const files = resolveConfigFiles(roots);
  const none = {
    migrated: false,
    needsConfirmation: false,
    found: null,
    from: null,
    wrote: [],
    unchanged: [],
    leftInPlace: [],
  };
  if (files.origin === 'project') return { ok: true, ...none, reason: 'already in the project' };
  if (files.committed === null) return { ok: true, ...none, reason: 'nothing to migrate' };

  const from = path.dirname(files.committed);
  const found = summarise(from);
  const leftInPlace = [files.committed, ...(files.local === null ? [] : [files.local])];
  const wrote: string[] = [];
  const unchanged: string[] = [];
  const outcome = { needsConfirmation: false, found, from, wrote, unchanged, leftInPlace };
  const stop = (reason: string): MigrationResult => ({
    ok: false,
    migrated: false,
    ...outcome,
    reason,
  });

  if (files.shared && options.confirm !== true) {
    return {
      ok: true,
      migrated: false,
      ...outcome,
      needsConfirmation: true,
      reason: `settings in ${from} are outside this project and may belong to another one; confirm they are this project's before they are copied`,
    };
  }

  const settings = parseOrUndefined(readFileSync(files.committed));
  if (!isPlainObject(settings)) {
    return stop(`${files.committed} is not a JSON object, so it was not copied`);
  }
  if (typeof settings.$schema === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(settings.$schema)) {
    settings.$schema = CONFIG_SCHEMA_URL;
  }

  try {
    const prepared = prepareConfigDirs(files);
    if (files.local !== null) {
      if (!prepared.ok) return stop(prepared.reason ?? 'the project folder could not be prepared');
      const bytes = readFileSync(files.local);
      const placed = placeFile(prepared.local, bytes, (existing) => existing.equals(bytes), 0o600);
      if (placed === 'conflict') {
        return stop(
          `${prepared.local} already exists with different settings than ${files.local}; nothing was overwritten`
        );
      }
      (placed === 'wrote' ? wrote : unchanged).push(prepared.local);
    }

    const placed = placeFile(
      prepared.committed,
      Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
      (existing) => isDeepStrictEqual(parseOrUndefined(existing), settings)
    );
    if (placed === 'conflict') {
      return stop(
        `${prepared.committed} already exists with different settings than ${files.committed}; nothing was overwritten`
      );
    }
    (placed === 'wrote' ? wrote : unchanged).push(prepared.committed);
  } catch (err) {
    return stop(`copying the settings failed: ${(err as Error).message}`);
  }

  const project = roots.mainCheckout ?? roots.checkout;
  let reason = `settings copied into ${files.committedDir}; the old files in ${from} were left in place`;
  try {
    writeFileSync(path.join(from, MIGRATED_MARKER), `${project}\n`);
  } catch (err) {
    reason += `, but ${from} could not be marked as moved (${(err as Error).message}), so another project on this install could still read them`;
  }
  return { ok: true, migrated: true, ...outcome, reason };
}

const HELP = `config-files — find, migrate and prepare flow's settings files.

Usage: config-files.ts [resolve|migrate|prepare] [--confirm] [--project <dir>]

  resolve   (default) Which config.json and config.local.json flow reads, with
            config.json checked against config.schema.json. Prints
            { ok, origin, committed, local, committedDir, localDir, shared, moved,
              errors, warnings }. Exit 0 when configured and valid, 1 otherwise.
  migrate   Copy settings from inside the plugin into the project's .agents/flow/.
            Settings in a plugin folder outside the project are only copied with
            --confirm, after a person says they are this project's. Never
            overwrites or deletes. Prints { ok, migrated, needsConfirmation, found,
            from, wrote, unchanged, leftInPlace, reason }. Exit 0 unless it stopped.
  prepare   Create the .agents/flow/ folders and make git ignore config.local.json
            in each. Prints { ok, committed, local, gitignores }: write the files to
            exactly those paths. Exit 1 when git would still track the local file.

--project <dir> is the folder to act for (default: the current directory).
Only paths and non-secret facts are printed, never a credential.
`;

const COMMANDS = ['resolve', 'migrate', 'prepare'] as const;
type Command = (typeof COMMANDS)[number];

/** The installed plugin this script belongs to. */
function pluginRoot(): string {
  return realpathSync(fileURLToPath(new URL('..', import.meta.url)));
}

function describe(summary: SettingsSummary): string {
  const parts = [
    `tracker ${summary.tracker ?? '(not set)'}`,
    `team ${summary.team ?? '(not set)'}`,
    `workspace ${summary.workspace ?? '(not set)'}`,
  ];
  return parts.join(', ');
}

function resolveCommand(roots: ConfigRoots): { result: object; ok: boolean } {
  const files = resolveConfigFiles(roots);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (files.committed !== null) {
    const settings = parseOrUndefined(readOrNull(files.committed));
    if (settings === undefined) {
      errors.push({ path: '(root)', message: `${files.committed} is not valid JSON` });
    } else {
      const report = validateConfig(settings);
      errors.push(...report.errors);
      warnings.push(...report.warnings);
    }
  }
  if (files.origin === 'legacy') {
    const folder = path.dirname(files.committed as string);
    warnings.push({
      path: '(file)',
      message: files.shared
        ? `flow is reading settings from ${folder}, a plugin folder outside this project that other projects may share (${describe(summarise(folder))}); if they are this project's, run config-files.ts migrate --confirm to move them into it, otherwise set this project up with /flow:init`
        : `flow's settings are still inside the plugin at ${folder}, where a plugin update can erase them; run config-files.ts migrate to copy them into ${files.committedDir}`,
    });
  }
  for (const moved of files.moved) {
    warnings.push({
      path: '(file)',
      message: `the settings in ${moved.folder} were moved to ${moved.movedTo} and belong to that project; flow did not use them here`,
    });
  }
  if (files.origin === 'project' && gitIgnores(files.committed as string)) {
    warnings.push({
      path: '(file)',
      message: `team settings in ${files.committed} are ignored by git, so they are not shared with anyone else on the project`,
    });
  }

  const ok = files.committed !== null && errors.length === 0;
  return { result: { ok, ...files, errors, warnings }, ok };
}

/**
 * Run the config-files CLI.
 *
 * @param argv - Process args after node + script (`process.argv.slice(2)`).
 * @returns The exit code: 0 success, 1 not configured / stopped / refused, 2 usage error.
 */
export function main(argv: readonly string[]): number {
  let command: Command = 'resolve';
  let project = process.cwd();
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === '--project' && argv[i + 1] !== undefined) {
      project = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--project=')) {
      project = path.resolve(arg.slice('--project='.length));
    } else if (arg === '--confirm') {
      confirm = true;
    } else if ((COMMANDS as readonly string[]).includes(arg) && i === 0) {
      command = arg as Command;
    } else {
      process.stderr.write(`config-files: unexpected argument "${arg}"\n\n${HELP}`);
      return 2;
    }
  }

  const roots = findConfigRoots(project, pluginRoot());
  const refusal = refusalFor(roots);
  if (refusal !== null) {
    process.stderr.write(`config-files: ${refusal}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, reason: refusal })}\n`);
    return 1;
  }

  let output: { result: object; ok: boolean };
  if (command === 'migrate') {
    const result = migrateConfig(roots, { confirm });
    process.stderr.write(`config-files: ${result.reason}\n`);
    if (result.needsConfirmation && result.found !== null) {
      process.stderr.write(`config-files: found ${describe(result.found)}\n`);
    }
    output = { result, ok: result.ok };
  } else if (command === 'prepare') {
    const result = prepareConfigDirs(resolveConfigFiles(roots));
    if (result.reason !== undefined) process.stderr.write(`config-files: ${result.reason}\n`);
    output = { result, ok: result.ok };
  } else {
    output = resolveCommand(roots);
    const { warnings, errors } = output.result as {
      warnings: ValidationIssue[];
      errors: ValidationIssue[];
    };
    for (const w of warnings)
      process.stderr.write(`config-files: warning at ${w.path} — ${w.message}\n`);
    for (const e of errors)
      process.stderr.write(`config-files: error at ${e.path} — ${e.message}\n`);
  }
  process.stdout.write(`${JSON.stringify(output.result)}\n`);
  return output.ok ? 0 : 1;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
