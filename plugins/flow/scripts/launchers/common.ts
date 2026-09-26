/**
 * The rules every launcher keeps (spec `flow-handoff-dispatch` §2.1): validate
 * the request before anything starts, build the child's environment (the
 * account's config dir set, every other credential removed), phrase every
 * message as a one-line pointer, and stop only a pid flow recorded.
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
import { defaultConfigDir } from '../fleet/config-dir.ts';
import {
  LaunchError,
  type LaunchAccount,
  type LaunchPermissionMode,
  type LaunchRequest,
  type StopResult,
} from './types.ts';

/**
 * Environment variables that carry a credential of their own. Any of them in a
 * child would bill that credential instead of the named account's login, so
 * every child environment is built without them.
 */
export const CREDENTIAL_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

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
 * `promptFile` an existing absolute file, `account.path` absolute, the session
 * id safe as a file name, the permission mode known, and no value holding a
 * line break or NUL.
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
    ['account.path', req.account?.path],
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
  if (req.account !== null && !path.isAbsolute(req.account.path)) {
    badRequest(`The account's path must be absolute, not "${req.account.path}".`);
  }
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
 * The config dir a session runs in: the account's path, or for the ambient
 * account the supervisor's own resolved dir (its `CLAUDE_CONFIG_DIR`, else
 * `<osHome>/.claude`), made absolute.
 *
 * @param account - The account, or `null` for the ambient account.
 * @param env - The supervisor's environment.
 * @param osHome - The OS home folder.
 * @returns The absolute config dir.
 */
export function sessionConfigDir(
  account: LaunchAccount | null,
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string {
  return path.resolve(account?.path ?? defaultConfigDir(env, osHome));
}

/**
 * The child's environment: the supervisor's, minus every
 * {@link CREDENTIAL_ENV_VARS} entry, with `CLAUDE_CONFIG_DIR` set explicitly.
 *
 * @param env - The supervisor's environment.
 * @param configDir - The config dir the session must run in.
 * @returns A new environment object.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  configDir: string
): Record<string, string> {
  const out: Record<string, string> = {};
  const drop = new Set<string>(CREDENTIAL_ENV_VARS);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || drop.has(key)) continue;
    out[key] = value;
  }
  out.CLAUDE_CONFIG_DIR = configDir;
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

/** What {@link stopRecordedPid} needs from the machine. */
export interface StopPidDeps {
  /** Runs `ps` (no shell). */
  run: ProcessRunner;
  /** Whether a pid exists. */
  isAlive: (pid: number) => boolean;
  /** Sends a signal. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Stop a process flow started, by the pid it recorded, only after `ps -o
 * command= -p <pid>` shows it still runs a `claude` command. A pid that is gone,
 * or now runs something else (the pid was reused), is left alone.
 *
 * @param pid - The recorded pid.
 * @param deps - Process access.
 * @returns `stopped` after a SIGTERM; `not-running` when there was nothing of flow's to stop.
 */
export async function stopRecordedPid(pid: number, deps: StopPidDeps): Promise<StopResult> {
  if (!Number.isInteger(pid) || pid <= 0 || !deps.isAlive(pid)) return 'not-running';
  let command: string;
  try {
    const result = await deps.run('ps', ['-o', 'command=', '-p', String(pid)], {
      timeoutMs: 10_000,
    });
    if (result.code !== 0) return 'not-running';
    command = result.stdout;
  } catch {
    return 'not-running';
  }
  if (!isClaudeCommand(command)) return 'not-running';
  try {
    deps.kill(pid, 'SIGTERM');
  } catch {
    return 'not-running';
  }
  return 'stopped';
}
