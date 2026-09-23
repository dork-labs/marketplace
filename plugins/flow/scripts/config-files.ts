/**
 * Where flow's project files live, and the one place that knows it (DOR-2274,
 * DOR-2285).
 *
 * flow keeps everything a person owns in the project it runs in, never inside the
 * installed plugin:
 *
 * - `.agents/flow/config.json`: team policy, committed with the project.
 * - `.agents/flow/config.local.json`: this machine's credentials and overrides,
 *   kept out of git by a `.agents/flow/.gitignore` flow writes.
 * - `.agents/flow/adapters/<tracker>/SKILL.md`: a tracker adapter `/flow:init`
 *   generated, committed as the team's code (see {@link resolveAdapter}).
 * - `.agents/flow/paused.json`: this machine's pause, kept out of git (see
 *   {@link pauseFlow}).
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
 * project's. Until then they are not used at all: flow reports the project as not
 * configured rather than act on another project's settings. Nothing is ever
 * overwritten or deleted; after a migration the old folder gets a
 * {@link MIGRATED_MARKER} naming the project, so no other project silently
 * inherits those settings, and a "not mine" answer is kept in its
 * {@link DECLINED_MARKER} so it is never asked again.
 *
 * A generated adapter used to be written into the plugin's `skills/` folder, and
 * `/flow:pause` used to edit the shipped `flow-drain` schedule; both were undone
 * by a plugin update, and the edit never stopped a schedule DorkOS had approved,
 * because DorkOS keeps an approved package schedule's switch itself.
 * {@link migrateAdapter} moves an old adapter under the same rules as settings.
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
 * The file in an old plugin `config/` folder listing, one per line, the projects
 * whose person said its settings are not theirs. Such a project is never asked
 * about that folder again and never reads it.
 */
export const DECLINED_MARKER = 'DECLINED_BY';
/**
 * The `$schema` a project's `config.json` points at. A relative path to the
 * plugin cannot resolve from the project, and an absolute one would name one
 * machine's install folder in a committed file.
 */
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/plugins/flow/config/config.schema.json';

/**
 * The folder, under {@link PROJECT_CONFIG_DIR}, holding the adapters flow
 * generated for this project, one folder per tracker.
 */
export const ADAPTERS_DIR = 'adapters';
/** The file an adapter folder is read from. */
export const ADAPTER_FILE = 'SKILL.md';
/**
 * The trackers whose adapter this plugin ships, at
 * `<flow-root>/skills/<tracker>-adapter/`. Any other `<tracker>-adapter` folder
 * there was generated by a flow before 0.9.0.
 */
export const SHIPPED_ADAPTERS: readonly string[] = ['linear'];
/** The tracker a config names when it names none (the schema default). */
export const DEFAULT_TRACKER = 'linear';
/**
 * The file whose presence pauses flow's autonomy on this machine. It sits beside
 * `config.local.json` and, like it, is never committed.
 */
export const PAUSE_FILE = 'paused.json';

/** What a tracker must look like before it is joined into a path (the schema's pattern). */
const TRACKER_SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * What the flow-written `.gitignore` must hold: the local file, the temporary
 * copies of it a write makes before linking it into place, and the pause.
 */
const GITIGNORE_LINES = [LOCAL_CONFIG_FILE, `.${LOCAL_CONFIG_FILE}.*.tmp`, PAUSE_FILE] as const;
const GITIGNORE_HEADER =
  "# flow: this machine's settings, credentials and pause. Never commit them.\n";

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
  /**
   * The files that keep the local file out of git: a `.gitignore` in a folder of
   * the current checkout (it travels with the branch), or the repo's
   * `info/exclude` for a folder in another checkout (an untracked `.gitignore`
   * there would block the merge that brings the branch's copy in).
   */
  ignoreFiles: string[];
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

/** Where the adapter in use came from. */
export type AdapterOrigin = 'project' | 'shipped' | 'legacy' | 'none';

