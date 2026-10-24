/**
 * Whole-string checks for every value the arm guard puts on a `gh` or `git`
 * command line (DOR-3262). Each is anchored at both ends, so a value either is
 * the thing it claims to be or it is refused; none of them can start with `-`
 * and so none can be read as an option.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/land/validate
 */

/** A workflow `gh workflow run` may dispatch: a file name or a plain name, no spaces. */
export const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A full 40-character commit SHA, lower-case. */
export function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The guard's nonce: 32 lower-case hex characters. */
export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/** A workflow file name or plain name (`land.preArm[].workflow` is held to it). */
export function isWorkflowName(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_NAME_PATTERN.test(value);
}

/**
 * A branch name the guard will pass on: letters, digits and `._/-`, not
 * starting with `-`, `.` or `/`, not ending with `/`, `.` or `.lock`, and
 * with no `..`, `//` or `/.` (a subset of `git check-ref-format`).
 */
export function isBranchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) &&
    !/(\.\.|\/\/|\/\.|\.lock$|\.lock\/|[./]$)/.test(value)
  );
}
