/**
 * Where flow's settings live, and the one place that knows it (DOR-2274).
 *
 * flow keeps two settings files in the project it runs in, never inside the
 * installed plugin:
 *
 * - `<project>/.agents/flow/config.json`: team policy, committed with the project.
 * - `<project>/.agents/flow/config.local.json`: this machine's credentials and
 *   overrides, kept out of git by a `.agents/flow/.gitignore` flow writes.
 *
 * They used to live in `<flow-root>/config/`, inside the plugin. A host that
 * installs each plugin version into its own folder (Claude Code's plugin cache)
 * leaves them behind on every update. The project is the one place every host
 * keeps, that team policy can be committed to, and that a script run from a skill
 * can find without a host variable. `${CLAUDE_PLUGIN_DATA}` is none of those: in
 * Claude Code it is one folder per user for every project, it is not in the repo,
 * and the Bash tool does not see it.
 *
 * The files are found in this order (the first `config.json` wins, and its
 * `config.local.json` is taken from the same kind of place):
 *
 * 1. The project: the current checkout's `.agents/flow/`, then the main checkout's
 *    when this is a linked git worktree (an ignored file never reaches a new
 *    worktree, so the main checkout is the project's home).
 * 2. Legacy, only while the project has no `config.json`: the plugin's own
 *    `config/` folder, then, when the plugin sits in Claude Code's cache, the
 *    other version folders beside it, newest settings first. Both files come from
 *    one folder, never mixed.
 * 3. None: flow is not configured yet.
 *
 * `migrateConfig` copies legacy settings into the project. It never deletes or
 * overwrites anything: a shared install may still serve another project from the
 * old files, and a file already in the project is the person's.
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
 * The `$schema` a project's `config.json` points at. A relative path to the
 * plugin cannot resolve from the project, and an absolute one would name one
 * machine's install folder in a committed file.
 */
export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/plugins/flow/config/config.schema.json';

const GITIGNORE_BODY = `# flow: this machine's settings and credentials. Never commit them.\n${LOCAL_CONFIG_FILE}\n`;

/** The folders flow's settings are looked up from. */
export interface ConfigRoots {
  /** The checkout flow runs in: the git top level, or the folder itself outside git. */
  checkout: string;
  /** The main checkout when `checkout` is a linked git worktree, else `null`. */
  mainCheckout: string | null;
  /** The installed flow plugin's root folder (`<flow-root>`). */
  pluginRoot: string;
}

/** Where the settings in use came from. */
export type ConfigOrigin = 'project' | 'legacy' | 'none';

/** The settings files flow reads, and where the project's own files belong. */
export interface ConfigFiles {
  /** Which kind of place the files below were found in. */
  origin: ConfigOrigin;
  /** Absolute path of the `config.json` in use, or `null` when not configured. */
  committed: string | null;
  /** Absolute path of the `config.local.json` in use, or `null` when there is none. */
  local: string | null;
  /** The project's `.agents/flow` folder, where settings are written. */
  projectDir: string;
}

/** The outcome of preparing the project folder for settings. */
export interface PrepareResult {
  /** `false` when git would still track the local file, so nothing secret may be written. */
  ok: boolean;
  /** The project's `.agents/flow` folder. */
  projectDir: string;
  /** Where the project's `config.json` goes. */
  committed: string;
  /** Where the project's `config.local.json` goes. */
  local: string;
  /** The `.gitignore` that keeps the local file out of git. */
  gitignore: string;
  /** Why `ok` is false. */
  reason?: string;
}

