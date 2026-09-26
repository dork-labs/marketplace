/**
 * The `cli` tracker transport (spec `flow-cli-core` §4): runs the external
 * command an adapter names, with no shell.
 *
 * It names no tracker and no command; the adapter supplies both. It runs on the
 * CLI's one process runner (`execFile`, no shell, 60 s default timeout, 64 MB
 * output cap), and turns a command that cannot start or does not finish into a
 * `TrackerError` (exit 4). A non-zero exit is not an error here: it resolves,
 * and the adapter decides what the exit means.
 *
 * Error messages name the command, never its arguments: an adapter passes its
 * account handle as an argument, and secrets never reach stderr.
 *
 * Dependency-free: node builtins and zero-dependency local modules only.
 *
 * @module @dorkos/flow/tracker/external-cli
 */

import { realProcessRunner, type ProcessRunner } from '../cli/context.ts';
import { TrackerError } from '../errors.ts';
import type { TrackerTransport } from './types.ts';

/** The timeout a command gets when the adapter does not pass one. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Describe why a command failed to run, without its arguments.
 *
 * @param cmd - The executable.
 * @param error - What the runner rejected with.
 * @param timeoutMs - The timeout the command had.
 * @returns A plain sentence naming the command and the cause.
 */
function describeFailure(cmd: string, error: unknown, timeoutMs: number): string {
  const e = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  if (e?.code === 'ENOENT') {
    return `could not run "${cmd}": it is not installed or not on PATH`;
  }
  if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `"${cmd}" wrote more output than flow reads (64 MB) and was stopped`;
  }
  if (e?.killed === true || typeof e?.signal === 'string') {
    return `"${cmd}" did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`;
  }
  const detail = typeof e?.code === 'string' ? e.code : 'unknown cause';
  return `could not run "${cmd}" (${detail})`;
}

/**
 * Build the `cli` transport.
 *
 * @param runner - The process runner. Default: the CLI's real one; tests pass a fake.
 * @returns A {@link TrackerTransport} of kind `cli`.
 */
export function createExternalCliTransport(
  runner: ProcessRunner = realProcessRunner
): TrackerTransport {
  return {
    kind: 'cli',
    async run(cmd, args, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        return await runner(cmd, args, { timeoutMs });
      } catch (error) {
        throw new TrackerError(describeFailure(cmd, error, timeoutMs));
      }
    },
  };
}
