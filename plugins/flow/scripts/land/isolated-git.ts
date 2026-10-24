/**
 * Git the worker cannot configure (DOR-3262). The arm guard's `run:` checkout
 * and the squash check both read commits from the project's repository, which
 * every worktree shares and any worker can write to: its config (filters,
 * merge drivers, `merge.default`), `info/attributes`, `refs/replace`, sparse
 * checkout, and its object folder itself (a loose object or the commit-graph
 * can be overwritten, and git does not re-hash objects on most reads). Any of
 * those can change what a checkout contains or what a merge gives, while every
 * SHA still looks right.
 *
 * So both run git in a scratch repository instead: `git init` in a temp
 * folder with no template, then a blob-less fetch of exactly the commits the
 * check needs, by SHA, from the project's repository (a plain path, so no URL
 * decoding). Every object reaches it through git's fetch protocol, which
 * re-hashes each one and checks that the history connects, so a swapped object
 * fails the copy rather than reaching the check; the blobs a checkout or a
 * merge needs later are fetched the same way. Its config is fresh, its `info/`
 * is empty, it has no replace refs, and background maintenance is off. The
 * copy runs with `GIT_NO_LAZY_FETCH=1`, so a shallow project cannot set off
 * an endless chain of lazy fetches; it needs git 2.44 or later, checked once.
 * Every git call runs with {@link isolatedGitEnv}: no system or global config,
 * no replace objects, no inherited `GIT_*` variable, no credential prompt,
 * and a timeout kills git's whole process group.
 *
 * @module @dorkos/flow/land/isolated-git
 */

import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isFullSha } from './validate.ts';

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 300_000;

/** One git call's result. */
export interface GitResult {
  /** The exit code (`-1` when git could not start or timed out). */
  code: number;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
}

/** Runs git with no shell, optionally feeding it standard input. */
export type GitRunner = (args: readonly string[], input?: string) => Promise<GitResult>;

/** The system's own folders, in order. */
const SYSTEM_PATH: readonly string[] = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/**
 * The PATH every isolated git call gets: the system folders that only root
 * can write to, read at run time. Never the agent's PATH, and never a folder
 * the user owns (Homebrew's `/opt/homebrew/bin`, node's folder under nvm),
 * where a worker could plant a `git` that lies to the checks.
 *
 * @returns The PATH.
 */
export function gitPath(): string {
  return SYSTEM_PATH.filter((dir) => {
    try {
      const info = statSync(dir);
      return info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0;
    } catch {
      return false;
    }
  }).join(path.delimiter);
}

/**
 * The PATH every `run:` command gets: the folder of the node running flow (so
 * `node` is found), then the system's folders. Never the agent's PATH.
 */
export const FIXED_PATH: string = [path.dirname(process.execPath), ...SYSTEM_PATH].join(
  path.delimiter
);

/**
 * A folder only this user can use, owned by flow, for scratch copies:
 * `<temp>/dorkos-flow-<uid>`, mode 700. One that already exists is used only
 * when it is a real folder (not a link) owned by this user; a looser mode is
 * tightened. Anything else refuses, so another user cannot plant or watch a
 * scratch copy.
 *
 * @returns The folder, or why it cannot be used.
 */
export function privateTempRoot(): string | { error: string } {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const root = path.join(os.tmpdir(), `dorkos-flow-${uid ?? 'user'}`);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { error: `could not make ${root}: ${(error as Error).message}` };
    }
  }
  let info;
  try {
    info = lstatSync(root);
  } catch (error) {
    return { error: `could not read ${root}: ${(error as Error).message}` };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { error: `${root} is not a folder flow made; remove it and try again` };
  }
  if (uid !== null && info.uid !== uid) {
    return { error: `${root} belongs to another user; flow will not use it` };
  }
  if ((info.mode & 0o077) !== 0) {
    try {
      chmodSync(root, 0o700);
    } catch (error) {
      return { error: `could not make ${root} private: ${(error as Error).message}` };
    }
  }
  return root;
}

/**
 * A fresh folder inside {@link privateTempRoot}.
 *
 * @param prefix - Its name's start.
 * @returns The folder, or why it could not be made.
 */
export function privateTempDir(prefix: string): string | { error: string } {
  const root = privateTempRoot();
  if (typeof root !== 'string') return root;
  try {
    return mkdtempSync(path.join(root, prefix));
  } catch (error) {
    return { error: `could not make a scratch folder: ${(error as Error).message}` };
  }
}

/**
 * The environment every isolated git call gets: {@link gitPath}, the locale,
 * and the switches that keep git from reading anything but the scratch
 * repository.
 *
 * @param from - The environment to take the locale and TMPDIR from.
 * @returns The environment.
 */
export function isolatedGitEnv(
  from: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ATTR_NOSYSTEM: '1',
  };
  env.PATH = gitPath();
  for (const key of ['LANG', 'TMPDIR']) {
    const value = from[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(from)) {
    if (/^LC_[A-Z]+$/.test(key) && value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Run `git --no-replace-objects <args>` in `cwd` with `env`.
 *
 * @param cwd - Where.
 * @param env - The whole environment.
 * @returns The runner.
 */
export function gitWith(cwd: string, env: Readonly<Record<string, string>>): GitRunner {
  return (args, input) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        // Its own process group, so a timeout stops every git it started.
        child = spawn('git', ['--no-replace-objects', ...args], {
          cwd,
          env: { ...env },
          shell: false,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: -1, stdout: '', stderr: (error as Error).message });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: GitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        finish({ code: -1, stdout, stderr: `${stderr}\ngit timed out after ${GIT_TIMEOUT_MS} ms` });
      }, GIT_TIMEOUT_MS);
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => finish({ code: -1, stdout, stderr: error.message }));
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
}

