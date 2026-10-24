/**
 * `land.preArm` (DOR-3262): the checks flow runs before it arms auto-merge,
 * each only when the PR touches one of its paths. Every entry comes from the
 * committed config on `origin/main` ({@link readBaseLand}); nothing here takes
 * a command, a workflow name or an argument from the PR or from a model.
 *
 * Two forms:
 *
 * - `run: "<command>"` runs the command in a fresh, clean checkout of the
 *   reviewed head, made in a scratch repository the worker cannot configure
 *   (never the worker's worktree), with a minimal environment and a scratch
 *   HOME, and removes both afterwards. The checkout has no installed
 *   dependencies: a command that needs them installs them itself. There is no shell: the command is
 *   split on spaces (single or double quotes group words) and run as an argv
 *   array. A non-zero exit or a timeout refuses, with the output's tail in the
 *   refusal. `wait: workflow` is the form to prefer wherever a repo has CI;
 *   `run` is the fallback for a repo without it.
 * - `wait: "workflow"` dispatches exactly
 *   `gh workflow run <workflow> --ref <pr-branch> -f sha=<reviewed-head> -f nonce=<random>`
 *   and waits only on the run whose title contains that nonce and whose
 *   `headSha` is the reviewed head; any other run, however new, is ignored. A
 *   red run, no matching run before the timeout, or a branch that moved during
 *   the wait refuses. The workflow must be one a base-config entry names.
 *
 * Every value put on a command line is checked whole first
 * (`land/validate.ts`); one that fails is a refusal, never an escaped string.
 *
 * @module @dorkos/flow/land/pre-arm
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProcessRunner } from '../cli/context.ts';
import { PRE_ARM_COMMAND_PATTERN, type PreArmEntry } from '../config-schema.ts';
import type { Forge } from '../forge/types.ts';
import { scratchRepo } from './isolated-git.ts';
import { matchesAny } from './glob.ts';
import { isBranchName, isFullSha, isNonce, isWorkflowName } from './validate.ts';

/** How often the workflow wait looks again. */
export const WORKFLOW_POLL_MS = 15_000;
/** How much of a failed command's output a refusal carries. */
const OUTPUT_TAIL_CHARS = 4_000;

/** The PR a pre-arm pass checks. */
export interface PreArmTarget {
  /** A folder inside the project's repository (its objects are read from there). */
  worktree: string;
  /** The PR's branch on the forge. */
  branch: string;
  /** The reviewed commit, which must be the head throughout. */
  reviewedSha: string;
  /** Every path the PR touches, or `null` when unknown (then every entry runs). */
  files: readonly string[] | null;
}

/** What a pre-arm pass needs from the world. */
export interface PreArmIo {
  /** Runs commands with no shell. */
  runProcess: ProcessRunner;
  /** The forge the PR lives on. */
  forge: Forge;
  /** The clock. */
  now(): Date;
  /** Waits. */
  sleep(ms: number): Promise<void>;
  /** A fresh nonce (default: 128 random bits as hex). */
  nonce?(): string;
}

/** One entry's outcome. */
export interface PreArmOutcome {
  /** What the entry checks (its command or workflow). */
  entry: string;
  /** Skipped (no path touched), passed, or refused. */
  result: 'skipped' | 'passed' | 'refused';
  /** Why it refused, with the output's tail. */
  detail?: string;
}

/** The pass's answer: every entry's outcome, and whether all of them let it arm. */
export interface PreArmResult {
  /** Whether arming may go on. */
  ok: boolean;
  /** Per entry, in config order; stops at the first refusal. */
  outcomes: PreArmOutcome[];
}

/** What an entry is, for a person. */
export function describeEntry(entry: PreArmEntry): string {
  return 'run' in entry ? `run "${entry.run}"` : `workflow ${entry.workflow}`;
}

