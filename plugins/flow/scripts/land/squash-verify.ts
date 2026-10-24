/**
 * The post-merge squash check (DOR-3262): once a PR has merged, did the
 * squash commit on `main` land exactly what was reviewed?
 *
 * The reviewed head is always the commit recorded at review (the one the
 * security label was applied to), never the PR's head when it merged.
 *
 * - **Tree.** `git merge-tree --write-tree <squash>^ <reviewed>` merges the
 *   reviewed head into the commit the squash was made on. A conflict (exit 1)
 *   fails, never passes. Otherwise the first line of its output is the merged
 *   tree, and when it equals `git rev-parse <squash>^{tree}`: pass. This
 *   covers a squash whose patch differs only in context, because `main` moved
 *   lines near the change.
 * - **patch-id**, a diagnostic: whether the squash commit's patch has the same
 *   `git patch-id --stable` as the reviewed head's diff from its merge-base.
 *   It never passes on its own (see {@link verifySquash}).
 * - Anything else fails, with both trees and the files that differ; a check
 *   that could not run (a missing commit) is `unverified`, which is reported
 *   too and never counts as a pass. A git that cannot do the merge safely
 *   (before 2.40, or any merge-tree exit but 0 or 1) fails.
 * - The check runs in a scratch repository that reads the project's objects
 *   and nothing else ({@link verifySquashIsolated}), so the project's config,
 *   `info/attributes`, merge drivers and replace refs never reach the merge.
 *
 * A verdict and a report only: nothing here reverts, pushes, or touches a
 * status or label. Every git call is a fixed argv with full SHAs checked
 * whole first, run with no shell and `--no-replace-objects`, so a local
 * `git replace` cannot make two different trees look the same.
 *
 * @module @dorkos/flow/land/squash-verify
 */

import { spawn } from 'node:child_process';

import { scratchRepo, type GitResult, type GitRunner } from './isolated-git.ts';
import { isFullSha } from './validate.ts';

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 120_000;

export type { GitResult, GitRunner } from './isolated-git.ts';

/**
 * The real {@link GitRunner} for the project's own repository:
 * `git --no-replace-objects <args>` in `cwd`, with this process's environment.
 * Only for fetching what the check needs; the check itself runs in a scratch
 * repository ({@link verifySquashIsolated}).
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
          // Never wait on a credential prompt.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
      /** The check that passed: the trees match. */
      check: 'tree';
      /** Whether the patch-ids matched too (a diagnostic only; it never passes on its own). */
      patchIdMatch: boolean;
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
      /** Whether the patch-ids matched anyway (they can, for a different change). */
      patchIdMatch: boolean;
    }
  | {
      /** The check could not run: a commit is missing, git failed or is too old. Never a pass. */
      verdict: 'unverified';
      /** Why, in a sentence. */
      reason: string;
      /** The squash commit. */
      squash: string;
      /** The reviewed head. */
      reviewed: string;
    };

/** The empty tree's SHA (SHA-1), where the merge reads its attributes from. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Whether this git knows the global `--attr-source` option, once per process. */
let attrSourceProbe: Promise<boolean> | undefined;

/**
 * Whether git accepts `--attr-source` (git 2.40+), asked once and remembered.
 *
 * @param git - Runs git.
 * @returns `true` when it does.
 */
function supportsAttrSource(git: GitRunner): Promise<boolean> {
  attrSourceProbe ??= git([`--attr-source=${EMPTY_TREE}`, 'version']).then((result) => {
    // A git that could not start is asked again next time; only an answer is kept.
    if (result.code === -1) attrSourceProbe = undefined;
    return result.code === 0;
  });
  return attrSourceProbe;
}

