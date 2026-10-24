/**
 * The post-merge squash check (DOR-3262): once a PR has merged, did the
 * squash commit on `main` land exactly what was reviewed?
 *
 * The reviewed head is always the commit recorded at review (the one the
 * security label was applied to), never the PR's head when it merged.
 *
 * 1. **patch-id.** The squash commit's patch (`<squash>^` to `<squash>`) has
 *    the same `git patch-id --stable` as the reviewed head's diff from its
 *    merge-base with `<squash>^`: pass.
 * 2. **Tree, the fallback.** `git merge-tree --write-tree <squash>^ <reviewed>`
 *    merges the reviewed head into the commit the squash was made on. A
 *    non-zero exit (a conflict) fails, never passes. Otherwise the first line
 *    of its output is the merged tree, and when it equals
 *    `git rev-parse <squash>^{tree}`: pass. This covers a squash whose
 *    patch differs only in context, because `main` moved lines near the change.
 * 3. Neither: fail, with both trees and the files that differ.
 *
 * A verdict and a report only: nothing here reverts, pushes, or touches a
 * status or label. Every git call is a fixed argv with full SHAs checked
 * whole first, run with no shell and `--no-replace-objects`, so a local
 * `git replace` cannot make two different trees look the same.
 *
 * @module @dorkos/flow/land/squash-verify
 */

import { spawn } from 'node:child_process';

import { isFullSha } from './validate.ts';

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 120_000;

/** One git call's result. */
export interface GitResult {
  /** The exit code (`-1` when git could not start or timed out). */
  code: number;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
}

/** Runs git with no shell in a checkout, optionally feeding it standard input. */
export type GitRunner = (args: readonly string[], input?: string) => Promise<GitResult>;

/**
 * The real {@link GitRunner}: `git --no-replace-objects <args>` in `cwd`.
 *
 * @param cwd - A checkout of the repository.
 * @returns The runner.
 */