/** The first git that has `GIT_NO_LAZY_FETCH` (2.44). */
const MIN_GIT: readonly [number, number] = [2, 44];

/** Whether this git is new enough, asked once per process (only an answer is kept). */
let gitVersionProbe: Promise<boolean> | undefined;

/** Whether git is at least {@link MIN_GIT}. */
function gitIsNewEnough(env: Readonly<Record<string, string>>): Promise<boolean> {
  gitVersionProbe ??= gitWith(
    os.tmpdir(),
    env
  )(['version']).then((result) => {
    if (result.code === -1) gitVersionProbe = undefined;
    const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
    if (match === null) return false;
    const [major, minor] = [Number(match[1]), Number(match[2])];
    return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]);
  });
  return gitVersionProbe;
}

/** A scratch repository holding verified copies of a project's commits. */
export interface ScratchRepo {
  /** Its folder (the work tree; the repository is `<dir>/.git`). */
  dir: string;
  /** Runs isolated git in it. */
  git: GitRunner;
  /** Deletes it. Never throws. */
  remove(): void;
}

/**
 * The upload-pack the scratch repository fetches with: filters and fetching
 * any commit by SHA allowed, nothing else. A fixed string, never configurable.
 */
const UPLOAD_PACK =
  'git -c uploadpack.allowFilter=true -c uploadpack.allowAnySHA1InWant=true upload-pack';

/**
 * Make a scratch repository holding verified copies of `source`'s commits.
 *
 * @param source - Any folder inside the project's repository.
 * @param shas - The commits it must hold, fetched by SHA.
 * @param opts - `depth`: fetch only this much history (a `run:` checkout
 *   needs one commit). `refuseShallow`: refuse when the copy is shallow, whose
 *   history may stop before a merge base (the squash check).
 * @returns The scratch repository, or why it could not be made.
 */
export async function scratchRepo(
  source: string,
  shas: readonly string[],
  opts: { depth?: number; refuseShallow?: boolean } = {}
): Promise<ScratchRepo | string> {
  // Checked whole before git sees any of them, so none can be read as an option.
  if (shas.length === 0 || !shas.every((sha) => isFullSha(sha))) {
    return 'every commit to copy must be a full SHA';
  }
  const env = isolatedGitEnv();
  if (!(await gitIsNewEnough(env))) {
    return `git too old for a safe copy: it needs git ${MIN_GIT.join('.')} or later`;
  }
  const common = await gitWith(
    source,
    env
  )(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = common.stdout.trim();
  if (common.code !== 0 || commonDir === '' || !path.isAbsolute(commonDir)) {
    return `git could not find the repository of ${source}`;
  }
  const made = privateTempDir('scratch-');
  if (typeof made !== 'string') return made.error;
  const dir = made;
  const remove = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A folder the command left read-only stays behind in the temp folder.
    }
  };
  const git = gitWith(dir, env);
  const copying = gitWith(dir, { ...env, GIT_NO_LAZY_FETCH: '1' });
  const steps: string[][] = [
    ['init', '--quiet', '--template='],
    ['config', 'core.repositoryformatversion', '1'],
    ['config', 'extensions.partialClone', 'origin'],
    ['config', 'remote.origin.url', commonDir],
    ['config', 'remote.origin.uploadpack', UPLOAD_PACK],
    ['config', 'remote.origin.promisor', 'true'],
    ['config', 'remote.origin.partialclonefilter', 'blob:none'],
    ['config', 'maintenance.auto', 'false'],
    ['config', 'gc.auto', '0'],
    ['config', 'fetch.writeCommitGraph', 'false'],
  ];
  for (const step of steps) {
    const result = await git(step);
    if (result.code !== 0) {
      remove();
      return `could not set up a scratch repository: ${result.stderr.trim() || step.join(' ')}`;
    }
  }
  const fetched = await copying([
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--filter=blob:none',
    // A shallow project's boundary is recorded, never silently dropped, so
    // history walks stop at it and the copy knows it is shallow.
    '--update-shallow',
    ...(opts.depth === undefined ? [] : [`--depth=${opts.depth}`]),
    'origin',
    ...shas,
  ]);
  if (fetched.code !== 0) {
    remove();
    return `could not copy the commits from the repository: ${fetched.stderr.trim() || `git exited ${fetched.code}`}`;
  }
  for (const sha of shas) {
    if ((await git(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
      remove();
      return `the commit ${sha.slice(0, 7)} did not arrive in the scratch repository`;
    }
  }
  if (opts.refuseShallow) {
    const shallow = await git(['rev-parse', '--is-shallow-repository']);
    if (shallow.code !== 0 || shallow.stdout.trim() !== 'false') {
      remove();
      return 'the repository is shallow, so its history may stop before the merge base; run "git fetch --unshallow" in it';
    }
  }
  return { dir, git, remove };
}