/** The tracker adapter flow reads, and where the project's own copy belongs. */
export interface AdapterFiles {
  /** The configured tracker, or `null` when flow is not configured or it cannot name a folder. */
  tracker: string | null;
  /** Which kind of place {@link AdapterFiles.path} was found in. */
  origin: AdapterOrigin;
  /** Absolute path of the adapter's `SKILL.md` to read, or `null` when there is none. */
  path: string | null;
  /**
   * Where the project's adapter is, or goes when `/flow:init` generates one or a
   * migration moves one: `adapters/<tracker>/SKILL.md` beside the `config.json`
   * in use. `null` without a tracker.
   */
  target: string | null;
  /** Origin `legacy` from a plugin folder outside this project, so only moved once a person confirms. */
  shared: boolean;
  /** Legacy adapter folders skipped because they were moved to a project. */
  moved: MovedSettings[];
}

/** Non-secret facts about an adapter found in a plugin folder, shown before moving it. */
export interface AdapterSummary {
  /** The plugin's `skills/<tracker>-adapter/` folder. */
  folder: string;
  /** The tracker it is for. */
  tracker: string;
}

/** The outcome of copying a legacy adapter into the project. */
export interface AdapterMigrationResult {
  /** `false` when the migration stopped; nothing was overwritten or deleted. */
  ok: boolean;
  /** Whether this call completed a migration from the plugin folder. */
  migrated: boolean;
  /** The adapter is in a plugin folder outside this project: a person must confirm it is this project's. */
  needsConfirmation: boolean;
  /** What was found, when there was a legacy adapter. */
  found: AdapterSummary | null;
  /** The legacy adapter folder, or `null`. */
  from: string | null;
  /** Project files this call created. */
  wrote: string[];
  /** Project files that already held the same content. */
  unchanged: string[];
  /** Legacy files left where they were (they are never deleted). */
  leftInPlace: string[];
  /** A plain explanation of the outcome. */
  reason: string;
}

/** A settings migration and the adapter migration that follows it. */
export interface FullMigrationResult extends MigrationResult {
  /** The adapter half; the fields above it combine both halves' `ok` and `needsConfirmation`. */
  adapter: AdapterMigrationResult;
}

/** This machine's pause, when flow is paused. */
export interface PauseState {
  /** The flag file. */
  file: string;
  /** When the pause began, or `null` when the flag cannot be read (it still pauses). */
  pausedAt: string | null;
}

/** The outcome of pausing. */
export interface PauseResult {
  /** Always `true`: a pause is written whenever the folder can be. */
  ok: boolean;
  /** The flag file in effect. */
  file: string;
  /** When the pause in effect began. */
  pausedAt: string | null;
  /** flow was already paused; the earlier flag was kept. */
  alreadyPaused: boolean;
  /** Whether git ignores the flag; `false` means it could be committed by mistake. */
  ignored: boolean;
}

/** The outcome of resuming. */
export interface ResumeResult {
  /** Always `true`. */
  ok: boolean;
  /** Whether any flag was there. */
  wasPaused: boolean;
  /** The flag files removed. */
  removed: string[];
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
  return [path.join(pluginRoot, 'config'), ...cacheSiblings(pluginRoot, 'config', CONFIG_FILE)];
}

/**
 * The plugin folders a legacy generated adapter for `tracker` may be in, most
 * likely first: the plugin's own `skills/<tracker>-adapter/`, then the same
 * folder in each other Claude Code cache version that holds a `SKILL.md`, newest
 * first. Empty for a tracker whose adapter flow ships: that folder is flow's own
 * in every version, never something an older flow generated.
 *
 * @param pluginRoot - The installed flow plugin's root folder.
 * @param tracker - The configured tracker (a slug).
 * @returns Candidate legacy adapter folders, in the order to try them.
 */
export function legacyAdapterDirs(pluginRoot: string, tracker: string): string[] {
  if (SHIPPED_ADAPTERS.includes(tracker)) return [];
  const rel = path.join('skills', `${tracker}-adapter`);
  return [path.join(pluginRoot, rel), ...cacheSiblings(pluginRoot, rel, ADAPTER_FILE)];
}