export function gitIn(cwd: string): GitRunner {
  return (args, input) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawn('git', ['--no-replace-objects', ...args], {
          cwd,
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

/** The check's answer. */
export type SquashVerdict =
  | {
      verdict: 'pass';
      /** Which check passed. */
      check: 'patch-id' | 'tree';
      /** The squash commit. */
      squash: string;
      /** The reviewed head. */
      reviewed: string;
    }
  | {
      verdict: 'fail';
      /** Why, in a sentence. */
      reason: string;
      /** The squash commit. */
      squash: string;
      /** The reviewed head. */
      reviewed: string;
      /** The squash commit's tree, when git could read it. */
      squashTree: string | null;
      /** The tree merging the reviewed head into the squash's parent gives, when it merged cleanly. */
      reviewedTree: string | null;
      /** The files that differ between the two (or conflict, on a conflict). */
      files: string[];
    };

/** One line of output, trimmed. */
function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

/** The stable patch-id of a patch, or `null` when the patch is empty or git failed. */
async function patchId(git: GitRunner, patch: GitResult): Promise<string | null> {
  if (patch.code !== 0 || patch.stdout.trim() === '') return null;
  const id = await git(['patch-id', '--stable'], patch.stdout);
  const value = firstLine(id.stdout).split(/\s+/)[0] ?? '';
  return id.code === 0 && /^[0-9a-f]{40,64}$/.test(value) ? value : null;
}

/**
 * Check a squash commit against the reviewed head.
 *
 * @param git - Runs git in a checkout holding both commits.
 * @param input - The squash commit on `main` and the reviewed head, both full SHAs.
 * @returns Pass (and which check), or fail with both trees and the files that differ.
 */
export async function verifySquash(
  git: GitRunner,
  input: { squash: string; reviewed: string }
): Promise<SquashVerdict> {
  const squash = input.squash.toLowerCase();
  const reviewed = input.reviewed.toLowerCase();
  const fail = (
    reason: string,
    extra: Partial<Extract<SquashVerdict, { verdict: 'fail' }>> = {}
  ): SquashVerdict => ({
    verdict: 'fail',
    reason,
    squash,
    reviewed,
    squashTree: null,
    reviewedTree: null,
    files: [],
    ...extra,
  });
  if (!isFullSha(squash) || !isFullSha(reviewed)) {
    return fail('the squash commit and the reviewed head must both be full SHAs');
  }
  for (const [name, sha] of [
    ['squash commit', squash],
    ['reviewed head', reviewed],
  ] as const) {
    const present = await git(['cat-file', '-e', `${sha}^{commit}`]);
    if (present.code !== 0) return fail(`the ${name} ${sha.slice(0, 7)} is not in this checkout`);
  }
  const parents = await git(['rev-list', '--parents', '-n', '1', squash]);
  const words = firstLine(parents.stdout).split(/\s+/);
  if (parents.code !== 0 || words.length !== 2 || !isFullSha(words[1])) {
    return fail(
      `${squash.slice(0, 7)} is not a squash commit (it has ${words.length - 1} parents)`
    );
  }
  const parent = words[1];
  const treeOut = await git(['rev-parse', '--verify', `${squash}^{tree}`]);
  const squashTree = firstLine(treeOut.stdout);
  if (treeOut.code !== 0 || !isFullSha(squashTree)) {
    return fail(`could not read the tree of ${squash.slice(0, 7)}`);
  }

  // Check 1: patch-id.
  const base = await git(['merge-base', parent, reviewed]);
  const mergeBase = firstLine(base.stdout);
  if (base.code === 0 && isFullSha(mergeBase)) {
    const [mine, theirs] = await Promise.all([
      patchId(git, await git(['diff-tree', '-p', '--no-color', parent, squash])),
      patchId(git, await git(['diff-tree', '-p', '--no-color', mergeBase, reviewed])),
    ]);
    if (mine !== null && mine === theirs) {
      return { verdict: 'pass', check: 'patch-id', squash, reviewed };
    }
  }

  // Check 2: the fallback.
  const merged = await git(['merge-tree', '--write-tree', parent, reviewed]);
  const reviewedTree = firstLine(merged.stdout);
  if (merged.code !== 0) {
    const files = [
      ...new Set(
        merged.stdout
          .split('\n')
          .slice(1)
          .flatMap((line) => (line.includes('\t') ? [line.split('\t')[1]] : []))
      ),
    ];
    return fail(
      `the reviewed head ${reviewed.slice(0, 7)} conflicts with ${parent.slice(0, 7)}, the commit the squash was made on, so it cannot be what merged`,
      { squashTree, reviewedTree: null, files }
    );
  }
  if (!isFullSha(reviewedTree)) {
    return fail('git merge-tree printed no tree', { squashTree });
  }
  if (reviewedTree === squashTree) {
    return { verdict: 'pass', check: 'tree', squash, reviewed };
  }
  const diff = await git([
    'diff-tree',
    '-r',
    '--name-only',
    '--no-color',
    reviewedTree,
    squashTree,
  ]);
  const files = diff.stdout.split('\n').filter((line) => line.trim() !== '');
  return fail(
    `the squash commit ${squash.slice(0, 7)} is not what was reviewed at ${reviewed.slice(0, 7)}`,
    { squashTree, reviewedTree, files }
  );
}

/**
 * The loud report of a failed check, for the PR.
 *
 * @param verdict - A failed verdict.
 * @param mentions - Who to name (the PR's author, the security reviewer), as `@handle`s.
 * @returns The comment body.
 */
export function squashReport(
  verdict: Extract<SquashVerdict, { verdict: 'fail' }>,
  mentions: readonly string[]
): string {
  const who = mentions.length > 0 ? `${mentions.join(' ')}: ` : '';
  const files =
    verdict.files.length === 0
      ? 'none listed'
      : verdict.files
          .slice(0, 50)
          .map((file) => `\`${file}\``)
          .join(', ') +
        (verdict.files.length > 50 ? `, and ${verdict.files.length - 50} more` : '');
  return [
    `${who}**Squash check failed.** ${verdict.reason}.`,
    '',
    `- Squash commit: \`${verdict.squash}\`, tree \`${verdict.squashTree ?? 'unknown'}\``,
    `- Reviewed head: \`${verdict.reviewed}\`, merged into the squash's parent: tree \`${verdict.reviewedTree ?? 'none (it conflicts)'}\``,
    `- Files that differ: ${files}`,
    '',
    'Flow reverted nothing and changed no status. A person decides what happens next.',
  ].join('\n');
}
