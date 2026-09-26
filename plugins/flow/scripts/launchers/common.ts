/**
 * The rules every launcher keeps (spec `flow-handoff-dispatch` §2.1): validate
 * the request before anything starts, build the child's environment (the
 * account's runtime home set, every other credential of that runtime removed),
 * phrase every message as a one-line pointer, and stop only a pid flow recorded
 * that still runs the runtime flow started.
 *
 * Shared by the cli and cmux launchers; DorkOS uses {@link validateLaunchRequest}
 * and {@link pointerLine} too.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/launchers/common
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ProcessRunner } from '../cli/context.ts';
import { ambientAccountPath, type RuntimeAccount } from '../fleet/accounts.ts';
import {
  DEFAULT_ACCOUNT_ID,
  LaunchError,
  type LaunchAccount,
  type LaunchPermissionMode,
  type LaunchRequest,
  type RuntimeName,
  type StopResult,
} from './types.ts';

/**
 * Environment variables that make a Claude Code child bill something other
 * than the named account's login: a credential of their own (the first three),
 * or a route to another biller (Bedrock, Vertex, or a proxy base URL). Every
 * Claude Code child environment is built without them.
 */
export const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_BASE_URL',
] as const;

/**
 * Per runtime, the variables that would bill a credential other than the
 * account's own login, so the child is built without them.
 *
 * - `claude-code`: {@link CREDENTIAL_ENV_VARS}; the `CLAUDE_CONFIG_DIR` login bills.
 * - `codex`: `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` (a route to
 *   another endpoint); the `CODEX_HOME` login bills.
 * - `opencode`: none. An OpenCode account IS the ambient provider credential
 *   (often an API key in the environment, the intended path per RUNTIMES.md R3),
 *   so stripping it would leave the session nothing to bill.
 */
export const RUNTIME_CREDENTIAL_ENV_VARS: Readonly<Record<RuntimeName, readonly string[]>> = {
  'claude-code': CREDENTIAL_ENV_VARS,
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  opencode: [],
};

/** Per runtime, the variable naming the account's home; opencode has none. */
export const RUNTIME_HOME_ENV_VAR: Readonly<Record<RuntimeName, string | null>> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  opencode: null,
};

/** How long `start` waits for a session to confirm, unless a launcher is told otherwise. */
export const DEFAULT_START_TIMEOUT_MS = 90_000;

const PERMISSION_MODES: readonly LaunchPermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
];

/** A session id becomes a file name, so it may hold only these characters. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The one line every message is: a pointer at the file that holds it.
 *
 * @param file - The absolute message file.
 * @returns `Read <file> and do exactly what it says.`
 */
export function pointerLine(file: string): string {
  return `Read ${file} and do exactly what it says.`;
}

/** Throw `bad-request` with `message`. */
function badRequest(message: string): never {
  throw new LaunchError('bad-request', message);
}

/** Refuse a value holding a line break or NUL. */
function refuseBreaks(name: string, value: string): void {
  if (/[\n\r\0]/.test(value)) badRequest(`${name} holds a line break or NUL.`);
}

/** Whether `file` is an existing regular file. */
function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Whether `dir` is an existing directory. */
function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check a request before anything starts: `cwd` an existing absolute folder,
 * `promptFile` an existing absolute file, the session id safe as a file name,
 * the permission mode known, no value holding a line break or NUL, and the
 * account one of the request's runtime:
 *
 * - `claude-code`, `codex`: `path` absolute, or `null` only for the implicit
 *   {@link DEFAULT_ACCOUNT_ID} account.
 * - `opencode`: `path` `null` (an OpenCode account is a provider, not a folder),
 *   and a model of the form `provider/model` naming the account's provider.
 *
 * @param req - The request.
 * @throws {LaunchError} `bad-request` naming the first problem.
 */
