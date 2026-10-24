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
 * So both run git in a scratch repository instead: a blob-less `--no-local`
 * clone of the project over `file://`, into a temp folder, with no template.
 * Every object reaches it through git's fetch protocol, which re-hashes each
 * one and checks that the history connects, so a swapped object fails the
 * fetch rather than reaching the check; the blobs a checkout or a merge needs
 * later are fetched the same way. Its config is fresh, its `info/` is empty,
 * and it has no replace refs. Every git call runs with {@link isolatedGitEnv}:
 * no system or global config, no replace objects, no inherited `GIT_*`
 * variable, no credential prompt.
 *
 * @module @dorkos/flow/land/isolated-git
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

/**
 * The environment every isolated git call gets: PATH and the locale, and the
 * switches that keep git from reading anything but the scratch repository.
 *
 * @param from - The environment to take PATH and the locale from.
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
  for (const key of ['PATH', 'LANG', 'TMPDIR']) {
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
      let child;
      try {
        child = spawn('git', ['--no-replace-objects', ...args], {
          cwd,
          env: { ...env },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: GIT_TIMEOUT_MS,
        });
      } catch (error) {
        resolve({ code: -1, stdout: '', stderr: (error as Error).message });
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    });
}

/** A scratch repository borrowing a project's objects. */
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
 * @param shas - Commits it must hold (fetched by SHA when the clone lacks them).
 * @param opts - `refuseShallow`: refuse a shallow project, whose history
 *   stops where a merge base may lie (and whose `shallow` file is worker-writable).
 * @returns The scratch repository, or why it could not be made.
 */
export async function scratchRepo(
  source: string,
  shas: readonly string[],
  opts: { refuseShallow?: boolean } = {}
): Promise<ScratchRepo | string> {
  // Checked whole before git sees any of them, so none can be read as an option.
  if (!shas.every((sha) => isFullSha(sha))) return 'every commit to copy must be a full SHA';
  const env = isolatedGitEnv();
  const common = await gitWith(
    source,
    env
  )(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = common.stdout.trim();
  if (common.code !== 0 || commonDir === '' || !path.isAbsolute(commonDir)) {
    return `git could not find the repository of ${source}`;
  }
  if (opts.refuseShallow && existsSync(path.join(commonDir, 'shallow'))) {
    return `the repository at ${commonDir} is shallow, so its history may stop before the merge base`;
  }
  let dir: string;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'flow-scratch-'));
  } catch (error) {
    return `could not make a scratch folder: ${(error as Error).message}`;
  }
  const remove = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A folder the command left read-only stays behind in the temp folder.
    }
  };
  const outside = gitWith(os.tmpdir(), env);
  const cloned = await outside([
    'clone',
    '--quiet',
    '--no-checkout',
    '--no-local',
    '--no-tags',
    '--template=',
    '--filter=blob:none',
    `--upload-pack=${UPLOAD_PACK}`,
    `file://${commonDir}`,
    dir,
  ]);
  if (cloned.code !== 0) {
    remove();
    return `could not copy the repository's commits into a scratch repository: ${cloned.stderr.trim() || `git exited ${cloned.code}`}`;
  }
  const git = gitWith(dir, env);
  // Later fetches (the blobs a checkout or merge needs) use the same upload-pack.
  const configured = await git(['config', 'remote.origin.uploadpack', UPLOAD_PACK]);
  if (configured.code !== 0) {
    remove();
    return 'could not configure the scratch repository';
  }
  for (const sha of shas) {
    if ((await git(['cat-file', '-e', `${sha}^{commit}`])).code === 0) continue;
    const fetched = await git([
      'fetch',
      '--quiet',
      '--no-tags',
      '--filter=blob:none',
      'origin',
      sha,
    ]);
    if (fetched.code !== 0 || (await git(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
      remove();
      return `the commit ${sha.slice(0, 7)} could not be copied from the repository: ${fetched.stderr.trim() || 'not there'}`;
    }
  }
  return { dir, git, remove };
}
