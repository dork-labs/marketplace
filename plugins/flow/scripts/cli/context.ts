/**
 * What a `flow` verb is and what it is handed (spec `flow-cli-core` §2).
 *
 * A verb is a {@link VerbDefinition}: a declaration the parser and `--help` read
 * without loading anything, plus a `load()` that dynamically imports the verb's
 * own module. Adding a verb is one module under `scripts/cli/` and one entry in
 * the `VERBS` table in `scripts/flow.ts`.
 *
 * A verb reaches the outside world only through its {@link VerbContext}: env,
 * clock, the process runner and the tracker adapter all come from
 * {@link CliDeps}, so every verb is unit-testable with fakes and no network.
 *
 * Dependency-free: node builtins and other zero-dependency local modules only.
 *
 * @module @dorkos/flow/cli/context
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

import type { CodeAdapter } from '../tracker/types.ts';
import type { ParsedArgs, VerbSpec } from './args.ts';
import { realHostIo, type HostIo } from './host-io.ts';

/** Anything text can be written to: `process.stdout`, or a test buffer. */
export interface TextSink {
  /** Write one chunk of text. */
  write(chunk: string): unknown;
}

/** The outcome of one external command. */
export interface ProcessResult {
  /** The exit code (non-zero exit does not reject). */
  code: number;
  /** Everything the command wrote to stdout. */
  stdout: string;
  /** Everything the command wrote to stderr. */
  stderr: string;
}

/** Options for one external command. */
export interface ProcessOptions {
  /** Kill the command after this many milliseconds. Default 60 000. */
  timeoutMs?: number;
  /** Working directory for the command. Default: the process's own. */
  cwd?: string;
}

/**
 * Run an external command with no shell, so arguments can never inject
 * commands. Resolves with the exit code on a non-zero exit; rejects when the
 * command cannot be started or times out.
 */
export type ProcessRunner = (
  cmd: string,
  args: readonly string[],
  opts?: ProcessOptions
) => Promise<ProcessResult>;

/** What the adapter factory is told about the run that needs a tracker. */
export interface AdapterRequest {
  /** The checkout whose config names the tracker (the resolved `--project`). */
  projectDir: string;
  /** The plugin folder (`<flow-root>`), where a shipped adapter lives. */
  flowRoot: string;
  /** Environment variables (`FLOW_TRACKER_*` fill the secrets). */
  env: Readonly<Record<string, string | undefined>>;
  /** Runs the transport's external commands with no shell. */
  runProcess: ProcessRunner;
  /** Print a warning to stderr. */
  warn(message: string): void;
}

/**
 * Build the tracker adapter for a project (spec §4). The CLI calls it at most
 * once per run and only when a verb asks, so verbs that need no tracker never
 * load config or an adapter. The script wires `createCodeAdapter` from
 * `scripts/tracker/load.ts`; tests pass a fake.
 */
export type AdapterFactory = (request: AdapterRequest) => Promise<CodeAdapter>;

/** Everything `main` needs from the world; the script entry wires the real ones. */
export interface CliDeps {
  /** Environment variables (`process.env`). */
  env: Readonly<Record<string, string | undefined>>;
  /** The working directory `--project` and `--snapshot` resolve against. */
  cwd: string;
  /** The clock. */
  now(): Date;
  /** Where results go. */
  stdout: TextSink;
  /** Where diagnostics, warnings and human-mode errors go. */
  stderr: TextSink;
  /** Builds the tracker adapter on demand. */
  createAdapter: AdapterFactory;
  /** Runs external commands (git, ps) with no shell. */
  runProcess: ProcessRunner;
  /** Replaces parts of the machine the usage and fleet verbs touch; the rest are real. */
  io?: Partial<HostIo>;
}