/** The last {@link OUTPUT_TAIL_CHARS} characters of a command's output. */
function tail(stdout: string, stderr: string): string {
  const text = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`.trim();
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text;
}

/**
 * Split a `run` command into argv with no shell: words split on spaces; a pair
 * of single or double quotes groups words and is removed. Nothing is expanded.
 *
 * @param command - The command.
 * @returns The argv, or `null` when it holds shell syntax or an unclosed quote.
 */
export function splitCommand(command: string): string[] | null {
  if (!PRE_ARM_COMMAND_PATTERN.test(command)) return null;
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === ' ') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  if (inWord) words.push(word);
  return words.length === 0 ? null : words;
}

/** Whether a PR's files send this entry (an unknown list sends every entry). */
export function entryTouched(entry: PreArmEntry, files: readonly string[] | null): boolean {
  return files === null || files.some((file) => matchesAny(file, entry.paths));
}

/**
 * The environment a `run` entry gets: an allow-list, never this process's.
 * PATH, the locale, the temp folder, the time zone and the terminal, plus
 * `CI=true` and `HOME` set to `home` (an empty scratch folder, so the PR's code
 * finds no `~/.config/gh`, `~/.npmrc` or other credentials there). No token, no
 * `GH_*`, no `*_TOKEN` and no cloud credential reaches the command, whatever
 * the agent's own environment holds.
 */
export function minimalEnv(
  home: string,
  from: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env: Record<string, string> = { CI: 'true', HOME: home };
  for (const [key, value] of Object.entries(from)) {
    if (value === undefined) continue;
    if (['PATH', 'LANG', 'TMPDIR', 'TZ', 'TERM'].includes(key) || /^LC_[A-Z]+$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Run one `run` entry in a fresh, clean checkout of the reviewed head, never in
 * the worker's worktree, and never through the project's own git settings:
 * the checkout is made in a scratch repository holding verified copies of the
 * project's commits (`land/isolated-git.ts`), so a worker's sparse checkout,
 * `git replace`, smudge filter, hook or overwritten object cannot change what
 * it holds.
 * Then `git clean -ffdx`, a check that the checkout is exactly the reviewed
 * commit, the command with {@link minimalEnv}, and the checkout and its
 * scratch HOME are removed whatever happened.
 */
async function runCommand(
  entry: Extract<PreArmEntry, { run: string }>,
  target: PreArmTarget,
  io: PreArmIo
): Promise<string | null> {
  const argv = splitCommand(entry.run);
  if (argv === null) {
    return `the command "${entry.run}" has shell syntax or an unclosed quote; flow runs commands with no shell`;
  }
  if (!isFullSha(target.reviewedSha)) {
    return `the reviewed commit "${target.reviewedSha}" is not a full SHA`;
  }
  const scratch = await scratchRepo(target.worktree, [target.reviewedSha], { depth: 1 });
  if (typeof scratch === 'string')
    return `could not make a checkout to run "${entry.run}": ${scratch}`;
  let home: string | null = null;
  try {
    const git = (args: string[]) => scratch.git(['-c', 'core.hooksPath=/dev/null', ...args]);
    const checkout = await git(['checkout', '--quiet', '--detach', target.reviewedSha]);
    if (checkout.code !== 0) {
      return `could not check out the reviewed commit ${target.reviewedSha.slice(0, 7)} to run "${entry.run}": ${checkout.stderr.trim() || `git exited ${checkout.code}`}`;
    }
    const cleaned = await git(['clean', '-ffdx', '--quiet']);
    const head = await git(['rev-parse', 'HEAD']);
    const status = await git(['status', '--porcelain', '--ignored']);
    if (
      cleaned.code !== 0 ||
      head.stdout.trim().toLowerCase() !== target.reviewedSha ||
      status.code !== 0 ||
      status.stdout.trim() !== ''
    ) {
      return `the fresh checkout for "${entry.run}" is not a clean copy of ${target.reviewedSha.slice(0, 7)}`;
    }
    home = mkdtempSync(path.join(os.tmpdir(), 'flow-prearm-home-'));
    let result;
    try {
      result = await io.runProcess(argv[0], argv.slice(1), {
        cwd: scratch.dir,
        env: minimalEnv(home),
        timeoutMs: entry.timeout * 60_000,
      });
    } catch (error) {
      return `"${entry.run}" did not finish within ${entry.timeout} minutes or could not start: ${(error as Error).message}`;
    }
    if (result.code !== 0) {
      const output = tail(result.stdout, result.stderr);
      return `"${entry.run}" exited ${result.code}${output ? `:\n${output}` : ''}`;
    }
    return null;
  } catch (error) {
    return `could not run "${entry.run}": ${(error as Error).message}`;
  } finally {
    scratch.remove();
    if (home !== null) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // Left in the temp folder.
      }
    }
  }
}

/**
 * Dispatch one workflow and wait for its run.
 *
 * @param workflow - The workflow to dispatch.
 * @param allowed - The workflows the base config names; any other is refused.
 * @param timeoutMinutes - How long to wait.
 * @param target - The PR.
 * @param io - The world.
 * @returns `null` when the run passed, else why it refused.
 */
export async function runWorkflow(
  workflow: string,
  allowed: readonly string[],
  timeoutMinutes: number,
  target: PreArmTarget,
  io: PreArmIo
): Promise<string | null> {
  if (!isWorkflowName(workflow) || !allowed.includes(workflow)) {
    return `the workflow "${workflow}" is not a land.preArm entry in the committed config on main`;
  }
  if (!isBranchName(target.branch)) {
    return `the branch name "${target.branch}" is not one flow will pass to gh`;
  }
  if (!isFullSha(target.reviewedSha)) {
    return `the reviewed commit "${target.reviewedSha}" is not a full SHA`;
  }
  const nonce = (io.nonce ?? (() => randomBytes(16).toString('hex')))();
  if (!isNonce(nonce)) return 'flow could not make a nonce for the dispatch';
  const sha = target.reviewedSha;
  const moved = async (): Promise<string | null> => {
    const head = (await io.forge.branchHead(target.branch))?.toLowerCase() ?? null;
    return head === sha
      ? null
      : `${target.branch} moved to ${head === null ? 'nothing' : head.slice(0, 7)} while ${workflow} ran for ${sha.slice(0, 7)}`;
  };
  try {
    const before = await moved();
    if (before !== null) return before;
    await io.forge.dispatchWorkflow(workflow, target.branch, { sha, nonce });
    const deadline = io.now().getTime() + timeoutMinutes * 60_000;
    for (;;) {
      const runs = (await io.forge.workflowRuns(workflow, target.branch)).filter(
        (run) => run.title.includes(nonce) && run.headSha === sha
      );
      if (runs.length > 1) {
        return `${runs.length} runs of ${workflow} carry this dispatch's nonce; flow cannot tell which is its own`;
      }
      const mine = runs[0];
      if (mine !== undefined && mine.completed) {
        if (mine.conclusion !== 'success') {
          return `${workflow} finished ${mine.conclusion || 'without a conclusion'} on ${sha.slice(0, 7)}${mine.url ? ` (${mine.url})` : ''}`;
        }
        return await moved();
      }
      const during = await moved();
      if (during !== null) return during;
      if (io.now().getTime() >= deadline) {
        return mine === undefined
          ? `no run of ${workflow} for this dispatch (nonce ${nonce}) on ${sha.slice(0, 7)} appeared within ${timeoutMinutes} minutes`
          : `${workflow} did not finish within ${timeoutMinutes} minutes${mine.url ? ` (${mine.url})` : ''}`;
      }
      await io.sleep(WORKFLOW_POLL_MS);
    }
  } catch (error) {
    return `${workflow}: ${(error as Error).message}`;
  }
}

/**
 * Run every `land.preArm` entry the PR's files send, in order, stopping at the
 * first refusal. No entries, or none touched, lets it arm unchanged.
 *
 * @param entries - The entries from the committed config on `origin/main`.
 * @param target - The PR.
 * @param io - The world.
 * @returns Each entry's outcome and whether arming may go on.
 */
export async function runPreArm(
  entries: readonly PreArmEntry[],
  target: PreArmTarget,
  io: PreArmIo
): Promise<PreArmResult> {
  const allowed = entries.flatMap((entry) => ('workflow' in entry ? [entry.workflow] : []));
  const outcomes: PreArmOutcome[] = [];
  for (const entry of entries) {
    const name = describeEntry(entry);
    if (!entryTouched(entry, target.files)) {
      outcomes.push({ entry: name, result: 'skipped' });
      continue;
    }
    const refusal =
      'run' in entry
        ? await runCommand(entry, target, io)
        : await runWorkflow(entry.workflow, allowed, entry.timeout, target, io);
    if (refusal !== null) {
      outcomes.push({ entry: name, result: 'refused', detail: refusal });
      return { ok: false, outcomes };
    }
    outcomes.push({ entry: name, result: 'passed' });
  }
  return { ok: true, outcomes };
}
