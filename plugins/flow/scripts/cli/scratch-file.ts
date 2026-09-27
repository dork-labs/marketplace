/**
 * Text a verb takes inline or from a file, and the scratch-file rule both
 * `flow create` (`--description-file`) and `flow triage` (`--question-file`)
 * follow: a file under `.dork/flow/tmp/` in the project is flow's scratch,
 * kept out of git while it exists and removed once the verb is done with it.
 *
 * - A file anywhere else is left alone, judged by real path: a `.dork`,
 *   `.dork/flow` or `.dork/flow/tmp` that links out of the project makes
 *   nothing scratch, and only a regular file (not a link) counts. That is
 *   checked when the file is read and again right before it is removed.
 * - Reading a scratch file (except on a dry run) adds `.dork/flow/tmp/` to
 *   git's local exclude unless git already ignores it.
 * - A failed or dry run keeps the file, for the retry.
 *
 * @module @dorkos/flow/cli/scratch-file
 */

import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';

import { UsageError } from '../errors.ts';
import { ensureIgnored } from '../git-exclude.ts';
import type { VerbContext } from './context.ts';

/** Where a text file is scratch that flow removes once it is done with it. */
export const SCRATCH_DIR = path.join('.dork', 'flow', 'tmp');

/** Text read from a flag, and the scratch file to remove once the run is done with it. */
export interface FlagText {
  /** The text. */
  text: string;
  /**
   * The file as given (resolved against the project), when it was scratch at
   * read time. {@link removeScratch} checks it again before it deletes anything.
   */
  scratch?: string;
}

/**
 * The text from an inline flag or its file flag, never both.
 *
 * @param ctx - The verb's context.
 * @param flags - The two flag names, and what the text is, for messages.
 * @param flags.inline - The inline flag, e.g. `description`.
 * @param flags.file - The file flag, e.g. `description-file`.
 * @param flags.what - What the text is, e.g. `description`.
 * @returns The text, or `undefined` when neither flag was given.
 * @throws {UsageError} When both are given, or the file cannot be read.
 */
export function flagText(
  ctx: VerbContext,
  flags: { inline: string; file: string; what: string }
): FlagText | undefined {
  const inline = ctx.args.flags[flags.inline];
  const file = ctx.args.flags[flags.file];
  if (typeof inline === 'string' && typeof file === 'string') {
    throw new UsageError(`pass --${flags.inline} or --${flags.file}, not both`);
  }
  if (typeof inline === 'string') return { text: inline };
  if (typeof file !== 'string') return undefined;
  const resolved = path.resolve(ctx.projectDir, file);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    throw new UsageError(`could not read the ${flags.what} file ${resolved}`);
  }
  const real = scratchFile(ctx, resolved);
  if (real === undefined) return { text };
  if (!ctx.dryRun) {
    try {
      const project = realpathSync(ctx.projectDir);
      ensureIgnored(
        project,
        path.relative(project, real),
        `${SCRATCH_DIR.split(path.sep).join('/')}/`
      );
    } catch {
      // Not a git checkout, or git missing: the file is removed after the run anyway.
    }
  }
  return { text, scratch: resolved };
}

/**
 * The real path of a file that is flow's scratch, else `undefined`. Any path
 * that cannot be resolved counts as not scratch.
 */
function scratchFile(ctx: VerbContext, file: string): string | undefined {
  try {
    const project = realpathSync(ctx.projectDir);
    const tmp = realpathSync(path.join(ctx.projectDir, SCRATCH_DIR));
    if (tmp !== path.join(project, SCRATCH_DIR)) return undefined;
    if (!lstatSync(file).isFile()) return undefined;
    const real = realpathSync(file);
    const rel = path.relative(tmp, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/**
 * Remove a scratch file once the verb is done with it, so none is left behind
 * in a repo where `.dork/flow/` is not ignored. The scratch checks run again
 * first: a folder swapped for a link during the tracker call is never followed.
 *
 * @param ctx - The verb's context.
 * @param file - {@link FlagText.scratch}, when there is one.
 */
export function removeScratch(ctx: VerbContext, file: string | undefined): void {
  if (file === undefined) return;
  const real = scratchFile(ctx, file);
  if (real !== undefined) rmSync(real, { force: true });
}
