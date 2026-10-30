/**
 * The proof test a bug fix ships (DOR-3261): one class-level test that fails on
 * the code before the fix and passes after, covering the whole class of the bug.
 *
 * `flow proof` records it in `<worktree>/.dork/flow/proof/<identifier>.json`.
 * Both hand-offs to review read it back for a bug item (`signal`): `flow stage
 * <id> review`, and a drain worker's `flow report <id> pushed` (the item's
 * type is on its run from `flow claim`). Each refuses unless it was recorded at
 * that commit and every test it names is still added or changed on the branch.
 * flow runs no test itself: the record carries the red and green output, and
 * the independent reviewer checks it.
 *
 * @module @dorkos/flow/proof
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { PreconditionError, UsageError } from './errors.ts';
import type { ProcessResult, VerbContext } from './cli/context.ts';
import type { WorkItem } from './tracker/types.ts';

/** Where proof records live, under the worktree root. */
export const PROOF_DIR = '.dork/flow/proof';

/** The `.git/info/exclude` line that keeps proof records out of commits. */
export const PROOF_EXCLUDE_LINE = '/.dork/flow/proof/';

/** How much of each run's output a record keeps: its last lines. */
export const OUTPUT_TAIL_LINES = 40;

/** The base a proof's tests are diffed against when `--base` is not given. */
export const DEFAULT_BASE = 'origin/HEAD';

/** The work-item type a bug is captured as (triage: Bug / Signal). */
export const BUG_TYPE: WorkItem['type'] = 'signal';

/** The stage whose entry needs a proof. */
export const PROOF_STAGE = 'review';

/** One proof record. */
export const ProofRecordSchema = z.object({
  v: z.literal(1),
  identifier: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  tests: z.array(z.string().min(1)).min(1),
  bugClass: z.string().min(1),
  command: z.string().min(1),
  red: z.string().min(1),
  green: z.string().min(1),
  recordedAt: z.string().min(1),
});

/** A parsed proof record. */
export type ProofRecord = z.infer<typeof ProofRecordSchema>;

/**
 * The record's path for an identifier. Identifiers are tracker keys
 * (`DOR-123`); anything else could escape the folder, so it is refused.
 *
 * @param root - The worktree's top-level folder.
 * @param identifier - The work item.
 * @returns The absolute path of its record.
 * @throws {UsageError} For an identifier that is not a plain key (exit 2).
 */
export function proofPath(root: string, identifier: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier) || identifier.includes('..')) {
    throw new UsageError(`"${identifier}" is not a work-item identifier`);
  }
  return path.join(root, PROOF_DIR, `${identifier}.json`);
}

/**
 * The last {@link OUTPUT_TAIL_LINES} lines of a run's output, trimmed.
 *
 * @param text - The whole output.
 * @returns Its tail.
 */
export function outputTail(text: string): string {
  return text.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n').trim();
}