/** Forget the probe's answer (tests). */
export function resetGitProbe(): void {
  attrSourceProbe = undefined;
}

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
 * It passes only when the trees match. A patch-id match is recorded but never
 * passes on its own: `git patch-id --stable` ignores whitespace and line
 * numbers, so a re-indented line, or the same hunk moved to another place with
 * the same context, has the reviewed patch's id while changing what the code
 * does. A squash merge of the reviewed head is expected to have the tree
 * `merge-tree(<squash>^, reviewed)` gives (a context-only shift included), so
 * the tree check passes those; a merge GitHub resolves differently is a loud
 * false alarm, never a false pass.
 *
 * @param git - Runs git in a checkout holding both commits.
 * @param input - The squash commit on `main` and the reviewed head, both full SHAs.
 * @returns Pass, fail with both trees and the files that differ, or unverified.
 */
export async function verifySquash(
  git: GitRunner,
  input: { squash: string; reviewed: string }
): Promise<SquashVerdict> {
  const squash = input.squash.toLowerCase();
  const reviewed = input.reviewed.toLowerCase();
  const unverified = (reason: string): SquashVerdict => ({
    verdict: 'unverified',
    reason,
    squash,
    reviewed,
  });
  if (!isFullSha(squash) || !isFullSha(reviewed)) {
    return unverified('the squash commit and the reviewed head must both be full SHAs');
  }
  for (const [name, sha] of [
    ['squash commit', squash],
    ['reviewed head', reviewed],
  ] as const) {
    const present = await git(['cat-file', '-e', `${sha}^{commit}`]);
    if (present.code !== 0) {
      return unverified(`the ${name} ${sha.slice(0, 7)} is not in this checkout`);
    }
  }
  const parents = await git(['rev-list', '--parents', '-n', '1', squash]);
  const words = firstLine(parents.stdout).split(/\s+/);
  if (parents.code !== 0)
    return unverified(`git could not read the parents of ${squash.slice(0, 7)}`);
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
    patchIdMatch: false,
    ...extra,
  });
  if (words.length !== 2 || !isFullSha(words[1])) {
    return fail(
      `${squash.slice(0, 7)} is not a squash commit (it has ${words.length - 1} parents), so flow cannot show it is what was reviewed`
    );
  }
  const parent = words[1];
  const treeOut = await git(['rev-parse', '--verify', `${squash}^{tree}`]);
  const squashTree = firstLine(treeOut.stdout);
  if (treeOut.code !== 0 || !isFullSha(squashTree)) {
    return unverified(`git could not read the tree of ${squash.slice(0, 7)}`);
  }

  // The patch-ids, recorded as a diagnostic.
  let patchIdMatch = false;
  const base = await git(['merge-base', parent, reviewed]);
  const mergeBase = firstLine(base.stdout);
  if (base.code === 0 && isFullSha(mergeBase)) {
    const [mine, theirs] = await Promise.all([
      patchId(git, await git(['diff-tree', '-p', '--no-color', parent, squash])),
      patchId(git, await git(['diff-tree', '-p', '--no-color', mergeBase, reviewed])),
    ]);
    patchIdMatch = mine !== null && mine === theirs;
  }

  // The check: merge the reviewed head into the squash's parent. merge-tree
  // exits 1 on a conflict and higher on an error (or a git without --write-tree).
  // Attributes come from the empty tree, so a `.gitattributes` in either
  // commit (a `merge=union` driver, say) cannot turn a conflict into a clean
  // merge. `--attr-source` is a global option (git 2.40+), so it goes before
  // the subcommand; a git that does not know it is refused up front.
  if (!(await supportsAttrSource(git))) {
    return fail('git too old for a safe squash check: it needs git 2.40 or later (--attr-source)', {
      squashTree,
      patchIdMatch,
    });
  }
  // The merge settings are pinned too, so this machine's git config (renames
  // off, directory renames on) cannot flip the verdict either way.
  const merged = await git([
    `--attr-source=${EMPTY_TREE}`,
    '-c',
    'merge.renames=true',
    '-c',
    'diff.renames=true',
    '-c',
    'merge.directoryRenames=conflict',
    '-c',
    'merge.renormalize=false',
    'merge-tree',
    '--write-tree',
    parent,
    reviewed,
  ]);
  const reviewedTree = firstLine(merged.stdout);
  if (merged.code === 1) {
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
      { squashTree, files, patchIdMatch }
    );
  }
  // Exit 1 is a conflict (above); any other non-zero exit, 129 for an option
  // this git does not know included, fails closed.
  if (merged.code !== 0 || !isFullSha(reviewedTree)) {
    return fail(
      merged.code === 129
        ? `git too old for a safe squash check: ${merged.stderr.trim() || 'merge-tree exited 129'}`
        : `git merge-tree --write-tree failed (exit ${merged.code}): ${merged.stderr.trim() || 'no output'}`,
      { squashTree, patchIdMatch }
    );
  }
  if (reviewedTree === squashTree) {
    return { verdict: 'pass', check: 'tree', patchIdMatch, squash, reviewed };
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
    { squashTree, reviewedTree, files, patchIdMatch }
  );
}