/** What a verb returns on success, or when its check found problems. */
export interface VerbResult {
  /**
   * `0` (default) on success, `1` when the verb's check found problems, `5` when
   * it finished and reported everything but a precondition failed for some of
   * its targets (for example an account whose status line must be edited by hand).
   */
  exitCode?: 0 | 1 | 5;
  /** The `--json` payload. `v: 1` is added by the CLI and cannot be overridden. */
  json: Record<string, unknown>;
  /** The human-mode output: plain, aligned, uncolored. Empty prints nothing. */
  text: string;
}

/** A verb's own module, loaded lazily with `import()`. */
export interface VerbModule {
  /**
   * Run the verb. Throw a typed error from `scripts/errors.ts` to fail with its
   * exit code; never print or exit directly.
   */
  run(ctx: VerbContext): Promise<VerbResult>;
}

/** One entry in the verb table: the declaration plus how to load the module. */
export interface VerbDefinition extends VerbSpec {
  /** Import the verb's module. Only called for the verb being run, and never for `--help`. */
  load(): Promise<VerbModule>;
}

/** Everything a verb sees about its invocation and the world. */
export interface VerbContext {
  /** The parsed invocation. */
  args: ParsedArgs;
  /** Whether `--json` was given. */
  json: boolean;
  /** `--project` resolved against cwd, else cwd. */
  projectDir: string;
  /** `--snapshot` resolved against cwd, when given. */
  snapshotPath?: string;
  /** `--session`, else a non-empty `FLOW_SESSION_ID`; never invented. */
  sessionId?: string;
  /** Whether `--dry-run` was given. */
  dryRun: boolean;
  /** Whether `--manual` was given. */
  manual: boolean;
  /** The plugin folder (`<flow-root>`). */
  flowRoot: string;
  /** Environment variables. */
  env: Readonly<Record<string, string | undefined>>;
  /** The clock. */
  now(): Date;
  /** Runs external commands with no shell. */
  runProcess: ProcessRunner;
  /** The tracker adapter, built on first call and reused after. */
  adapter(): Promise<CodeAdapter>;
  /** Print a warning to stderr (both output modes). */
  warn(message: string): void;
  /** stdin, the OS home, loopback fetch, streaming children, pid checks, the watchdog. */
  io: HostIo;
}

/**
 * Build a verb's context from its parsed invocation and the injected deps.
 *
 * @param args - The parsed invocation.
 * @param deps - The injected world.
 * @param flowRoot - The plugin folder.
 * @param warn - Prints a warning to stderr.
 * @returns The context the verb's `run` receives.
 */
export function createVerbContext(
  args: ParsedArgs,
  deps: CliDeps,
  flowRoot: string,
  warn: (message: string) => void
): VerbContext {
  const pathFlag = (name: string): string | undefined => {
    const value = args.flags[name];
    return typeof value === 'string' ? path.resolve(deps.cwd, value) : undefined;
  };
  const sessionFlag = args.flags.session;
  const envSession = deps.env.FLOW_SESSION_ID;
  const projectDir = pathFlag('project') ?? deps.cwd;

  let adapter: Promise<CodeAdapter> | undefined;
  return {
    args,
    json: args.json,
    projectDir,
    snapshotPath: pathFlag('snapshot'),
    sessionId: typeof sessionFlag === 'string' ? sessionFlag : envSession ? envSession : undefined,
    dryRun: args.flags['dry-run'] === true,
    manual: args.flags.manual === true,
    flowRoot,
    env: deps.env,
    now: () => deps.now(),
    runProcess: deps.runProcess,
    adapter: () =>
      (adapter ??= deps.createAdapter({
        projectDir,
        flowRoot,
        env: deps.env,
        runProcess: deps.runProcess,
        warn,
      })),
    warn,
    io: { ...realHostIo(), ...deps.io },
  };
}

/** Largest output one external command may produce before it is cut off. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The real {@link ProcessRunner}: `execFile` with no shell, a 60 s default
 * timeout and a 64 MB output cap.
 *
 * @param cmd - The executable.
 * @param args - Its arguments, passed as an array.
 * @param opts - Timeout and working directory.
 * @returns The exit code and captured output.
 */
export const realProcessRunner: ProcessRunner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      }
    );
  });