export function validateLaunchRequest(req: LaunchRequest): void {
  const strings: Array<[string, string | undefined]> = [
    ['identifier', req.identifier],
    ['cwd', req.cwd],
    ['promptFile', req.promptFile],
    ['sessionId', req.sessionId],
    ['model', req.model],
    ['title', req.title],
    ['account.id', req.account?.id],
    ['account.path', req.account?.path ?? undefined],
    ['account.provider', req.account?.provider],
  ];
  for (const [name, value] of strings) {
    if (value === undefined) continue;
    if (typeof value !== 'string') badRequest(`${name} must be a string.`);
    refuseBreaks(name, value);
  }
  if (!path.isAbsolute(req.cwd)) badRequest(`cwd must be an absolute path, not "${req.cwd}".`);
  if (!isDir(req.cwd)) badRequest(`cwd ${req.cwd} is not an existing folder.`);
  if (!path.isAbsolute(req.promptFile)) {
    badRequest(`promptFile must be an absolute path, not "${req.promptFile}".`);
  }
  if (!isFile(req.promptFile)) badRequest(`promptFile ${req.promptFile} does not exist.`);
  if (!SESSION_ID_PATTERN.test(req.sessionId)) {
    badRequest(`sessionId "${req.sessionId}" is not a session id.`);
  }
  if (!PERMISSION_MODES.includes(req.permissionMode)) {
    badRequest(`permissionMode must be default, acceptEdits or bypassPermissions.`);
  }
  const account = req.account;
  if (account === null) return;
  if (account.runtime !== req.runtime) {
    badRequest(
      `The account ${account.id} is a ${account.runtime} account, not a ${req.runtime} one.`
    );
  }
  if (req.runtime === 'opencode') {
    if (account.path !== null) {
      badRequest(
        `An opencode account names a provider, not a folder, so its path must be null, not "${account.path}".`
      );
    }
    const provider = account.provider;
    if (provider !== undefined && req.model !== undefined && req.model.includes('/')) {
      const modelProvider = req.model.slice(0, req.model.indexOf('/'));
      if (modelProvider !== provider) {
        badRequest(
          `The model ${req.model} is from ${modelProvider}, but the account ${account.id} bills ${provider}.`
        );
      }
    }
    return;
  }
  if (account.path === null) {
    if (account.id !== DEFAULT_ACCOUNT_ID) {
      badRequest(
        `The account ${account.id} has no path; only the implicit default account may omit it.`
      );
    }
    return;
  }
  if (!path.isAbsolute(account.path)) {
    badRequest(`The account's path must be absolute, not "${account.path}".`);
  }
}

/**
 * The {@link LaunchAccount} for one account from the shared resolver
 * (`resolveAccounts`, spec `flow-cli-core` §1.1a rev 6d). A standalone
 * `default` carries its machine-wide folder, and an aliased one is its row
 * (id and folder), so the cli and cmux launchers start it where `default`
 * really lives. Only OpenCode's ambient default keeps `path: null`.
 *
 * @param account - A resolved account.
 * @returns The launch account.
 */
export function launchAccountFor(
  account: Pick<RuntimeAccount, 'runtime' | 'id' | 'path'>
): LaunchAccount {
  return { runtime: account.runtime, id: account.id, path: account.path };
}

/**
 * Whether an account means the ambient environment: none named, or one with no
 * path and no provider (the implicit {@link DEFAULT_ACCOUNT_ID} account).
 *
 * @param account - The request's account.
 * @returns True for the ambient account.
 */
export function isAmbientAccount(account: LaunchAccount | null): boolean {
  return account === null || (account.path === null && account.provider === undefined);
}

/**
 * Check a message file for {@link Launcher.send}: absolute, existing, no line break.
 *
 * @param file - The message file.
 * @throws {LaunchError} `bad-request` naming the problem.
 */
export function validateMessageFile(file: string): void {
  refuseBreaks('The message file', file);
  if (!path.isAbsolute(file))
    badRequest(`The message file must be an absolute path, not "${file}".`);
  if (!existsSync(file) || !isFile(file)) badRequest(`The message file ${file} does not exist.`);
}

/**
 * The Claude Code config dir a session runs in: the account's path, or for the
 * ambient account the supervisor's own resolved dir (its `CLAUDE_CONFIG_DIR`,
 * else `<osHome>/.claude`), made absolute.
 *
 * @param account - The account, or `null` (or a path-less default) for the ambient account.
 * @param env - The supervisor's environment.
 * @param osHome - The OS home folder.
 * @returns The absolute config dir.
 */
