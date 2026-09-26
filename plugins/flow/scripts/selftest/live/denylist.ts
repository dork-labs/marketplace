/**
 * The words a live self-test session may not run (spec
 * `specs/flow-self-improvement` §1, tier `live`, breach check).
 *
 * Each is a way out of the sandbox to a real tracker, forge or network. This
 * is the one file in the plugin that spells a tracker tool's name outside an
 * adapter, because it must name it to forbid it; the tracker-confinement test
 * exempts this file and nothing else.
 *
 * @module @dorkos/flow/selftest/live/denylist
 */

/** Forbidden anywhere in a command, in any case: the tracker tool. */
export const FORBIDDEN_ANYWHERE = /\bcomposio\b/i;

/**
 * Forbidden as a command word: a token of its own, at the start, after a
 * separator, whitespace or a quote (so `node -e "execSync('gh pr list')"` is
 * caught, and `git grep "linear-issue:"` or `--ghost` are not).
 */
export const FORBIDDEN_COMMAND_WORD = /(?:^|[\s;&|(`'"])(curl|wget|gh)(?=$|[\s;&|)`'"])/;

/**
 * The forbidden name a command uses, or `undefined`.
 *
 * @param command - A shell command.
 * @returns The name, lowercased.
 */
export function forbiddenName(command: string): string | undefined {
  const anywhere = FORBIDDEN_ANYWHERE.exec(command);
  if (anywhere !== null) return anywhere[0].toLowerCase();
  return FORBIDDEN_COMMAND_WORD.exec(command)?.[1];
}
