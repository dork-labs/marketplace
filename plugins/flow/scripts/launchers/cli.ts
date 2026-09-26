/**
 * The plain CLI launcher (spec `flow-handoff-dispatch` §2.3): each session is a
 * detached, headless runtime process writing JSON lines to a log under the
 * worktree. It runs all three runtimes (RUNTIMES.md R5).
 *
 * **claude-code**
 * - **probe:** `claude --version` exits 0.
 * - **start:** `claude -p "<pointer>" --output-format stream-json --verbose
 *   --session-id <id> --permission-mode <mode> [--model <m>]` in `cwd`, with the
 *   account's `CLAUDE_CONFIG_DIR` and no Claude credential variables. Confirmed
 *   when the log's `system`/`init` line reports `apiKeySource: "none"` and the
 *   transcript appears under the account's dir.
 * - **resume:** `--resume <id>` on the same account, cwd, mode and log.
 * - **state:** a live pid is `busy`; otherwise the log (then the transcript)
 *   decides between `limited` and `exited`.
 *
 * **codex** (codex-cli 0.145 flags, checked with `codex exec --help`)
 * - **probe:** `codex --version` exits 0.
 * - **start:** `codex exec --json -C <cwd> <mode flags> [-m <model>] "<pointer>"`
 *   in `cwd`, with `CODEX_HOME` set explicitly (the account's path, else the
 *   supervisor's `CODEX_HOME`, else `~/.codex`) and `OPENAI_API_KEY` and
 *   `CODEX_API_KEY` removed, so the home's own login bills. Codex mints the
 *   thread id: it is read from the log's `thread.started` event (`thread_id`),
 *   and replaces the request's id on the handle. Confirmed when a rollout for
 *   that id exists under `<CODEX_HOME>/sessions`; its `plan_type` is kept on the
 *   handle once a `rate_limits` reading reports it.
 * - **mode flags** (the mapping DorkOS's codex runtime uses; `codex exec` has no
 *   approval channel): `default` → `-s read-only -c approval_policy="never"`;
 *   `acceptEdits` → `-s workspace-write -c approval_policy="never"`, plus network
 *   access and the shared git dir as a writable root so a worker can commit and
 *   push from a linked worktree; `bypassPermissions` →
 *   `--dangerously-bypass-approvals-and-sandbox`.
 * - **resume:** `codex exec --json -C <cwd> <mode flags> [-m <model>] resume <id>
 *   "<pointer>"`: the shared flags go before `resume`, the order the Codex SDK
 *   itself uses (`codex exec resume --help` lists no `-C` or `-s` of its own).
 * - **state:** a live pid is `busy`; otherwise a `rate_limits` reading at its
 *   limit (log, then rollout) is `limited`, else `exited`.
 *
 * **opencode** (opencode 1.18 flags, checked with `opencode run --help`)
 * - **probe:** `opencode --version` exits 0.
 * - **start:** `opencode run --format json [-m <provider/model>] --title <title>
 *   [--auto] "<pointer>"` in `cwd`, with the supervisor's environment as is: an
 *   OpenCode account is the ambient provider credential. OpenCode mints the
 *   session id: it is the `sessionID` every JSON event carries. When the account
 *   names a provider, `opencode export <id>` must show a message whose
 *   `providerID` is that provider; the implicit default account needs only the id.
 * - **permission mode:** `opencode run` has no permission-mode flag. Without
 *   `--auto` it auto-rejects every permission ask (its own config's allow/deny
 *   rules still apply), so `default` and `acceptEdits` pass nothing, and
 *   `bypassPermissions` passes `--auto` (approve every ask not explicitly denied).
 * - **resume:** `opencode run --format json --session <id> [-m ...] [--auto]
 *   "<pointer>"`.
 * - **state:** a live pid is `busy`, else `exited`. No `limited`: the shape of an
 *   OpenCode rate-limit error in the JSON stream is not confirmed yet.
 *
 * **Every runtime**
 * - **send:** a live process gets the message queued in the worktree's inbox (a
 *   headless run reads no more input); an exited one is resumed.
 * - **stop:** SIGTERM the recorded pid, only after `ps` shows it still runs the
 *   runtime's binary.
 *
 * Every outside effect comes in through {@link CliLauncherDeps}, so the contract
 * suite runs it against fakes.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/launchers/cli
 */