/** Run git in `cwd`; a git that cannot start reads as a failed command. */
async function git(ctx: VerbContext, cwd: string, args: readonly string[]): Promise<ProcessResult> {
  try {
    return await ctx.runProcess('git', args, { cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: -1, stdout: '', stderr: message };
  }
}

/** The git facts a proof is measured against. */
export interface ProofFacts {
  /** The worktree's top-level folder. */
  root: string;
  /** HEAD. */
  headSha: string;
  /** The merge base of HEAD and the base ref. */
  baseSha: string;
  /** Every path changed between the merge base and HEAD (committed only). */
  changed: ReadonlySet<string>;
}

/**
 * The worktree's top-level folder.
 *
 * @param ctx - The verb context.
 * @param dir - Any folder in the worktree.
 * @returns Its top level.
 * @throws {PreconditionError} Outside a git worktree (exit 5).
 */
export async function worktreeTop(ctx: VerbContext, dir: string): Promise<string> {
  const top = await git(ctx, dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.stdout.trim() === '') {
    throw new PreconditionError(
      `${dir} is not a git worktree; run flow in the item's worktree, or pass --project`
    );
  }
  return top.stdout.trim();
}

/**
 * Measure a commit, its merge base with `base`, and the files the branch adds
 * or changes between them (a deleted test cannot be run, so it never counts).
 *
 * @param ctx - The verb context.
 * @param base - The base ref, e.g. `origin/HEAD`.
 * @param where - The worktree (default `ctx.projectDir`) and the commit (default `HEAD`).
 * @returns The facts.
 * @throws {PreconditionError} Outside a git worktree, or when the base cannot be resolved (exit 5).
 */
export async function measureProof(
  ctx: VerbContext,
  base: string,
  where: { dir?: string; head?: string } = {}
): Promise<ProofFacts> {
  const root = await worktreeTop(ctx, where.dir ?? ctx.projectDir);
  const head = await git(ctx, root, ['rev-parse', '--verify', `${where.head ?? 'HEAD'}^{commit}`]);
  if (head.code !== 0) throw new PreconditionError(`${root} has no commit yet`);
  const headSha = head.stdout.trim();
  const mergeBase = await git(ctx, root, ['merge-base', headSha, base]);
  if (mergeBase.code !== 0 || mergeBase.stdout.trim() === '') {
    throw new PreconditionError(
      `cannot find where this branch left ${base}: ${mergeBase.stderr.trim() || 'no merge base'}; pass --base <ref>`
    );
  }
  const baseSha = mergeBase.stdout.trim();
  const diff = await git(ctx, root, [
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=AM',
    '-z',
    baseSha,
    headSha,
  ]);
  if (diff.code !== 0) {
    throw new PreconditionError(`git diff failed in ${root}: ${diff.stderr.trim()}`);
  }
  const changed = new Set(diff.stdout.split('\0').filter((name) => name !== ''));
  return { root, headSha, baseSha, changed };
}

/**
 * A test path as git names it: forward slashes, no leading `./`.
 *
 * @param test - The path as given.
 * @returns It normalised.
 */
export function normaliseTestPath(test: string): string {
  return path.posix.normalize(test.trim().replaceAll('\\', '/')).replace(/^(\.\/)+/, '');
}

/**
 * The tests a branch does not add or change, in order. A proof test must be
 * new or changed on the branch: a test that already passed before the fix
 * proves nothing.
 *
 * @param tests - The test paths, relative to the repository root.
 * @param changed - The paths the branch adds or changes.
 * @returns The ones missing from the diff.
 */
export function unchangedTests(tests: readonly string[], changed: ReadonlySet<string>): string[] {
  return tests.filter((test) => !changed.has(test));
}

/** Why a proof does or does not let an item into review. */
export type ProofCheck = { ok: true; record: ProofRecord } | { ok: false; message: string };

/**
 * Check a bug item's proof against the branch as it is now (DOR-3261).
 *
 * @param identifier - The work item.
 * @param text - The record's text, or `null` when there is none.
 * @param facts - HEAD and the committed diff now.
 * @returns `ok`, or the refusal to print.
 */
export function checkProof(
  identifier: string,
  text: string | null,
  facts: Pick<ProofFacts, 'headSha' | 'changed'>
): ProofCheck {
  const record = `flow proof ${identifier} --tests <paths> --class <the bug class> --command <cmd> --red-file <f> --green-file <f>`;
  if (text === null) {
    return {
      ok: false,
      message: `${identifier} is a bug fix with no proof test: write a class-level test that fails before the fix and passes after, then record it with ${record}`,
    };
  }
  let parsed: ReturnType<typeof ProofRecordSchema.safeParse>;
  try {
    parsed = ProofRecordSchema.safeParse(JSON.parse(text));
  } catch {
    return {
      ok: false,
      message: `the proof record for ${identifier} is not JSON; record it again with ${record}`,
    };
  }
  if (!parsed.success || parsed.data.identifier !== identifier) {
    return {
      ok: false,
      message: `the proof record for ${identifier} is not valid; record it again with ${record}`,
    };
  }
  const proof = parsed.data;
  if (proof.headSha !== facts.headSha) {
    return {
      ok: false,
      message: `the proof for ${identifier} was recorded at ${proof.headSha.slice(0, 7)}, but the branch is at ${facts.headSha.slice(0, 7)}: run the proof test at the head and record it again`,
    };
  }
  const missing = unchangedTests(proof.tests, facts.changed);
  if (missing.length > 0) {
    return {
      ok: false,
      message: `the proof for ${identifier} names tests this branch no longer adds or changes: ${missing.join(', ')}`,
    };
  }
  return { ok: true, record: proof };
}

/**
 * Whether moving `item` to `stage` needs a proof: a bug entering review.
 *
 * @param item - The work item.
 * @param stage - The stage it moves to.
 * @returns `true` when the move needs a proof.
 */
export function needsProof(item: Pick<WorkItem, 'type'>, stage: string): boolean {
  return stage === PROOF_STAGE && item.type === BUG_TYPE;
}

/**
 * Read a proof record's text, or `null` when there is none.
 *
 * @param file - The record's path.
 * @returns Its text, or `null`.
 */
export function readProofText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Refuse a bug item's move into review without a current proof (DOR-3261).
 * Called by `flow stage` before any write, dry runs included.
 *
 * @param ctx - The verb context.
 * @param item - The work item.
 * @param stage - The stage it moves to.
 * @throws {PreconditionError} When the move needs a proof and has none that holds (exit 5).
 */
export async function requireProof(
  ctx: VerbContext,
  item: Pick<WorkItem, 'type' | 'identifier'>,
  stage: string
): Promise<void> {
  if (!needsProof(item, stage)) return;
  await requireProofAt(ctx, item.identifier, {});
}

/**
 * Refuse unless the item's proof in a worktree holds at a commit (DOR-3261).
 * The shared check behind `flow stage <id> review` (the worktree's HEAD) and a
 * drain worker's `flow report <id> pushed` (the pushed commit).
 *
 * @param ctx - The verb context.
 * @param identifier - The work item.
 * @param where - The worktree (default `ctx.projectDir`) and commit (default `HEAD`).
 * @throws {PreconditionError} When there is no proof that holds there (exit 5).
 */
export async function requireProofAt(
  ctx: VerbContext,
  identifier: string,
  where: { dir?: string; head?: string }
): Promise<void> {
  const root = await worktreeTop(ctx, where.dir ?? ctx.projectDir);
  const text = readProofText(proofPath(root, identifier));
  // No record: refuse before measuring, so a missing base cannot hide the reason.
  const facts =
    text === null
      ? { headSha: '', changed: new Set<string>() }
      : await measureProof(ctx, proofBase(text), { dir: root, head: where.head });
  const checked = checkProof(identifier, text, facts);
  if (!checked.ok) throw new PreconditionError(`review refused: ${checked.message}`);
}

/**
 * The base to diff against when checking: the record's own merge base, so a
 * moved `origin/HEAD` does not change the answer; else the default.
 */
function proofBase(text: string | null): string {
  if (text === null) return DEFAULT_BASE;
  try {
    const parsed = ProofRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.baseSha : DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}