/**
 * {@link verifySquash} in a scratch repository that reads `source`'s objects
 * and nothing else (`land/isolated-git.ts`): the project's config, its
 * `info/attributes`, merge drivers, `merge.default` and replace refs, all of
 * which a worker can write, never reach the merge.
 *
 * @param source - A folder inside the project's repository, holding both commits.
 * @param input - The squash commit and the reviewed head.
 * @returns The verdict; `unverified` when the scratch repository could not be made.
 */
export async function verifySquashIsolated(
  source: string,
  input: { squash: string; reviewed: string }
): Promise<SquashVerdict> {
  const scratch = await scratchRepo(source);
  if (typeof scratch === 'string') {
    return {
      verdict: 'unverified',
      reason: scratch,
      squash: input.squash.toLowerCase(),
      reviewed: input.reviewed.toLowerCase(),
    };
  }
  try {
    return await verifySquash(scratch.git, input);
  } finally {
    scratch.remove();
  }
}

/** A name from the repository, safe inside a fenced block (no backtick runs, one line). */
function fenced(name: string): string {
  return name.replace(/`/g, "'").replace(/[\r\n]/g, ' ');
}

/**
 * The loud report of a check that did not pass, for the PR.
 *
 * @param verdict - A failed or unverified verdict.
 * @param mentions - Who to name (the PR's author, the security reviewer), as `@handle`s.
 * @returns The comment body.
 */
export function squashReport(
  verdict: Exclude<SquashVerdict, { verdict: 'pass' }>,
  mentions: readonly string[]
): string {
  const who = mentions.length > 0 ? `${mentions.join(' ')}: ` : '';
  if (verdict.verdict === 'unverified') {
    return [
      `${who}**Squash check could not run.** ${verdict.reason}.`,
      '',
      `- Squash commit: \`${verdict.squash}\``,
      `- Reviewed head: \`${verdict.reviewed}\``,
      '',
      'Nobody has shown the squash is what was reviewed. Check it by hand, or run `flow squash-check` again. Flow reverted nothing and changed no status.',
    ].join('\n');
  }
  const files = verdict.files.slice(0, 50).map(fenced);
  return [
    `${who}**Squash check failed.** ${verdict.reason}.`,
    '',
    `- Squash commit: \`${verdict.squash}\`, tree \`${verdict.squashTree ?? 'unknown'}\``,
    `- Reviewed head: \`${verdict.reviewed}\`, merged into the squash's parent: tree \`${verdict.reviewedTree ?? 'none'}\``,
    `- Patch-ids ${verdict.patchIdMatch ? 'match, but that alone proves nothing' : 'differ'}`,
    '- Files that differ:',
    '',
    '```text',
    ...(files.length === 0 ? ['(none listed)'] : files),
    ...(verdict.files.length > 50 ? [`... and ${verdict.files.length - 50} more`] : []),
    '```',
    '',
    'Flow reverted nothing and changed no status. A person decides what happens next.',
  ].join('\n');
}