import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { realProcessRunner, type ProcessRunner } from '../cli/context.ts';
import { parseJsonLines, streamLimit, transcriptLimit } from '../drain/stream-log.ts';
import { pidExists } from '../cli/host-io.ts';
import { codexLimit, findCodexRollout, readCodexRateLimits } from './codex-rollout.ts';
import {
  DEFAULT_START_TIMEOUT_MS,
  childEnv,
  pointerLine,
  sessionHome,
  stopRecordedPid,
  validateLaunchRequest,
  validateMessageFile,
} from './common.ts';
import { findTranscript, proveAccount } from './prove-account.ts';
import { requireSupported, supportFor } from './support.ts';
import {
  LaunchError,
  type LaunchPermissionMode,
  type LaunchRequest,
  type Launcher,
  type ProbeResult,
  type RuntimeName,
  type SendResult,
  type SessionHandle,
  type SessionState,
  type StopResult,
} from './types.ts';

/** The probe's reason when `claude --version` does not answer. */
export const CLI_UNAVAILABLE_REASON = 'the `claude` binary is not on PATH';

/**
 * The probe's reason when a runtime's binary does not answer `--version`.
 *
 * @param runtime - The runtime.
 * @returns A plain sentence naming the binary.
 */
export function cliUnavailableReason(runtime: RuntimeName): string {
  return runtime === 'claude-code'
    ? CLI_UNAVAILABLE_REASON
    : `the \`${runtime}\` binary is not on PATH`;
}

/** Options for one detached child. */
export interface DetachedSpawnOptions {
  /** The working folder. */
  cwd: string;
  /** The complete environment (nothing is inherited beyond it). */
  env: Record<string, string>;
  /** The file stdout is appended to. */
  stdoutFile: string;
  /** The file stderr is appended to. */
  stderrFile: string;
}

/** A detached child: its pid, and its exit code once it exits while this process lives. */
export interface DetachedChild {
  /** The child's pid. */
  pid: number;
  /** Resolves with the exit code (`null` when killed by a signal). */
  exit: Promise<number | null>;
}

/**
 * Start a detached child with no shell, stdout and stderr appended to files,
 * and not keep this process alive for it.
 */
export type DetachedSpawn = (
  cmd: string,
  args: readonly string[],
  opts: DetachedSpawnOptions
) => DetachedChild;

/** Everything the cli launcher touches outside its own memory. */
export interface CliLauncherDeps {
  /** Runs `<binary> --version`, `opencode export` and `ps` (no shell). */
  run: ProcessRunner;
  /** Starts the runtime child. */
  spawn: DetachedSpawn;
  /** Whether a pid exists. */
  isAlive: (pid: number) => boolean;
  /** Sends a signal to a pid. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** The supervisor's environment. */
  env: Readonly<Record<string, string | undefined>>;
  /** The OS home folder, for the ambient `~/.claude` and `~/.codex`. */
  osHome: string;
  /** The clock, in epoch milliseconds. */
  now: () => number;
  /** Waits. */
  sleep: (ms: number) => Promise<void>;
  /** How long `start` waits for confirmation. Default 90 s. */
  startTimeoutMs?: number;
  /** How often `start` looks. Default 500 ms. */
  pollMs?: number;
  /** The Claude Code executable. Default `claude` (found on PATH). */
  claudeBin?: string;
  /** The Codex executable. Default `codex` (found on PATH). */
  codexBin?: string;
  /** The OpenCode executable. Default `opencode` (found on PATH). */
  opencodeBin?: string;
}

/**
 * The real {@link DetachedSpawn}: `spawn(..., { detached: true, shell: false })`
 * with stdout and stderr opened for append, then `unref()`.
 *
 * @param cmd - The executable.
 * @param args - Its arguments.
 * @param opts - Folder, environment and output files.
 * @returns The pid and the exit promise.
 * @throws {Error} When the child cannot be started (for example, no such binary).
 */
export const realDetachedSpawn: DetachedSpawn = (cmd, args, opts) => {
  const out = openSync(opts.stdoutFile, 'a');
  const err = openSync(opts.stderrFile, 'a');
  try {
    const child = nodeSpawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      shell: false,
      stdio: ['ignore', out, err],
    });
    const exit = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`${cmd} could not be started.`);
    return { pid: child.pid, exit };
  } finally {
    closeSync(out);
    closeSync(err);
  }
};

/**
 * The real dependencies: `execFile`, a detached `spawn`, `process.kill`, the
 * process environment and clock.
 *
 * @returns Deps for {@link createCliLauncher}.
 */
