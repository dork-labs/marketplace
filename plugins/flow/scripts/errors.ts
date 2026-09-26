/**
 * The typed errors the `flow` CLI maps to exit codes (spec `flow-cli-core` §2).
 *
 * Every module the CLI calls throws one of these instead of printing and
 * exiting, so the one place that turns an error into an exit code is
 * `scripts/flow.ts`, and every module stays testable as a plain function.
 *
 * Dependency-free on purpose: the zero-dependency modules (config loading, the
 * work-state rule, the fleet contracts) import it, and they must run before
 * `npm install`.
 *
 * @module @dorkos/flow/errors
 */

/** The exit codes the `flow` CLI uses, one table for every verb. */
export const EXIT = {
  /** Success. */
  ok: 0,
  /** The verb's check found problems (`audit` violations, `status --strict` drift). */
  findings: 1,
  /** Usage error: unknown verb, bad flag, missing argument. */
  usage: 2,
  /** Config error: not configured, invalid config, `mcp` transport, no code adapter. */
  config: 3,
  /** Tracker error: unreachable, auth failure, a write not confirmed on read-back. */
  tracker: 4,
  /** Precondition failed: item not found, not claimable, claimed by someone else. */
  precondition: 5,
  /** Missing runtime dependency (`zod`). */
  dependency: 6,
  /** flow is paused and the verb was not run with `--manual`. */
  paused: 7,
  /** A bug in flow: an error no module expected. Kept apart from `findings` so a crash never reads as audit results. */
  internal: 70,
} as const;

/** One of the {@link EXIT} codes. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Base class: an error that knows which exit code it means. */
export class FlowError extends Error {
  /** The exit code the CLI returns for this error. */
  readonly exitCode: ExitCode;

  /**
   * Create a flow error.
   *
   * @param message - A plain sentence that names the fix where there is one.
   * @param exitCode - The {@link EXIT} code this error maps to.
   */
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** A bad verb, flag or argument (exit 2). */
export class UsageError extends FlowError {
  /** @param message - What was wrong with the invocation. */
  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

/** flow is not configured, its config is invalid, or it cannot reach a tracker as configured (exit 3). */
export class ConfigError extends FlowError {
  /** @param message - What is wrong and how to fix it. */
  constructor(message: string) {
    super(message, EXIT.config);
  }
}

/** The tracker could not be read or a write was not confirmed (exit 4). */
export class TrackerError extends FlowError {
  /** @param message - What failed. */
  constructor(message: string) {
    super(message, EXIT.tracker);
  }
}

/** The item or account is not in a state the verb can act on (exit 5). */
export class PreconditionError extends FlowError {
  /** @param message - Which precondition failed and what would satisfy it. */
  constructor(message: string) {
    super(message, EXIT.precondition);
  }
}

/** flow is paused and the verb was not run with `--manual` (exit 7). */
export class PausedError extends FlowError {
  /** @param message - Since when flow is paused and how to resume. */
  constructor(message: string) {
    super(message, EXIT.paused);
  }
}