/** The outcome of copying legacy settings into the project. */
export interface MigrationResult {
  /** `false` when the migration stopped; nothing was overwritten or deleted. */
  ok: boolean;
  /** Whether this call completed a migration from the plugin folder. */
  migrated: boolean;
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
    {
      stdio: 'ignore',
    }
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

/**
 * Find the checkout flow runs in and, for a linked worktree, the main checkout.
 *
 * @param cwd - The folder flow was started from.
 * @param pluginRoot - The installed flow plugin's root folder.
 * @returns The roots settings are looked up from.
 */
export function findConfigRoots(cwd: string, pluginRoot: string): ConfigRoots {
  const top = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (top === null) return { checkout: path.resolve(cwd), mainCheckout: null, pluginRoot };
  const checkout = path.resolve(top);
  // A linked worktree's common git dir is `<main checkout>/.git`. A bare repo or
  // a submodule has some other common dir and no main checkout to fall back to.
  const common = gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let mainCheckout: string | null = null;
  if (common !== null && path.basename(common) === '.git') {
    const main = path.dirname(path.resolve(common));
    if (main !== checkout) mainCheckout = main;
  }
  return { checkout, mainCheckout, pluginRoot };
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

/**
 * Decide which settings files flow reads (see the module doc for the order).
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @returns The files in use and the project folder new files belong in.
 */
export function resolveConfigFiles(roots: ConfigRoots): ConfigFiles {
  const projectDirs = [roots.checkout, roots.mainCheckout]
    .filter((dir): dir is string => dir !== null)
    .map((dir) => path.join(dir, PROJECT_CONFIG_DIR));
  const projectDir = projectDirs[projectDirs.length - 1];
  const first = (name: string) =>
    projectDirs.map((dir) => path.join(dir, name)).find(isFile) ?? null;

  const committed = first(CONFIG_FILE);
  if (committed !== null) {
    return { origin: 'project', committed, local: first(LOCAL_CONFIG_FILE), projectDir };
  }
  for (const dir of legacyConfigDirs(roots.pluginRoot)) {
    const legacy = path.join(dir, CONFIG_FILE);
    if (isFile(legacy)) {
      const local = path.join(dir, LOCAL_CONFIG_FILE);
      return {
        origin: 'legacy',
        committed: legacy,
        local: isFile(local) ? local : null,
        projectDir,
      };
    }
  }
  return { origin: 'none', committed: null, local: null, projectDir };
}

/**
 * Create the project's settings folder and make git ignore the local file in it:
 * a `.gitignore` beside the files (created, or the line appended), confirmed by
 * asking git. Safe to repeat.
 *
 * @param projectDir - The project's `.agents/flow` folder.
 * @returns The target paths, and `ok: false` when git would still track the local file.
 */
export function prepareProjectDir(projectDir: string): PrepareResult {
  mkdirSync(projectDir, { recursive: true });
  const gitignore = path.join(projectDir, '.gitignore');
  const local = path.join(projectDir, LOCAL_CONFIG_FILE);
  const result = {
    projectDir,
    committed: path.join(projectDir, CONFIG_FILE),
    local,
    gitignore,
  };

  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, GITIGNORE_BODY);
  } else {
    const text = readFileSync(gitignore, 'utf8');
    if (!text.split(/\r?\n/).some((line) => line.trim() === LOCAL_CONFIG_FILE)) {
      const separator = text === '' || text.endsWith('\n') ? '' : '\n';
      writeFileSync(gitignore, `${text}${separator}${LOCAL_CONFIG_FILE}\n`);
    }
  }

  // The line alone proves nothing: a negation rule, or a file git already tracks,
  // keeps it in git. Only git's own answer counts.
  if (inGitRepo(projectDir) && !gitIgnores(local)) {
    return {
      ok: false,
      ...result,
      reason: `git would still track ${local} (check for a "!${LOCAL_CONFIG_FILE}" rule, or a copy already committed), so flow will not put credentials there`,
    };
  }
  return { ok: true, ...result };
}

type Placement = 'wrote' | 'unchanged' | 'conflict';

/**
 * Put `bytes` at `dest` without ever replacing what is there. The file is
 * written beside `dest` and hard-linked into place, so `dest` appears whole or
 * not at all, and a file that appeared meanwhile is never clobbered.
 */