export function realCliLauncherDeps(): CliLauncherDeps {
  return {
    run: realProcessRunner,
    spawn: realDetachedSpawn,
    isAlive: pidExists,
    kill: (pid, signal) => process.kill(pid, signal),
    env: process.env,
    osHome: os.homedir(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** The drain's per-worktree folders. */
function drainDir(cwd: string, ...parts: string[]): string {
  return path.join(cwd, '.dork', 'flow', 'drain', ...parts);
}

/** The file the runner's exit code lands in, beside the log. */
function exitFile(logFile: string): string {
  return logFile.replace(/\.jsonl$/, '') + '.exit.json';
}

/** The first line of the stderr log, for a start that failed. */
function stderrHead(logFile: string): string | null {
  try {
    const text = readFileSync(logFile.replace(/\.jsonl$/, '.err.log'), 'utf8').trim();
    return text === '' ? null : (text.split('\n')[0] ?? null);
  } catch {
    return null;
  }
}

/** A log's complete lines (a line still being written is left for the next read). */
function logLines(logFile: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  return parseJsonLines(text.slice(0, text.lastIndexOf('\n') + 1));
}

/** The first `system`/`init` message in a Claude Code log, if it has one yet. */
function firstInit(logFile: string): Record<string, unknown> | null {
  return (
    logLines(logFile).find((line) => line.type === 'system' && line.subtype === 'init') ?? null
  );
}

/** A session id a runtime minted, when it is safe to use as a file name. */
function safeId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

/** The thread id of the first `thread.started` event in a `codex exec --json` log. */
function codexThreadId(logFile: string): string | null {
  const started = logLines(logFile).find((line) => line.type === 'thread.started');
  return started === undefined ? null : safeId(started.thread_id);
}

/** The session id the first event of an `opencode run --format json` log carries. */
function opencodeSessionId(logFile: string): string | null {
  for (const line of logLines(logFile)) {
    const id = safeId(line.sessionID);
    if (id !== null) return id;
  }
  return null;
}

/**
 * The providers an `opencode export <id>` document shows the session's messages
 * using: an assistant message's `providerID`, or a user message's
 * `model.providerID`.
 */
function exportedProviders(stdout: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  const messages =
    typeof doc === 'object' &&
    doc !== null &&
    Array.isArray((doc as { messages?: unknown }).messages)
      ? (doc as { messages: unknown[] }).messages
      : [];
  const out: string[] = [];
  for (const message of messages) {
    const info = (message as { info?: Record<string, unknown> } | null)?.info;
    if (typeof info !== 'object' || info === null) continue;
    if (typeof info.providerID === 'string') out.push(info.providerID);
    const model = info.model as { providerID?: unknown } | undefined;
    if (typeof model?.providerID === 'string') out.push(model.providerID);
  }
  return out;
}

/** The common tail of every `claude -p` argv. */
function streamArgs(mode: string, model: string | undefined): string[] {
  const args = ['--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
  if (model !== undefined) args.push('--model', model);
  return args;
}

/**
 * The `codex exec` sandbox/approval flags for a permission mode (see the module
 * doc). Under `acceptEdits` a drain worker must commit and push, so the
 * workspace-write sandbox also gets network access and the repository's shared
 * git directory as a writable root: in a linked worktree, `git commit` writes
 * objects and refs there, outside the worktree Codex would otherwise confine it to.
 *
 * @param mode - The requested permission mode.
 * @param gitCommonDir - The absolute shared git directory of the worktree, when known.
 */
export function codexModeArgs(mode: LaunchPermissionMode, gitCommonDir?: string | null): string[] {
  if (mode === 'bypassPermissions') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (mode === 'default') return ['-s', 'read-only', '-c', 'approval_policy="never"'];
  return [
    '-s',
    'workspace-write',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_workspace_write.network_access=true',
    ...(gitCommonDir
      ? ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(gitCommonDir)}]`]
      : []),
  ];
}

/**
 * The shared git directory of the checkout at `cwd`, read from disk with no
 * subprocess: a `.git` directory is itself the common dir; a linked worktree's
 * `.git` file points at `<common>/worktrees/<name>`, whose `commondir` names it.
 *
 * @param cwd - The worktree root.
 * @returns The absolute common git directory, or null when it cannot be read.
 */
export function gitCommonDirOf(cwd: string): string | null {
  try {
    const dotGit = path.join(cwd, '.git');
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!pointer) return null;
    const gitDir = path.resolve(cwd, pointer[1].trim());
    const common = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return path.resolve(gitDir, common);
  } catch {
    return null;
  }
}

/** The `codex exec` flags shared by a start and a resume (they precede `resume`). */
function codexArgs(cwd: string, mode: LaunchPermissionMode, model: string | undefined): string[] {
  return [
    'exec',
    '--json',
    '-C',
    cwd,
    ...codexModeArgs(mode, gitCommonDirOf(cwd)),
    ...(model === undefined ? [] : ['-m', model]),
  ];
}

/** The `opencode run` flags shared by a start and a resume. */
function opencodeArgs(mode: LaunchPermissionMode, model: string | undefined): string[] {
  return [
    'run',
    '--format',
    'json',
    ...(model === undefined ? [] : ['-m', model]),
    ...(mode === 'bypassPermissions' ? ['--auto'] : []),
  ];
}

/** What a start's confirmation poll found. */
type Confirmation =
  | { kind: 'waiting'; seen: boolean }
  | { kind: 'confirmed'; sessionId: string; plan?: string }
  | { kind: 'refused'; message: string };

/**
 * Create the plain CLI launcher.
 *
 * @param deps - Process, clock and environment access (see {@link realCliLauncherDeps}).
 * @returns The launcher.
 */
export function createCliLauncher(deps: CliLauncherDeps): Launcher {
  const bins: Record<RuntimeName, string> = {
    'claude-code': deps.claudeBin ?? 'claude',
    codex: deps.codexBin ?? 'codex',
    opencode: deps.opencodeBin ?? 'opencode',
  };
  const timeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 500;

  /** Record the exit code beside the log when the child exits while we live. */
  function watchExit(child: DetachedChild, logFile: string): void {
    void child.exit.then(
      (code) => {
        try {
          writeFileSync(exitFile(logFile), `${JSON.stringify({ pid: child.pid, code })}\n`);
        } catch {
          // The worktree went away; state() then reports code null.
        }
      },
      () => undefined
    );
  }

  /** Spawn one runtime child, translating a spawn failure into `unavailable`. */
  function spawnRuntime(
    runtime: RuntimeName,
    args: string[],
    cwd: string,
    home: string | null,
    logFile: string
  ): DetachedChild {
    mkdirSync(path.dirname(logFile), { recursive: true });
    rmSync(exitFile(logFile), { force: true });
    let child: DetachedChild;
    try {
      child = deps.spawn(bins[runtime], args, {
        cwd,
        env: childEnv(deps.env, runtime, home),
        stdoutFile: logFile,
        stderrFile: logFile.replace(/\.jsonl$/, '.err.log'),
      });
    } catch (error) {
      throw new LaunchError(
        'unavailable',
        `${bins[runtime]} could not be started: ${(error as Error).message}`
      );
    }
    watchExit(child, logFile);
    return child;
  }

  async function probe(runtime: RuntimeName = 'claude-code'): Promise<ProbeResult> {
    const reason = cliUnavailableReason(runtime);
    try {
      const result = await deps.run(bins[runtime], ['--version'], { timeoutMs: 15_000 });
      return result.code === 0 ? { ok: true } : { ok: false, reason };
    } catch {
      return { ok: false, reason };
    }
  }

  const stopDeps = { run: deps.run, isAlive: deps.isAlive, kill: deps.kill };

  /** The first start's argv for a runtime. */
  function startArgs(req: LaunchRequest): string[] {
    const pointer = pointerLine(req.promptFile);
    if (req.runtime === 'codex')
      return [...codexArgs(req.cwd, req.permissionMode, req.model), pointer];
    if (req.runtime === 'opencode') {
      return [...opencodeArgs(req.permissionMode, req.model), '--title', req.title, pointer];
    }
    return [
      '-p',
      pointer,
      '--session-id',
      req.sessionId,
      ...streamArgs(req.permissionMode, req.model),
    ];
  }

  /** A resume's argv for a runtime. */
  function resumeArgs(h: SessionHandle, mode: LaunchPermissionMode, messageFile: string): string[] {
    const pointer = pointerLine(messageFile);
    if (h.runtime === 'codex')
      return [...codexArgs(h.cwd, mode, h.model), 'resume', h.sessionId, pointer];
    if (h.runtime === 'opencode') {
      return [...opencodeArgs(mode, h.model), '--session', h.sessionId, pointer];
    }
    return ['-p', pointer, '--resume', h.sessionId, ...streamArgs(mode, h.model)];
  }

  /** claude-code: init reports no API key, and the transcript is under the config dir. */
  function confirmClaude(req: LaunchRequest, home: string, logFile: string): Confirmation {
    const init = firstInit(logFile);
    if (init === null) return { kind: 'waiting', seen: false };
    if (init.apiKeySource !== 'none') {
      return {
        kind: 'refused',
        message: `The session signed in with ${String(init.apiKeySource ?? 'an unreported credential')} instead of the account's own login (apiKeySource must be "none"); flow stopped it.`,
      };
    }
    return proveAccount(home, req.sessionId)
      ? { kind: 'confirmed', sessionId: req.sessionId }
      : { kind: 'waiting', seen: true };
  }

  /** codex: the thread started, and its rollout is under the account's `CODEX_HOME`. */
  function confirmCodex(home: string, logFile: string): Confirmation {
    const threadId = codexThreadId(logFile);
    if (threadId === null) return { kind: 'waiting', seen: false };
    const rollout = findCodexRollout(home, threadId);
    if (rollout === null) return { kind: 'waiting', seen: true };
    const plan = readCodexRateLimits(rollout)?.planType ?? readCodexRateLimits(logFile)?.planType;
    return { kind: 'confirmed', sessionId: threadId, ...(plan ? { plan } : {}) };
  }

  /** opencode: the session exists, and (for a provider account) bills that provider. */
  async function confirmOpencode(req: LaunchRequest, logFile: string): Promise<Confirmation> {
    const sessionId = opencodeSessionId(logFile);
    if (sessionId === null) return { kind: 'waiting', seen: false };
    const provider = req.account?.provider;
    if (provider === undefined) return { kind: 'confirmed', sessionId };
    let providers: string[] = [];
    try {
      const result = await deps.run(bins.opencode, ['export', sessionId], { timeoutMs: 30_000 });
      if (result.code === 0) providers = exportedProviders(result.stdout);
    } catch {
      // Not readable yet; look again next poll.
    }
    const other = providers.find((p) => p !== provider);
    if (other !== undefined) {
      return {
        kind: 'refused',
        message: `The session runs on the ${other} provider instead of the account's ${provider}; flow stopped it.`,
      };
    }
    return providers.length > 0
      ? { kind: 'confirmed', sessionId }
      : { kind: 'waiting', seen: true };
  }

  async function start(req: LaunchRequest): Promise<SessionHandle> {
    requireSupported('cli', req.runtime);
    validateLaunchRequest(req);
    const probed = await probe(req.runtime);
    if (!probed.ok) throw new LaunchError('unavailable', probed.reason);

    const home = sessionHome(req.runtime, req.account, deps.env, deps.osHome);
    const logFile = drainDir(req.cwd, 'logs', `${req.sessionId}.jsonl`);
    const child = spawnRuntime(req.runtime, startArgs(req), req.cwd, home, logFile);
    const binary = bins[req.runtime];

    const deadline = deps.now() + timeoutMs;
    let seen = false;
    for (;;) {
      const found: Confirmation =
        req.runtime === 'claude-code'
          ? confirmClaude(req, home as string, logFile)
          : req.runtime === 'codex'
            ? confirmCodex(home as string, logFile)
            : await confirmOpencode(req, logFile);
      if (found.kind === 'refused') {
        await stopRecordedPid(child.pid, req.runtime, stopDeps);
        throw new LaunchError('wrong-account', found.message);
      }
      if (found.kind === 'confirmed') {
        return {
          host: 'cli',
          runtime: req.runtime,
          sessionId: found.sessionId,
          account: req.account?.id ?? null,
          cwd: req.cwd,
          pid: child.pid,
          logFile,
          logOffset: 0,
          ...(home === null ? {} : { configDir: home }),
          permissionMode: req.permissionMode,
          ...(req.model === undefined ? {} : { model: req.model }),
          ...(found.plan === undefined ? {} : { plan: found.plan }),
        };
      }
      seen ||= found.seen;
      if (!deps.isAlive(child.pid)) {
        const why = stderrHead(logFile);
        throw new LaunchError(
          'not-started',
          `${binary} exited before the session was confirmed${why === null ? '' : `: ${why}`}.`
        );
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(pollMs);
    }

    await stopRecordedPid(child.pid, req.runtime, stopDeps);
    if (seen) {
      const where =
        req.runtime === 'opencode'
          ? `OpenCode never showed which provider it bills, so flow cannot confirm it runs on ${req.account?.provider}`
          : req.runtime === 'codex'
            ? `its rollout never appeared under ${home}, so it is not running on that account`
            : `its transcript never appeared under ${home}, so it is not running on that account`;
      throw new LaunchError('wrong-account', `The session started, but ${where}; flow stopped it.`);
    }
    throw new LaunchError(
      'not-started',
      `The session did not confirm within ${Math.round(timeoutMs / 1000)} s; flow stopped it.`
    );
  }

  async function send(h: SessionHandle, messageFile: string): Promise<SendResult> {
    validateMessageFile(messageFile);
    const needsHome = h.runtime !== 'opencode';
    if (
      h.logFile === undefined ||
      (needsHome && h.configDir === undefined) ||
      h.permissionMode === undefined
    ) {
      throw new LaunchError(
        'bad-request',
        'This handle has no log file, runtime home or permission mode, so it is not a cli session flow started.'
      );
    }
    if (h.pid !== undefined && deps.isAlive(h.pid)) {
      const inbox = drainDir(h.cwd, 'inbox', h.sessionId);
      mkdirSync(inbox, { recursive: true });
      const seq = readdirSync(inbox).filter((name) => /^\d+\.md$/.test(name)).length + 1;
      writeFileSync(
        path.join(inbox, `${String(seq).padStart(4, '0')}.md`),
        `${pointerLine(messageFile)}\n`
      );
      return { result: 'queued', handle: h };
    }
    const args = resumeArgs(h, h.permissionMode, messageFile);
    const child = spawnRuntime(h.runtime, args, h.cwd, h.configDir ?? null, h.logFile);
    return { result: 'delivered', handle: { ...h, pid: child.pid } };
  }

  /** claude-code: the stream first; the transcript when the stream names no window. */
  function claudeLimit(h: SessionHandle, logFile: string): SessionState | null {
    // A Claude Code version whose stream carries no rate_limit_event still
    // leaves a structured rate_limit entry in the transcript.
    let limit = streamLimit(logFile);
    if ((limit === null || limit.window === null) && h.configDir !== undefined) {
      const transcript = findTranscript(h.configDir, h.sessionId);
      const fromTranscript = transcript === null ? null : transcriptLimit(transcript);
      if (fromTranscript !== null) limit = fromTranscript;
    }
    return limit === null
      ? null
      : { kind: 'limited', window: limit.window, resetsAt: limit.resetsAt };
  }

  /** codex: a `rate_limits` reading at its limit, the log's first, else the rollout's. */
  function codexState(h: SessionHandle, logFile: string): SessionState | null {
    let limit = codexLimit(readCodexRateLimits(logFile));
    if ((limit === null || limit.window === null) && h.configDir !== undefined) {
      const rollout = findCodexRollout(h.configDir, h.sessionId);
      const fromRollout = rollout === null ? null : codexLimit(readCodexRateLimits(rollout));
      if (fromRollout !== null) limit = fromRollout;
    }
    return limit === null
      ? null
      : { kind: 'limited', window: limit.window, resetsAt: limit.resetsAt };
  }

  async function state(h: SessionHandle): Promise<SessionState> {
    if (h.pid !== undefined && deps.isAlive(h.pid)) return { kind: 'busy' };
    if (h.logFile === undefined) {
      return { kind: 'unknown', reason: 'this handle has no stream log to read' };
    }
    const limited =
      h.runtime === 'codex'
        ? codexState(h, h.logFile)
        : h.runtime === 'opencode'
          ? null
          : claudeLimit(h, h.logFile);
    if (limited !== null) return limited;
    let code: number | null = null;
    try {
      const recorded: unknown = JSON.parse(readFileSync(exitFile(h.logFile), 'utf8'));
      if (
        typeof recorded === 'object' &&
        recorded !== null &&
        (recorded as { pid?: unknown }).pid === h.pid &&
        typeof (recorded as { code?: unknown }).code === 'number'
      ) {
        code = (recorded as { code: number }).code;
      }
    } catch {
      // The supervisor was not running when the child exited.
    }
    return { kind: 'exited', code };
  }

  async function stop(h: SessionHandle): Promise<StopResult> {
    if (h.pid === undefined) return 'not-running';
    return stopRecordedPid(h.pid, h.runtime, stopDeps);
  }

  return {
    host: 'cli',
    supports: (runtime) => supportFor('cli', runtime),
    probe,
    start,
    send,
    state,
    stop,
  };
}
