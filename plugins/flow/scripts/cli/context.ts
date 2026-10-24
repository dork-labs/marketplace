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

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

import { createGithubForge } from '../forge/github.ts';
import type { Forge, ForgeFactory, ForgeTarget } from '../forge/types.ts';
import type { GuardResult } from '../land/arm-guard.ts';
import { resolveMainCheckout } from '../main-checkout.ts';
import type { HostName, Launcher } from '../launchers/types.ts';
import type { CodeAdapter } from '../tracker/types.ts';
import type { ParsedArgs, VerbSpec } from './args.ts';
import { realHostIo, type HostIo } from './host-io.ts';
import type { Runtime } from '../runtime-detect.ts';
import { RUNTIMES } from '../runtime-detect.ts';
import { runtimeSession } from './session-id.ts';

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
  /** The command's whole environment. Default: this process's. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Run it in a process group of its own, and on a timeout kill the whole
   * group, so nothing the command started outlives it.
   */
  processGroup?: boolean;
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

/** What a verb asks the arm guard about (DOR-3262). */
export interface ArmGuardRequest {
  /** The forge the PR lives on. */
  forge: Forge;
  /** The PR. */
  pr: number;
  /** The commit the review covered: what the verb means to arm. */
  reviewedSha: string | null;
  /** The PR's worktree. */
  worktree: string;
  /** Run the `land.preArm` checks (`run`, default) or leave them to the drain (`defer`). */
  preArm?: 'run' | 'defer';
}

/**
 * The arm guard every arm path calls just before `Forge.arm`. The real one
 * (`land/arm-guard.ts`) is the default; a test of a verb's own logic passes
 * a recording one.
 */
export type ArmGuard = (request: ArmGuardRequest) => Promise<GuardResult>;

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
  /** Builds the forge for a repository. Default: the GitHub forge over {@link runProcess}. */
  createForge?: ForgeFactory;
  /** The arm guard. Default: the real one over {@link runProcess}, the clock and `io.sleep`. */
  armGuard?: ArmGuard;
  /**
   * Builds the launcher for a host (`flow drain`, `flow status`). Default: the
   * real launcher (`scripts/launchers/real.ts`), which the verbs load themselves
   * so no other verb pays for it.
   */
  createLauncher?: (host: HostName) => Launcher;
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
  /**
   * The runtime the verb resolved for itself, when that can differ from the
   * environment's (`flow claim --runtime`). The run's `verb` journal line uses
   * it, so it agrees with the verb's own lines. Never printed.
   */
  runtime?: Runtime;
  /**
   * The item the run acted on, when the verb learns it only while running
   * (`flow create`'s new identifier). The `verb` journal line records it; a
   * verb whose first positional is the identifier needs not set it. Never printed.
   */
  item?: string;
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
  /** The working directory; resolve a verb's own path flags against it. */
  cwd: string;
  /** `--project` resolved against cwd, else cwd. */
  projectDir: string;
  /** `--snapshot` resolved against cwd, when given. */
  snapshotPath?: string;
  /**
   * `--session`, else a non-empty `FLOW_SESSION_ID`, else the runtime's own id
   * (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`; see `./session-id.ts`); never invented.
   */
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
  /** stdin, the OS home, loopback fetch, streaming children, pid checks, the watchdog, sleep. */
  io: HostIo;
  /** The forge for one repository (GitHub unless a test injects another). */
  forge(target: ForgeTarget): Forge;
  /** The arm guard: called before every arm (DOR-3262). */
  armGuard: ArmGuard;
  /**
   * Standard output, for a verb that prints as it goes (`flow watch --follow`).
   * Every other verb returns its result instead.
   */
  stdout: TextSink;
  /** Standard error, for a verb's own progress lines (`flow drain`'s host choice). */
  stderr: TextSink;
  /** The injected launcher factory, when a test gives one; else the verb builds real launchers. */
  createLauncher?: (host: HostName) => Launcher;
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
  // FLOW_SESSION_ID wins; then the runtime's own id, which Claude Code
  // (CLAUDE_CODE_SESSION_ID) and Codex (CODEX_THREAD_ID) set for every shell
  // command they run, so an agent there needs no flag. Empty means unset.
  // A verb that takes --runtime (claim) names the runtime, and so the variable.
  const runtimeFlag = args.flags.runtime;
  const named =
    typeof runtimeFlag === 'string' && (RUNTIMES as readonly string[]).includes(runtimeFlag)
      ? (runtimeFlag as (typeof RUNTIMES)[number])
      : undefined;
  const envSession = deps.env.FLOW_SESSION_ID || runtimeSession(deps.env, named).sessionId;
  const projectDir = pathFlag('project') ?? deps.cwd;

  let adapter: Promise<CodeAdapter> | undefined;
  const io = { ...realHostIo(), ...deps.io };
  // Loaded only when a verb arms: it pulls in zod, which most verbs never need.
  const realArmGuard: ArmGuard = async (request) => {
    const { guardArm } = await import('../land/arm-guard.ts');
    return guardArm(
      { ...request, mainCheckout: resolveMainCheckout(request.worktree) },
      { runProcess: deps.runProcess, now: () => deps.now(), sleep: (ms) => io.sleep(ms) }
    );
  };
  return {
    args,
    json: args.json,
    cwd: deps.cwd,
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
    io,
    forge: (target) =>
      deps.createForge?.(target) ??
      createGithubForge({ target, runProcess: deps.runProcess, now: () => deps.now() }),
    armGuard: deps.armGuard ?? realArmGuard,
    stdout: deps.stdout,
    stderr: deps.stderr,
    createLauncher: deps.createLauncher,
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
  opts.processGroup ? runInGroup(cmd, args, opts) : runPlain(cmd, args, opts);

/** {@link realProcessRunner} for a command in its own process group. */
function runInGroup(
  cmd: string,
  args: readonly string[],
  opts: ProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        ...(opts.env === undefined ? {} : { env: { ...opts.env } }),
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error as Error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    // Once the command has exited and its group was stopped, its pid may be
    // reused: nothing signals the group after that.
    let exited = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const killGroup = () => {
      if (exited) return;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      settle();
    };
    const timer = setTimeout(() => {
      killGroup();
      finish(() =>
        reject(
          new Error(
            `${cmd} timed out after ${opts.timeoutMs ?? 60_000} ms; its process group was stopped`
          )
        )
      );
    }, opts.timeoutMs ?? 60_000);
    const add = (which: 'out' | 'err') => (chunk: string) => {
      if (which === 'out') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
        killGroup();
        finish(() => reject(new Error(`${cmd} printed more than ${MAX_OUTPUT_BYTES} bytes`)));
      }
    };
    child.stdout?.setEncoding('utf8').on('data', add('out'));
    child.stderr?.setEncoding('utf8').on('data', add('err'));
    child.on('error', (error) => finish(() => reject(error)));
    // When the command itself ends, whatever it left running in its group goes
    // with it. Its result is its exit code: a descendant that left the group
    // and still holds the output pipes cannot turn a finished command into a
    // timeout, because the pipes are let go after a short grace period.
    child.on('exit', (code) => {
      killGroup();
      exited = true;
      clearTimeout(timer);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(() => resolve({ code: code ?? -1, stdout, stderr }));
      }, 2_000);
    });
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
  });
}

/** {@link realProcessRunner} for a plain command. */
function runPlain(
  cmd: string,
  args: readonly string[],
  opts: ProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        ...(opts.env === undefined ? {} : { env: { ...opts.env } }),
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
}