/**
 * `<sibling>/<rel>` for each other version folder beside `pluginRoot` whose
 * `<rel>/<file>` exists, newest `file` first; nothing outside Claude Code's cache
 * layout (`…/plugins/cache/<marketplace>/<plugin>/<version>`), so an arbitrary
 * folder's neighbours are never searched.
 */
function cacheSiblings(pluginRoot: string, rel: string, file: string): string[] {
  const segments = path.resolve(pluginRoot).split(path.sep);
  const n = segments.length;
  if (n < 5 || segments[n - 4] !== 'cache' || segments[n - 5] !== 'plugins') return [];

  const versionsDir = path.dirname(pluginRoot);
  const self = path.basename(pluginRoot);
  return readdirSync(versionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== self)
    .map((entry) => path.join(versionsDir, entry.name, rel))
    .filter((dir) => isFile(path.join(dir, file)))
    .map((dir) => ({ dir, mtime: statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ dir }) => dir);
}

/** The project's `.agents/flow/` folders: the checkout's, then the main checkout's. */
function projectDirs(roots: ConfigRoots): string[] {
  return [roots.checkout, roots.mainCheckout]
    .filter((root): root is string => root !== null)
    .map((root) => path.join(root, PROJECT_CONFIG_DIR));
}

/** Whether `dir` is inside this project (the checkout or the main checkout). */
function inProject(dir: string, roots: ConfigRoots): boolean {
  return [roots.checkout, roots.mainCheckout]
    .filter((root): root is string => root !== null)
    .some((root) => isWithin(real(dir), real(root)));
}

/** The path that names this project in the old folder's markers. */
function projectKey(roots: ConfigRoots): string {
  return roots.mainCheckout ?? roots.checkout;
}

/** Whether this project's person said the settings in `dir` are not theirs. */
function declinedBy(dir: string, roots: ConfigRoots): boolean {
  const marker = readOrNull(path.join(dir, DECLINED_MARKER));
  if (marker === null) return false;
  const key = projectKey(roots);
  return marker
    .toString('utf8')
    .split(/\r?\n/)
    .some((line) => line.trim() === key);
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
  const [checkoutDir, mainDir = null] = projectDirs(roots);
  const first = (name: string) =>
    projectDirs(roots)
      .map((dir) => path.join(dir, name))
      .find(isFile) ?? null;

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
    if (declinedBy(dir, roots)) continue;
    const local = path.join(dir, LOCAL_CONFIG_FILE);
    return {
      origin: 'legacy',
      committed: legacy,
      local: isFile(local) ? local : null,
      ...base,
      shared: !inProject(dir, roots),
    };
  }
  return { origin: 'none', committed: null, local: null, ...base };
}

/**
 * The tracker the settings in use name: `config.local.json` over `config.json`,
 * then {@link DEFAULT_TRACKER}. A value that is not a slug cannot name a folder
 * and is never joined into a path, so it is `null`.
 *
 * @param files - The settings files in use.
 * @returns The tracker slug, or `null`.
 */
export function trackerOf(files: Pick<ConfigFiles, 'committed' | 'local'>): string | null {
  const read = (file: string | null) => {
    const value = file === null ? undefined : parseOrUndefined(readOrNull(file));
    return isPlainObject(value) ? value : {};
  };
  const value = read(files.local).tracker ?? read(files.committed).tracker ?? DEFAULT_TRACKER;
  return typeof value === 'string' && TRACKER_SLUG.test(value) ? value : null;
}

/**
 * Decide which tracker adapter flow reads. The first found wins:
 *
 * 1. The project: `.agents/flow/adapters/<tracker>/SKILL.md` in the checkout,
 *    then the main checkout. It may override a shipped adapter on purpose.
 * 2. Shipped: `<flow-root>/skills/<tracker>-adapter/SKILL.md`, for a tracker in
 *    {@link SHIPPED_ADAPTERS}.
 * 3. Legacy: an adapter an older flow generated into a plugin folder
 *    ({@link legacyAdapterDirs}), skipping one marked as moved or declined by this
 *    project, and `shared` unless the plugin sits inside this project.
 * 4. None.
 *
 * The adapter is committed team code, so it is never a harness skill in the
 * project (nothing scans `.agents/flow/`); flow reads it by this path.
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @param files - The settings in use; resolved from `roots` when omitted.
 * @returns The adapter in use, and where the project's copy belongs.
 */