export function sessionConfigDir(
  account: LaunchAccount | null,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string {
  // Claude Code always has an ambient folder, so the lookup never returns null.
  return path.resolve(account?.path ?? (ambientAccountPath('claude-code', env, osHome) as string));
}

/**
 * The Codex home a session runs in, the way the Codex CLI resolves its own: the
 * account's path, or for the ambient account the supervisor's `CODEX_HOME`,
 * else `<osHome>/.codex`, made absolute. It is always set explicitly on the
 * child, so the session can never land in a home flow did not name.
 *
 * @param account - The account, or `null` (or a path-less default) for the ambient account.
 * @param env - The supervisor's environment.
 * @param osHome - The OS home folder.
 * @returns The absolute `CODEX_HOME`.
 */
export function sessionCodexHome(
  account: LaunchAccount | null,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string {
  if (account?.path) return path.resolve(account.path);
  const configured = env.CODEX_HOME;
  return path.resolve(
    configured !== undefined && configured !== '' ? configured : path.join(osHome, '.codex')
  );
}

/**
 * The runtime home a session runs in: {@link sessionConfigDir} for claude-code,
 * {@link sessionCodexHome} for codex, and `null` for opencode (no home: its
 * account is the ambient provider credential).
 *
 * @param runtime - The session's runtime.
 * @param account - The account, or `null` for the ambient account.
 * @param env - The supervisor's environment.
 * @param osHome - The OS home folder.
 * @returns The absolute home, or `null`.
 */
export function sessionHome(
  runtime: RuntimeName,
  account: LaunchAccount | null,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string | null {
  if (runtime === 'claude-code') return sessionConfigDir(account, env, osHome);
  if (runtime === 'codex') return sessionCodexHome(account, env, osHome);
  return null;
}

/**
 * The `CLAUDE_CONFIG_DIR` value that pins a Claude Code child to `root`, or
 * `undefined` for "leave it unset" (DorkOS's `claudeConfigDirEnv`, the same rule).
 *
 * Claude Code names its macOS Keychain login `Claude Code-credentials` plus
 * `-<8 hex of sha256(config dir)>`, and takes the UNSUFFIXED name exactly when
 * `CLAUDE_CONFIG_DIR` is unset. `~/.claude`'s login is normally the unsuffixed
 * one, so spelling `CLAUDE_CONFIG_DIR=~/.claude` out would point the child at a
 * login that was never created. So:
 *
 * - `root` is `<osHome>/.claude` and the supervisor's own `CLAUDE_CONFIG_DIR`
 *   does not name that same dir: unset. This covers no variable at all, and a
 *   supervisor on another account (`~/.claude3`) selecting `~/.claude`.
 * - Otherwise: `root`, explicitly. A supervisor that itself exports
 *   `CLAUDE_CONFIG_DIR=~/.claude` signed in under the suffixed name, so naming
 *   the path is right for it.
 *
 * Named accounts and the ambient one follow the same rule. Proving the account
 * still looks under `root`, where Claude Code writes either way.
 *
 * @param root - The absolute config dir the child must run in.
 * @param env - The supervisor's environment.
 * @param osHome - The OS home folder.
 * @returns The value to set, or `undefined` to remove the variable.
 */
export function claudeConfigDirValue(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string | undefined {
  const ambient = env.CLAUDE_CONFIG_DIR;
  const isDefaultRoot = path.resolve(root) === path.resolve(osHome, '.claude');
  const ambientNamesRoot =
    ambient !== undefined && ambient !== '' && path.resolve(ambient) === path.resolve(root);
  return isDefaultRoot && !ambientNamesRoot ? undefined : root;
}

/**
 * The child's environment: the supervisor's, minus the runtime's
 * {@link RUNTIME_CREDENTIAL_ENV_VARS}, with the runtime's home variable
 * ({@link RUNTIME_HOME_ENV_VAR}) set explicitly to `home`, except that Claude
 * Code's is removed where {@link claudeConfigDirValue} says unset.
 *
 * @param env - The supervisor's environment.
 * @param runtime - The session's runtime.
 * @param home - The runtime home the session must run in (`null` for opencode).
 * @param osHome - The OS home folder, for the `~/.claude` rule.
 * @returns A new environment object.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  runtime: RuntimeName,
  home: string | null,
  osHome: string
): Record<string, string> {
  const out: Record<string, string> = {};
  const homeVar = RUNTIME_HOME_ENV_VAR[runtime];
  const drop = new Set<string>(RUNTIME_CREDENTIAL_ENV_VARS[runtime]);
  if (homeVar !== null) drop.add(homeVar);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || drop.has(key)) continue;
    out[key] = value;
  }
  if (homeVar === null || home === null) return out;
  const value = runtime === 'claude-code' ? claudeConfigDirValue(home, env, osHome) : home;
  if (value !== undefined) out[homeVar] = value;
  return out;
}

/**
 * Whether a `ps -o command=` line is a Claude Code process: its program is
 * `claude` (or `claude.exe`, or a versioned binary under `claude/versions/`), or
 * `node` running a script whose path names Claude Code.
 *
 * @param command - The full command line `ps` printed.
 * @returns True for a `claude` command.
 */
export function isClaudeCommand(command: string): boolean {
  const [program = '', script = ''] = command.trim().split(/\s+/);
  const base = path.basename(program);
  if (base === 'claude' || base === 'claude.exe') return true;
  if (/[/\\]claude[/\\]versions[/\\][^/\\]+$/.test(program)) return true;
  return /^node(\.exe)?$/.test(base) && /claude/i.test(script);
}

/**
 * Whether a `ps -o command=` line runs `runtime`'s binary: {@link isClaudeCommand}
 * for claude-code; for codex and opencode, a program named `codex`/`opencode`
 * (or `.exe`), or `node` running a script whose file name is that binary (the
 * npm launchers, `bin/codex.js` and the like).
 *
 * @param runtime - The runtime flow started.
 * @param command - The full command line `ps` printed.
 * @returns True when the line runs that runtime.
 */
export function isRuntimeCommand(runtime: RuntimeName, command: string): boolean {
  if (runtime === 'claude-code') return isClaudeCommand(command);
  const [program = '', script = ''] = command.trim().split(/\s+/);
  const name = runtime;
  const base = path.basename(program).replace(/\.exe$/, '');
  if (base === name) return true;
  const scriptBase = path.basename(script).replace(/\.(c?js|mjs|exe)$/, '');
  return /^node(\.exe)?$/.test(path.basename(program)) && scriptBase === name;
}

/** What {@link stopRecordedPid} needs from the machine. */
export interface StopPidDeps {
  /** Runs `ps` (no shell). */
  run: ProcessRunner;
  /** Whether a pid exists. */
  isAlive: (pid: number) => boolean;
  /** Sends a signal. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

/** One `ps -o <field>= -p <pid>` answer, trimmed; `null` when ps says nothing. */
async function psField(run: ProcessRunner, pid: number, field: string): Promise<string | null> {
  try {
    const result = await run('ps', ['-o', `${field}=`, '-p', String(pid)], { timeoutMs: 10_000 });
    const text = result.stdout.trim();
    return result.code === 0 && text !== '' ? text : null;
  } catch {
    return null;
  }
}

/**
 * A process's start time as `ps -o lstart=` prints it: its identity beside the
 * pid, read right after flow learns the pid and kept as `SessionHandle.pidStart`.
 *
 * @param run - Runs `ps` (no shell).
 * @param pid - The process.
 * @returns The start time, or `undefined` when ps could not say.
 */
export async function readPidStart(run: ProcessRunner, pid: number): Promise<string | undefined> {
  return (await psField(run, pid, 'lstart')) ?? undefined;
}

/** Who flow expects to find at a recorded pid. */
export interface PidIdentity {
  /** The start time recorded at spawn ({@link readPidStart}), when there is one. */
  pidStart?: string;
  /** The session the process runs, for a handle recorded without `pidStart`. */
  sessionId: string;
}

/**
 * Stop a process flow started, by the pid it recorded, only while that pid is
 * still flow's process:
 *
 * - `ps -o command=` shows the runtime's binary ({@link isRuntimeCommand}); and
 * - with a recorded `pidStart`, `ps -o lstart=` shows that same start time, so a
 *   pid the OS gave to another process, even the operator's own `claude` for
 *   the same session, is left alone;
 * - without one (a handle written before it existed), the command line names
 *   the session id.
 *
 * Anything else, or a pid that is gone, is left alone.
 *
 * @param pid - The recorded pid.
 * @param runtime - The runtime flow started under that pid.
 * @param deps - Process access.
 * @param identity - The recorded start time and session.
 * @returns `stopped` after a SIGTERM; `not-running` when there was nothing of flow's to stop.
 */
export async function stopRecordedPid(
  pid: number,
  runtime: RuntimeName,
  deps: StopPidDeps,
  identity: PidIdentity
): Promise<StopResult> {
  if (!Number.isInteger(pid) || pid <= 0 || !deps.isAlive(pid)) return 'not-running';
  const command = await psField(deps.run, pid, 'command');
  if (command === null || !isRuntimeCommand(runtime, command)) return 'not-running';
  if (identity.pidStart !== undefined) {
    if ((await psField(deps.run, pid, 'lstart')) !== identity.pidStart) return 'not-running';
  } else if (!command.includes(identity.sessionId)) {
    return 'not-running';
  }
  try {
    deps.kill(pid, 'SIGTERM');
  } catch {
    return 'not-running';
  }
  return 'stopped';
}
