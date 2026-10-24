/**
 * One dependency PR at a time (DOR-3262 follow-up). Two PRs that both change
 * a lockfile or package manifest conflict once the first merges, so the merge
 * queue ejects the second. Flow therefore refuses to arm a PR that touches
 * one while another such PR is in the merge queue or armed, and refuses when
 * it cannot read the queue (it fails closed). This retires the manual "one
 * lockfile PR at a time" rule.
 *
 * Dependency files are the built-in security paths that install or pin
 * dependencies ({@link BUILTIN_SECURITY_GLOBS} without flow's own config),
 * matched the same way: in any case, Unicode-folded.
 *
 * Pure: the queue is read by the forge (`Forge.dependencyQueue`).
 *
 * @module @dorkos/flow/land/dependency-queue
 */

import type { QueuedPr } from '../forge/types.ts';
import { BUILTIN_SECURITY_GLOBS } from './arm-decision.ts';
import { matchesAny } from './glob.ts';

/** The built-in security paths that are dependencies. */
export const DEPENDENCY_GLOBS: readonly string[] = BUILTIN_SECURITY_GLOBS.filter(
  (glob) => glob !== '.agents/flow/config.json'
);

/**
 * Whether a PR touches a dependency file. An unknown file list counts as yes.
 *
 * @param files - Every path the PR touches, or `null` when unknown.
 * @returns `true` when it touches one, or may.
 */
export function touchesDependency(files: readonly string[] | null): boolean {
  return (
    files === null || files.some((file) => matchesAny(file, DEPENDENCY_GLOBS, { ignoreCase: true }))
  );
}

/** The rule's answer. */
export type DependencyAnswer =
  | { ok: true }
  | {
      ok: false;
      reason: 'dependency-queue-busy' | 'dependency-queue-unreadable';
      detail: string;
    };

/**
 * Whether a PR may be armed, given the merge queue and the armed PRs.
 *
 * @param pr - The PR to arm.
 * @param files - Its files, or `null` when unknown.
 * @param queue - Every PR in the merge queue or armed, or `null` when the
 *   forge could not read them.
 * @returns `ok`, or why not.
 */
export function dependencyConflict(
  pr: number,
  files: readonly string[] | null,
  queue: readonly QueuedPr[] | null
): DependencyAnswer {
  if (!touchesDependency(files)) return { ok: true };
  if (queue === null) {
    return {
      ok: false,
      reason: 'dependency-queue-unreadable',
      detail:
        'this PR changes dependencies, and flow could not read the merge queue to check for another dependency PR',
    };
  }
  const other = queue.find(
    (entry) =>
      entry.number !== pr && (entry.queued || entry.armed) && touchesDependency(entry.files)
  );
  if (other !== undefined) {
    return {
      ok: false,
      reason: 'dependency-queue-busy',
      detail: `another dependency PR is in the queue: #${other.number}${other.queued ? '' : ' (armed)'}; arm this after it lands`,
    };
  }
  return { ok: true };
}