export function resolveAdapter(
  roots: ConfigRoots,
  files: ConfigFiles = resolveConfigFiles(roots)
): AdapterFiles {
  const moved: MovedSettings[] = [];
  const tracker = files.committed === null ? null : trackerOf(files);
  if (tracker === null) {
    return { tracker: null, origin: 'none', path: null, target: null, shared: false, moved };
  }
  const target = path.join(files.committedDir, ADAPTERS_DIR, tracker, ADAPTER_FILE);
  const found = (origin: AdapterOrigin, file: string | null, shared = false): AdapterFiles => ({
    tracker,
    origin,
    path: file,
    target,
    shared,
    moved,
  });

  const project = projectDirs(roots)
    .map((dir) => path.join(dir, ADAPTERS_DIR, tracker, ADAPTER_FILE))
    .find(isFile);
  if (project !== undefined) return found('project', project);
  if (SHIPPED_ADAPTERS.includes(tracker)) {
    const shipped = path.join(roots.pluginRoot, 'skills', `${tracker}-adapter`, ADAPTER_FILE);
    return isFile(shipped) ? found('shipped', shipped) : found('none', null);
  }
  for (const dir of legacyAdapterDirs(roots.pluginRoot, tracker)) {
    const file = path.join(dir, ADAPTER_FILE);
    if (!isFile(file)) continue;
    const destination = movedTo(dir);
    if (destination !== null) {
      moved.push({ folder: dir, movedTo: destination });
      continue;
    }
    if (declinedBy(dir, roots)) continue;
    return found('legacy', file, !inProject(dir, roots));
  }
  return found('none', null);
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
 * Keep the local file in `dir` out of git through the repo's `info/exclude`,
 * which every checkout of the repo reads and none commits. Idempotent.
 */
function ensureExclude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const common = gitOutput(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const top = gitOutput(dir, ['rev-parse', '--show-toplevel']);
  if (common === null || top === null) throw new Error(`${dir} is not in a git checkout`);
  const rel = path.relative(path.resolve(top), dir).split(path.sep).join('/');
  const exclude = path.join(common, 'info', 'exclude');
  mkdirSync(path.dirname(exclude), { recursive: true });
  const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_LINES.map((line) => `/${rel}/${line}`).filter(
    (line) => !present.has(line)
  );
  if (missing.length > 0) {
    const separator = text === '' || text.endsWith('\n') ? '' : '\n';
    writeFileSync(exclude, `${text}${separator}${missing.join('\n')}\n`);
  }
  return exclude;
}

/**
 * Keep the per-machine files in `dir` out of git: a `.gitignore` in a folder of
 * the current checkout (or outside git), which travels with the branch, or the
 * repo's `info/exclude` for a folder in another checkout (the main checkout seen
 * from a linked worktree). Creates `dir`. Idempotent.
 *
 * @returns The file that now holds the rules.
 */
function keepOutOfGit(roots: ConfigRoots, dir: string): string {
  const ownCheckout = !roots.inGit || isWithin(dir, roots.checkout);
  return ownCheckout ? ensureGitignore(dir) : ensureExclude(dir);
}

/**
 * Make the project ready for settings: create the folder `config.json` goes in
 * and the folder `config.local.json` goes in, keep the local file out of git in
 * each, then ask git to prove it. A folder in the current checkout (or outside
 * git) gets a `.gitignore`, which is committed with `config.json`. A folder in
 * another checkout, the main checkout seen from a linked worktree, gets an entry
 * in the repo's `info/exclude` instead: an untracked `.gitignore` there would stop
 * `git merge` / `git pull` from bringing in the branch's committed copy. Safe to
 * repeat.
 *
 * @param roots - The checkouts; which one a folder is in decides how it is ignored.
 * @param files - The resolved files, whose `committedDir` and `localDir` are prepared.
 * @returns The paths to write, and `ok: false` when git would still track a local file.
 */
export function prepareConfigDirs(
  roots: ConfigRoots,
  files: Pick<ConfigFiles, 'committedDir' | 'localDir'>
): PrepareResult {
  const dirs = [...new Set([files.committedDir, files.localDir])];
  const ignoreFiles = [...new Set(dirs.map((dir) => keepOutOfGit(roots, dir)))];
  const result = {
    committed: path.join(files.committedDir, CONFIG_FILE),
    local: path.join(files.localDir, LOCAL_CONFIG_FILE),
    ignoreFiles,
  };
  // The entry alone proves nothing: a negation rule, or a copy git already
  // tracks, keeps the file in git. Only git's own answer counts, in every folder
  // that may receive credentials.
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
 * Add this project to `dir`'s {@link DECLINED_MARKER}, so it never reads or is
 * asked about that folder again.
 *
 * @returns `null`, or why the folder could not be marked.
 */
function recordDecline(dir: string, roots: ConfigRoots): string | null {
  const marker = path.join(dir, DECLINED_MARKER);
  const text = readOrNull(marker)?.toString('utf8') ?? '';
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  try {
    writeFileSync(marker, `${text}${separator}${projectKey(roots)}\n`);
    return null;
  } catch (err) {
    return `${dir} could not be marked as not this project's: ${(err as Error).message}`;
  }
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
 *   `decline`: a person said they are not; the folder is marked so this project
 *   never reads it or asks about it again, and nothing is copied.
 * @returns What was written, what already matched, and what was left in place.
 */
export function migrateConfig(
  roots: ConfigRoots,
  options: { confirm?: boolean; decline?: boolean } = {}
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

  if (files.shared && options.decline === true) {
    const failed = recordDecline(from, roots);
    if (failed !== null) return stop(failed);
    return {
      ok: true,
      migrated: false,
      ...outcome,
      reason: `the settings in ${from} will not be used or offered for this project again`,
    };
  }
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
    const prepared = prepareConfigDirs(roots, files);
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

  const project = projectKey(roots);
  let reason = `settings copied into ${files.committedDir}; the old files in ${from} were left in place`;
  try {
    writeFileSync(path.join(from, MIGRATED_MARKER), `${project}\n`);
  } catch (err) {
    reason += `, but ${from} could not be marked as moved (${(err as Error).message}), so another project on this install could still read them`;
  }
  return { ok: true, migrated: true, ...outcome, reason };
}

/** The files a migration leaves in an old folder; never copied into the project. */
const MARKERS = new Set([MIGRATED_MARKER, DECLINED_MARKER]);

/**
 * The files of a legacy adapter folder to copy, relative to it: every regular
 * file, in subfolders too, except the two markers. A symlink is not followed,
 * so nothing outside the folder is copied. `SKILL.md` comes last: its presence
 * is what makes the project's copy the one flow reads.
 */
function adapterFilesIn(dir: string, rel = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) files.push(...adapterFilesIn(dir, child));
    else if (entry.isFile() && !(rel === '' && MARKERS.has(entry.name))) files.push(child);
  }
  if (rel !== '') return files;
  const rest = files.filter((file) => file !== ADAPTER_FILE).sort();
  return [...rest, ADAPTER_FILE];
}

/**
 * Copy an adapter an older flow generated into a plugin folder into the project,
 * at `adapters/<tracker>/` beside the `config.json` in use.
 *
 * The same rules as {@link migrateConfig}: a plugin folder inside this project is
 * copied without asking; one anywhere else only with `confirm: true`, and
 * `decline: true` records that it is not this project's. Every file is copied
 * byte for byte and never overwrites anything; `SKILL.md` goes last. The old
 * folder is never deleted and gets a {@link MIGRATED_MARKER} naming this project.
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @param options - `confirm` / `decline`: a person's answer about a shared folder.
 * @returns What was written, what already matched, and what was left in place.
 */
export function migrateAdapter(
  roots: ConfigRoots,
  options: { confirm?: boolean; decline?: boolean } = {}
): AdapterMigrationResult {
  const adapter = resolveAdapter(roots);
  const none = {
    ok: true,
    migrated: false,
    needsConfirmation: false,
    found: null,
    from: null,
    wrote: [],
    unchanged: [],
    leftInPlace: [],
  };
  if (adapter.origin === 'project') return { ...none, reason: 'already in the project' };
  if (adapter.origin === 'shipped') return { ...none, reason: 'flow ships this adapter' };
  if (adapter.origin === 'none' || adapter.path === null || adapter.target === null) {
    return { ...none, reason: 'nothing to migrate' };
  }

  const from = path.dirname(adapter.path);
  const found = { folder: from, tracker: adapter.tracker as string };
  const sources = adapterFilesIn(from);
  const wrote: string[] = [];
  const unchanged: string[] = [];
  const outcome = {
    needsConfirmation: false,
    found,
    from,
    wrote,
    unchanged,
    leftInPlace: sources.map((file) => path.join(from, file)),
  };
  const stop = (reason: string): AdapterMigrationResult => ({
    ok: false,
    migrated: false,
    ...outcome,
    reason,
  });

  if (adapter.shared && options.decline === true) {
    const failed = recordDecline(from, roots);
    if (failed !== null) return stop(failed);
    return {
      ok: true,
      migrated: false,
      ...outcome,
      reason: `the ${found.tracker} adapter in ${from} will not be used or offered for this project again`,
    };
  }
  if (adapter.shared && options.confirm !== true) {
    return {
      ok: true,
      migrated: false,
      ...outcome,
      needsConfirmation: true,
      reason: `the ${found.tracker} adapter in ${from} is outside this project and may belong to another one; confirm it is this project's before it is copied`,
    };
  }

  const targetDir = path.dirname(adapter.target);
  try {
    for (const file of sources) {
      const dest = path.join(targetDir, file);
      const bytes = readFileSync(path.join(from, file));
      mkdirSync(path.dirname(dest), { recursive: true });
      const placed = placeFile(dest, bytes, (existing) => existing.equals(bytes));
      if (placed === 'conflict') {
        return stop(
          `${dest} already exists and differs from ${path.join(from, file)}; nothing was overwritten`
        );
      }
      (placed === 'wrote' ? wrote : unchanged).push(dest);
    }
  } catch (err) {
    return stop(`copying the adapter failed: ${(err as Error).message}`);
  }

  let reason = `the ${found.tracker} adapter was copied into ${targetDir}; commit it. The old copy in ${from} was left in place, and can be deleted once the new one is committed`;
  try {
    writeFileSync(path.join(from, MIGRATED_MARKER), `${projectKey(roots)}\n`);
  } catch (err) {
    reason += `, but ${from} could not be marked as moved (${(err as Error).message}), so another project on this install could still read it`;
  }
  return { ok: true, migrated: true, ...outcome, reason };
}

/**
 * Move everything an older flow kept inside the plugin: the settings, then the
 * adapter they name. One person's answer covers both, since they come from the
 * same plugin folder. A decline marks the adapter before the settings, because
 * once the settings are declined they no longer name a tracker to find it by.
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @param options - `confirm` / `decline`: a person's answer about a shared folder.
 * @returns The settings result, with `ok` and `needsConfirmation` covering both halves.
 */
export function migrateAll(
  roots: ConfigRoots,
  options: { confirm?: boolean; decline?: boolean } = {}
): FullMigrationResult {
  let settings: MigrationResult;
  let adapter: AdapterMigrationResult;
  if (options.decline === true) {
    adapter = migrateAdapter(roots, options);
    settings = migrateConfig(roots, options);
  } else {
    settings = migrateConfig(roots, options);
    adapter = migrateAdapter(roots, options);
  }
  return {
    ...settings,
    ok: settings.ok && adapter.ok,
    needsConfirmation: settings.needsConfirmation || adapter.needsConfirmation,
    adapter,
  };
}

/**
 * Whether flow is paused on this machine: the first {@link PAUSE_FILE} in the
 * checkout's, then the main checkout's, `.agents/flow/`. The flag's presence is
 * the pause; one that cannot be read still pauses, the safe direction for
 * autonomy.
 *
 * @param roots - The checkouts to look in.
 * @returns The pause, or `null` when flow is not paused.
 */
export function pauseState(roots: ConfigRoots): PauseState | null {
  const file = projectDirs(roots)
    .map((dir) => path.join(dir, PAUSE_FILE))
    .find(isFile);
  if (file === undefined) return null;
  const value = parseOrUndefined(readOrNull(file));
  const pausedAt =
    isPlainObject(value) && typeof value.pausedAt === 'string' ? value.pausedAt : null;
  return { file, pausedAt };
}

/**
 * Pause flow's autonomy on this machine: write {@link PAUSE_FILE} beside the
 * local settings (the main checkout's `.agents/flow/` from a worktree), after
 * keeping it out of git. Every autonomous entry point (the scheduled ticks,
 * `/flow continue`, `/flow auto`) checks it first and stops. An existing pause is
 * kept, so its start time stays true. Works whether or not flow is configured.
 *
 * It is a file flow owns in the project, not an edit to the shipped schedule: an
 * update cannot undo it, and it works under any scheduler.
 *
 * @param roots - The checkouts to act for.
 * @param now - The time to record.
 * @returns The flag in effect, and whether git ignores it.
 */
export function pauseFlow(roots: ConfigRoots, now: Date = new Date()): PauseResult {
  const dir = resolveConfigFiles(roots).localDir;
  keepOutOfGit(roots, dir);
  const ignored = (file: string) => !inGitRepo(path.dirname(file)) || gitIgnores(file);
  const existing = pauseState(roots);
  if (existing !== null)
    return { ok: true, ...existing, alreadyPaused: true, ignored: ignored(existing.file) };

  const file = path.join(dir, PAUSE_FILE);
  const pausedAt = now.toISOString();
  try {
    writeFileSync(file, `${JSON.stringify({ pausedAt }, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    // Another session paused in between: theirs stands.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raced = pauseState(roots) ?? { file, pausedAt: null };
    return { ok: true, ...raced, alreadyPaused: true, ignored: ignored(raced.file) };
  }
  return { ok: true, file, pausedAt, alreadyPaused: false, ignored: ignored(file) };
}

/**
 * Lift a pause: remove {@link PAUSE_FILE} from the checkout's and the main
 * checkout's `.agents/flow/`.
 *
 * @param roots - The checkouts to act for.
 * @returns Whether flow was paused, and the flags removed.
 */
export function resumeFlow(roots: ConfigRoots): ResumeResult {
  const removed = projectDirs(roots)
    .map((dir) => path.join(dir, PAUSE_FILE))
    .filter(isFile);
  for (const file of removed) rmSync(file, { force: true });
  return { ok: true, wasPaused: removed.length > 0, removed };
}

const HELP = `config-files — find, migrate and prepare flow's project files.

Usage: config-files.ts [resolve|migrate|prepare|pause|resume] [--confirm|--decline] [--project <dir>]

  resolve   (default) Which config.json and config.local.json flow reads, with
            config.json checked against config.schema.json, which tracker adapter
            it reads, and whether flow is paused. Prints
            { ok, origin, committed, local, committedDir, localDir, shared, moved,
              flowRoot, adapter, paused, errors, warnings }; adapter is
            { tracker, origin, path, target, shared, moved }. Exit 0 when
            configured, valid and with an adapter to read, 1 otherwise. Being
            paused is not an error: act on "paused".
  migrate   Copy settings, and the tracker adapter they name, from inside the
            plugin into the project's .agents/flow/. Anything in a plugin folder
            outside the project is only copied with --confirm, after a person
            says it is this project's; --decline records that it is not, so this
            project never reads or asks about it again. Never overwrites or
            deletes. Prints { ok, migrated, needsConfirmation, found, from, wrote,
            unchanged, leftInPlace, reason, adapter: { ...the same for the
            adapter } }. Exit 0 unless it stopped.
  prepare   Create the .agents/flow/ folders and make git ignore config.local.json
            in each. Prints { ok, committed, local, ignoreFiles }: write the files to
            exactly those paths. Exit 1 when git would still track the local file.
  pause     Pause flow's autonomy on this machine (.agents/flow/paused.json, kept
            out of git). Prints { ok, file, pausedAt, alreadyPaused, ignored }.
  resume    Lift the pause. Prints { ok, wasPaused, removed }.

--project <dir> is the folder to act for (default: the current directory).
Only paths and non-secret facts are printed, never a credential.
`;

const COMMANDS = ['resolve', 'migrate', 'prepare', 'pause', 'resume'] as const;
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
    if (files.shared) {
      // Fail closed: settings nobody has confirmed are this project's must not
      // drive it (a scheduled run would claim another project's work).
      errors.push({
        path: '(file)',
        message: `these settings may belong to another project; run /flow in this project to confirm. They are in ${folder}, a plugin folder other projects may share (${describe(summarise(folder))})`,
      });
    } else {
      warnings.push({
        path: '(file)',
        message: `flow's settings are still inside the plugin at ${folder}, where a plugin update can erase them; run config-files.ts migrate to copy them into ${files.committedDir}`,
      });
    }
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

  const adapter = resolveAdapter(roots, files);
  if (files.committed !== null) adapterIssues(adapter, errors, warnings);

  const ok = files.committed !== null && errors.length === 0;
  const result = {
    ok,
    ...files,
    flowRoot: roots.pluginRoot,
    adapter,
    paused: pauseState(roots),
    errors,
    warnings,
  };
  return { result, ok };
}