function placeFile(
  dest: string,
  bytes: Buffer,
  same: (existing: Buffer) => boolean,
  mode?: number
): Placement {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, bytes, { flag: 'wx', mode });
  try {
    try {
      linkSync(tmp, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return same(readFileSync(dest)) ? 'unchanged' : 'conflict';
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!same(readFileSync(dest))) throw new Error(`${dest} did not read back as written`);
  return 'wrote';
}

/** Parse JSON, or `undefined` when it is not JSON. */
function parseOrUndefined(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Copy legacy settings from the plugin folder into the project. Copy only and
 * idempotent: the local file goes first, byte for byte and owner-only; the
 * committed file goes last, because its presence is what makes the project the
 * source, with a `$schema` that is not a URL replaced by {@link CONFIG_SCHEMA_URL}.
 * A destination holding the same settings counts as done, one holding different
 * settings stops the migration, and the legacy files are never deleted.
 *
 * @param roots - The checkout, main checkout and plugin root to look in.
 * @returns What was written, what already matched, and what was left in place.
 */
export function migrateConfig(roots: ConfigRoots): MigrationResult {
  const files = resolveConfigFiles(roots);
  const none = { migrated: false, from: null, wrote: [], unchanged: [], leftInPlace: [] };
  if (files.origin === 'project') return { ok: true, ...none, reason: 'already in the project' };
  if (files.committed === null) return { ok: true, ...none, reason: 'nothing to migrate' };

  const from = path.dirname(files.committed);
  const leftInPlace = [files.committed, ...(files.local === null ? [] : [files.local])];
  const wrote: string[] = [];
  const unchanged: string[] = [];
  const stop = (reason: string): MigrationResult => ({
    ok: false,
    migrated: false,
    from,
    wrote,
    unchanged,
    leftInPlace,
    reason,
  });

  const settings = parseOrUndefined(readFileSync(files.committed));
  if (!isPlainObject(settings)) {
    return stop(`${files.committed} is not a JSON object, so it was not copied`);
  }
  if (typeof settings.$schema === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(settings.$schema)) {
    settings.$schema = CONFIG_SCHEMA_URL;
  }

  try {
    if (files.local !== null) {
      const prepared = prepareProjectDir(files.projectDir);
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

    mkdirSync(files.projectDir, { recursive: true });
    const dest = path.join(files.projectDir, CONFIG_FILE);
    const placed = placeFile(
      dest,
      Buffer.from(`${JSON.stringify(settings, null, 2)}\n`),
      (existing) => isDeepStrictEqual(parseOrUndefined(existing), settings)
    );
    if (placed === 'conflict') {
      return stop(
        `${dest} already exists with different settings than ${files.committed}; nothing was overwritten`
      );
    }
    (placed === 'wrote' ? wrote : unchanged).push(dest);
  } catch (err) {
    return stop(`copying the settings failed: ${(err as Error).message}`);
  }

  return {
    ok: true,
    migrated: true,
    from,
    wrote,
    unchanged,
    leftInPlace,
    reason: `settings copied into ${files.projectDir}; the old files in ${from} were left in place`,
  };
}

const HELP = `config-files — find, migrate and prepare flow's settings files.

Usage: config-files.ts [resolve|migrate|prepare] [--project <dir>]

  resolve   (default) Which config.json and config.local.json flow reads, with
            config.json checked against config.schema.json. Prints
            { ok, origin, committed, local, projectDir, errors, warnings }.
            Exit 0 when configured and valid, 1 otherwise.
  migrate   Copy settings from inside the plugin into <project>/.agents/flow/.
            Never overwrites or deletes. Prints
            { ok, migrated, from, wrote, unchanged, leftInPlace, reason }.
            Exit 0 unless it had to stop.
  prepare   Create <project>/.agents/flow/ and make git ignore config.local.json.
            Prints { ok, projectDir, committed, local, gitignore }. Exit 1 when git
            would still track the local file.

--project <dir> is the folder to act for (default: the current directory).
Only paths are printed, never the contents of either file.
`;

const COMMANDS = ['resolve', 'migrate', 'prepare'] as const;
type Command = (typeof COMMANDS)[number];

/** The installed plugin this script belongs to. */
function pluginRoot(): string {
  return realpathSync(fileURLToPath(new URL('..', import.meta.url)));
}

function resolveCommand(roots: ConfigRoots): { result: object; ok: boolean } {
  const files = resolveConfigFiles(roots);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (files.committed !== null) {
    const settings = parseOrUndefined(readFileSync(files.committed));
    if (settings === undefined) {
      errors.push({ path: '(root)', message: `${files.committed} is not valid JSON` });
    } else {
      const report = validateConfig(settings);
      errors.push(...report.errors);
      warnings.push(...report.warnings);
    }
  }
  if (files.origin === 'legacy') {
    warnings.push({
      path: '(file)',
      message: `flow's settings are still inside the plugin at ${path.dirname(files.committed as string)}, where a plugin update can erase them; run config-files.ts migrate to copy them into ${files.projectDir}`,
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
 * @returns The exit code: 0 success, 1 not configured / stopped, 2 usage error.
 */
export function main(argv: readonly string[]): number {
  let command: Command = 'resolve';
  let project = process.cwd();
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
    } else if ((COMMANDS as readonly string[]).includes(arg) && i === 0) {
      command = arg as Command;
    } else {
      process.stderr.write(`config-files: unexpected argument "${arg}"\n\n${HELP}`);
      return 2;
    }
  }

  const roots = findConfigRoots(project, pluginRoot());
  let output: { result: object; ok: boolean };
  if (command === 'migrate') {
    const result = migrateConfig(roots);
    process.stderr.write(`config-files: ${result.reason}\n`);
    output = { result, ok: result.ok };
  } else if (command === 'prepare') {
    const result = prepareProjectDir(resolveConfigFiles(roots).projectDir);
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
