/**
 * Git the worker cannot configure (DOR-3262). The arm guard's `run:` checkout
 * and the squash check both read commits from the project's repository, which
 * every worktree shares and any worker can write to: its config (filters,
 * merge drivers, `merge.default`), `info/attributes`, `refs/replace`, sparse
 * checkout. Any of those can change what a checkout contains or what a merge
 * gives, while every SHA still looks right.
 *
 * So both run git in a scratch repository instead: `git init` in a temp
 * folder, with the project's object folder added as an alternate
 * (`objects/info/alternates`). It reads the same commits, and nothing else: its
 * config is fresh, its `info/` is empty, it has no refs. Every git call runs
 * with {@link isolatedGitEnv}: no system or global config, no replace objects,
 * no inherited `GIT_*` variable, no credential prompt.
 *
 * @module @dorkos/flow/land/isolated-git
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * Make a scratch repository that reads `source`'s objects and nothing else.
 *
 * @param source - Any folder inside the project's repository.
 * @returns The scratch repository, or why it could not be made.
 */
export async function scratchRepo(source: string): Promise<ScratchRepo | string> {
  const env = isolatedGitEnv();
  const common = await gitWith(
    source,
    env
  )(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = common.stdout.trim();
  if (common.code !== 0 || commonDir === '' || !path.isAbsolute(commonDir)) {
    return `git could not find the repository of ${source}`;
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
  const git = gitWith(dir, env);
  const init = await git(['init', '--quiet']);
  if (init.code !== 0) {
    remove();
    return `could not make a scratch repository: ${init.stderr.trim()}`;
  }
  try {
    writeFileSync(
      path.join(dir, '.git', 'objects', 'info', 'alternates'),
      `${path.join(commonDir, 'objects')}\n`
    );
  } catch (error) {
    remove();
    return `could not point the scratch repository at ${commonDir}: ${(error as Error).message}`;
  }
  return { dir, git, remove };
}