/** What `resolve` says about the adapter of a configured project. */
function adapterIssues(
  adapter: AdapterFiles,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const at = '(adapter)';
  if (adapter.tracker === null) {
    // A committed tracker that is not a slug is already a schema error; say it once.
    if (!errors.some((e) => e.path === '/tracker')) {
      errors.push({
        path: at,
        message:
          'tracker is not an adapter name (lowercase letters, digits and dashes, starting with a letter)',
      });
    }
    return;
  }
  const targetDir = path.dirname(adapter.target as string);
  if (adapter.origin === 'none') {
    errors.push({
      path: at,
      message: `no adapter for tracker "${adapter.tracker}"; run /flow:init to generate one into ${targetDir}`,
    });
  } else if (adapter.origin === 'legacy') {
    const folder = path.dirname(adapter.path as string);
    if (adapter.shared) {
      // Fail closed, as for settings: an adapter nobody confirmed may be another project's.
      errors.push({
        path: at,
        message: `the ${adapter.tracker} adapter in ${folder} may belong to another project; run /flow in this project to confirm`,
      });
    } else {
      warnings.push({
        path: at,
        message: `the ${adapter.tracker} adapter is still inside the plugin at ${folder}, where a plugin update can erase it; run config-files.ts migrate to copy it into ${targetDir}`,
      });
    }
  }
  for (const moved of adapter.moved) {
    warnings.push({
      path: at,
      message: `the adapter in ${moved.folder} was moved to ${moved.movedTo} and belongs to that project; flow did not use it here`,
    });
  }
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
  let decline = false;
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
    } else if (arg === '--decline') {
      decline = true;
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
    if (confirm && decline) {
      process.stderr.write(`config-files: --confirm and --decline cannot both be given\n`);
      return 2;
    }
    const result = migrateAll(roots, { confirm, decline });
    process.stderr.write(`config-files: ${result.reason}\n`);
    if (result.needsConfirmation && result.found !== null) {
      process.stderr.write(`config-files: found ${describe(result.found)}\n`);
    }
    process.stderr.write(`config-files: adapter: ${result.adapter.reason}\n`);
    output = { result, ok: result.ok };
  } else if (command === 'pause') {
    const result = pauseFlow(roots);
    if (!result.ignored) {
      process.stderr.write(
        `config-files: warning — git does not ignore ${result.file}, so the pause could be committed by mistake\n`
      );
    }
    output = { result, ok: result.ok };
  } else if (command === 'resume') {
    const result = resumeFlow(roots);
    output = { result, ok: result.ok };
  } else if (command === 'prepare') {
    const result = prepareConfigDirs(roots, resolveConfigFiles(roots));
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
