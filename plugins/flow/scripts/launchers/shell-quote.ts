/**
 * POSIX shell quoting for the one shell line flow builds: cmux's `--command`
 * (spec `flow-handoff-dispatch` §2.1 "No shell", §2.4).
 *
 * Every other command flow runs is an argv array. This is the single place a
 * value becomes shell text, so it is the single place to get right.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/launchers/shell-quote
 */

import { LaunchError } from './types.ts';

/**
 * Quote a value for a POSIX shell: wrap it in single quotes and write each
 * single quote inside it as `'\''`. Inside single quotes the shell expands
 * nothing, so `$`, backquotes, spaces and globs all arrive as written.
 *
 * A newline or NUL is refused: cmux turns a newline into Enter, and NUL cannot
 * appear in an argument at all.
 *
 * @param value - Any string.
 * @returns The quoted word, safe to paste into a shell line.
 * @throws {LaunchError} `bad-request` when the value holds a newline, carriage return or NUL.
 */
export function shellQuote(value: string): string {
  if (/[\n\r\0]/.test(value)) {
    throw new LaunchError(
      'bad-request',
      `A value flow would pass to a shell holds a line break or NUL: ${JSON.stringify(value)}.`
    );
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
