/**
 * The checks a verb that acts as the person makes first (DOR-3712,
 * DOR-3716): `flow answer --text`, `flow review --approve --by person` and
 * `flow review --changes`.
 *
 * - {@link requirePersonShell}: refuse a shell inside an agent. An agent's
 *   shell carries its runtime's markers (Claude Code, Codex, OpenCode); any
 *   `FLOW_RUNTIME`, known or not, and DorkOS's agent token
 *   (`DORKOS_AGENT_TOKEN`) count as an agent too. DorkOS runs these verbs
 *   with all of them removed (`withoutAgent`), since the person who clicked
 *   is the one acting.
 * - {@link agentInChain}: the same refusal when the runtime's program is among
 *   the caller's parent processes (DOR-3718). Emptying the environment
 *   (`env -i`) does not change the chain, and OpenCode's shell needs no session
 *   id for this. The walk stops at DorkOS, which hosts agents below it: an agent
 *   above DorkOS started the server, and is not the one acting on a click. A
 *   server this cannot name (a dev server under `tsx`) is still flow's direct
 *   parent on a click, so a `node` or Electron parent ends the walk too.
 * - {@link refuseSessions}: the second guard, for a caller with no agent's
 *   markers that still carries a session id. Every session variable present
 *   counts ({@link callerSessionIds}), not only the one whose runtime marker
 *   is set, so an agent that dropped its markers but kept its session id is
 *   still refused (Security's probe on DOR-3716). OpenCode puts no session id
 *   in a command's environment, so it is caught by its marker, `--session` or
 *   its place in the chain.
 * - {@link sessionsThatWorked}: the sessions refused, the same for every verb.
 *
 * Their refusals are read by the agent they stop, so they say to stop and
 * hand the decision to the person, never how to get past the check (Security
 * M1 on DOR-3712). How a person acts from their own terminal is in the docs
 * and `--help` only. A guard, not a boundary: any process can unset these
 * variables (see `caller.ts`), and the chain has limits of its own:
 *
 * - A process that double-forks has launchd for a parent, and one renamed for
 *   DorkOS, or started through `node`, `npx tsx` or `tsx`, stops the walk, so a determined
 *   agent still gets past.
 * - A DorkOS Doe turn has no program to find. A one-line command runs as
 *   DorkOS's direct child (`sh -c` execs it), as a click does, so the chain
 *   cannot tell them apart. Only its agent token stops a Doe turn.
 * - When `ps` cannot be read (no `/bin/ps`, a busybox `ps`, perhaps Codex's
 *   sandbox, which is untested), the check passes and the record says `unknown`:
 *   it must never refuse a person for that, so it claims nothing there.
 *
 * Dependency-free.
 *
 * @module @dorkos/flow/cli/person-gate
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PersonGateError, PreconditionError } from '../errors.ts';
import { detectRuntime } from '../runtime-detect.ts';
import type { FlowRun } from '../flow-run.ts';
import { recordEvent } from './auto-journal.ts';
import type { VerbContext } from './context.ts';

/** The variables a runtime or flow puts a session id in. */
const SESSION_VARS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'FLOW_SESSION_ID'] as const;

/**
 * Every session id the caller carries: the verb's own (`--session`, else
 * `FLOW_SESSION_ID`) and every session variable present, whichever runtime's
 * marker is set or not.
 *
 * @param ctx - The verb's context.
 * @returns The ids, without duplicates.
 */
export function callerSessionIds(ctx: VerbContext): string[] {
  const ids = [ctx.sessionId, ...SESSION_VARS.map((name) => ctx.env[name])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/**
 * Every session that worked an item: the run's own, its drain worker and
 * reviewer, its VERIFY reviewer, the session that asked its question and that
 * question's checker. None of them may act as the person on it.
 *
 * @param run - The item's run.
 * @returns Their ids, possibly with gaps.
 */
export function sessionsThatWorked(run: FlowRun | undefined): (string | undefined)[] {
  return [
    run?.sessionId,
    run?.drain?.worker?.sessionId,
    run?.drain?.reviewer?.sessionId,
    run?.review?.reviewer?.sessionId,
    run?.question?.askedBy,
    run?.question?.checker?.sessionId,
  ];
}

/**
 * The agent this environment runs inside, or `null` for a person's shell.
 *
 * @param env - The environment.
 * @returns A name for the agent (`claude-code`, `a DorkOS agent`, …), or `null`.
 */
export function agentIn(env: Readonly<Record<string, string | undefined>>): string | null {
  const detected = detectRuntime(env);
  const named = (env.FLOW_RUNTIME ?? '').trim() !== '';
  const dorkosTurn = (env.DORKOS_AGENT_TOKEN ?? '') !== '';
  if (detected.runtime === 'unknown' && detected.markers.length === 0 && !named && !dorkosTurn) {
    return null;
  }
  // A FLOW_RUNTIME flow does not know (a launcher naming itself) still says an
  // agent runs here, and so does DorkOS's agent token.
  if (detected.runtime !== 'unknown') return detected.runtime;
  return detected.markers[0] ?? (dorkosTurn ? 'a DorkOS agent' : 'an agent runtime');
}

/** One process, as `ps` reports it. */
export interface ProcessRow {
  /** Its id. */
  pid: number;
  /** Its parent's id. */
  ppid: number;
  /** Its controlling terminal (`??` or `?` for none). */
  tty: string;
  /** The program it runs: a full path on macOS, a short name on Linux. */
  exe: string;
  /** Its command line. */
  args: string;
}

/** Where a person's action came from, for the local record: never any arguments. */
export interface PersonCaller {
  /** The terminal, `none`, or `unknown` when `ps` could not be read. */
  tty: string;
  /** The last part of the parent's program name, or `unknown`. */
  parent: string;
  /** The parent's process id, or `null` when `ps` could not be read. */
  ppid: number | null;
}

/** An absolute path, so a `ps` earlier on an agent's `PATH` is never the one run. */
const PS = '/bin/ps';
/** The most standard input a verb reads: far more than any answer or note it takes. */
const STDIN_LIMIT_BYTES = 64 * 1024;
/** How long the check waits for `ps`. */
const PS_TIMEOUT_MS = 5_000;
/** Programs that run a script, whose script is what names them. */
const INTERPRETERS = new Set(['node', 'bun', 'deno']);
/** Where an agent's npm package keeps the script node runs. */
const AGENT_PACKAGES: readonly (readonly [string, string])[] = [
  ['/@anthropic-ai/claude-code/', 'claude-code'],
  ['/@anthropic-ai/claude-agent-sdk/', 'claude-code'],
  ['/@openai/codex/', 'codex'],
  ['/opencode-ai/', 'opencode'],
];

/**
 * Join `ps`'s two reads into one table by pid. They are two reads because a
 * program's path can hold spaces, so the name and the command line cannot share
 * a line and still be told apart.
 *
 * @param names - Lines of `pid ppid tty comm`.
 * @param commands - Lines of `pid args`.
 * @returns The processes, by pid. A line it cannot read is left out.
 */
export function parseProcessTable(names: string, commands: string): Map<number, ProcessRow> {
  const args = new Map<number, string>();
  for (const line of commands.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null) args.set(Number(match[1]), match[2]);
  }
  const table = new Map<number, ProcessRow>();
  for (const line of names.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const exe = match[4].trim();
    table.set(pid, {
      pid,
      ppid: Number(match[2]),
      tty: match[3],
      exe,
      args: args.get(pid) ?? exe,
    });
  }
  return table;
}

/** The script an interpreter runs: its first argument that is not a flag. */
function scriptOf(row: ProcessRow): string | null {
  const words = row.args.split(/\s+/);
  if (!INTERPRETERS.has(path.basename(words[0] ?? ''))) return null;
  return words.slice(1).find((word) => !word.startsWith('-')) ?? null;
}

/** The agent runtime a program name means. Case matters: `Claude` is the desktop app. */
function runtimeNamed(name: string): string | null {
  if (name === 'claude') return 'claude-code';
  if (name === 'opencode') return 'opencode';
  return /^codex(-.*)?$/.test(name) ? 'codex' : null;
}

/**
 * The agent runtime this process runs, or `null`. Reads the program's name, then
 * what it started as (Claude Code's native install is a file named for its
 * version), then an interpreter's script. Never any other argument, so `vim
 * claude` is not an agent.
 */
function agentOf(row: ProcessRow): string | null {
  // A path with spaces is whole in `exe` and cut up in `args`, so `args` counts
  // only when it does not start with the program's own path.
  const started = row.args.startsWith(row.exe) ? null : (row.args.split(/\s+/)[0] ?? '');
  const direct =
    runtimeNamed(path.basename(row.exe)) ??
    (started === null ? null : runtimeNamed(path.basename(started)));
  if (direct !== null) return direct;
  const script = scriptOf(row);
  if (script === null) return null;
  const inPackage = AGENT_PACKAGES.find(([folder]) => script.includes(folder));
  return inPackage?.[1] ?? runtimeNamed(path.basename(script));
}

/** Whether this process is DorkOS: the Mac app, or the `dorkos` command. */
function isDorkos(row: ProcessRow): boolean {
  if (/^DorkOS( Helper.*)?$/.test(path.basename(row.exe))) return true;
  const script = scriptOf(row);
  return (
    script !== null &&
    (path.basename(script) === 'dorkos' ||
      /(^|\/)dorkos\/dist\/bin\/cli\.js$/.test(script) ||
      /(^|\/)packages\/cli\/dist\/bin\/cli\.js$/.test(script) ||
      script === 'dist/bin/cli.js')
  );
}

/** Whether this program is what a DorkOS server runs as, whatever it was started with. */
function startsVerbs(row: ProcessRow): boolean {
  const name = path.basename(row.exe);
  return name === 'node' || /^Electron( Helper.*)?$/.test(name);
}

/**
 * The agent runtime among a process's parents, nearest first, stopping at
 * DorkOS (see the module's notes on what this cannot see).
 *
 * @param table - The processes.
 * @param pid - The process to start from; it is not itself checked.
 * @returns The runtime's name, or `null`.
 */
export function agentInChain(table: ReadonlyMap<number, ProcessRow>, pid: number): string | null {
  const seen = new Set<number>([pid]);
  const parent = table.get(table.get(pid)?.ppid ?? -1);
  let row = parent;
  while (row !== undefined && !seen.has(row.pid)) {
    const agent = agentOf(row);
    if (agent !== null) return agent;
    if (isDorkos(row) || (row === parent && startsVerbs(row))) return null;
    seen.add(row.pid);
    row = table.get(row.ppid);
  }
  return null;
}

/**
 * Where a process's action came from, for the local record.
 *
 * @param table - The processes, or `null` when `ps` could not be read.
 * @param pid - The process.
 * @returns Its terminal and parent, with no arguments.
 */
export function callerOf(table: ReadonlyMap<number, ProcessRow> | null, pid: number): PersonCaller {
  const self = table?.get(pid);
  if (self === undefined) return { tty: 'unknown', parent: 'unknown', ppid: null };
  const parent = table?.get(self.ppid);
  return {
    tty: self.tty === '??' || self.tty === '?' ? 'none' : self.tty,
    parent: parent === undefined ? 'unknown' : path.basename(parent.exe),
    ppid: self.ppid,
  };
}

/** Read every process, or `null` when `ps` cannot be read. */
async function readProcessTable(ctx: VerbContext): Promise<Map<number, ProcessRow> | null> {
  try {
    const opts = { timeoutMs: PS_TIMEOUT_MS };
    const [names, commands] = await Promise.all([
      ctx.runProcess(PS, ['-axww', '-o', 'pid=,ppid=,tty=,comm='], opts),
      ctx.runProcess(PS, ['-axww', '-o', 'pid=,args='], opts),
    ]);
    if (names.code !== 0 || commands.code !== 0) return null;
    const table = parseProcessTable(names.stdout, commands.stdout);
    return table.has(process.pid) ? table : null;
  } catch {
    return null;
  }
}

/**
 * Refuse a shell inside an agent: by its environment, then by its parents.
 *
 * @param ctx - The verb's context.
 * @param refusal - The message, given the agent's name.
 * @returns Where the action came from, for {@link recordPersonAct}.
 * @throws {PreconditionError} When the shell is an agent's.
 */
export async function requirePersonShell(
  ctx: VerbContext,
  refusal: (agent: string) => string
): Promise<PersonCaller> {
  const agent = agentIn(ctx.env);
  if (agent !== null) throw new PersonGateError(refusal(agent));
  const table = await readProcessTable(ctx);
  const inChain = table === null ? null : agentInChain(table, process.pid);
  if (inChain !== null) throw new PersonGateError(refusal(inChain));
  return callerOf(table, process.pid);
}

/**
 * Read a person's words from a file, or from standard input for `-`. Call it
 * after {@link requirePersonShell}, so flow never waits on an agent's stream.
 *
 * @param ctx - The verb's context.
 * @param file - The flag's value.
 * @returns The text.
 * @throws {Error} When it cannot be read, or standard input is too long.
 */
export async function readWords(ctx: VerbContext, file: string): Promise<string> {
  if (file !== '-') return readFileSync(path.resolve(ctx.cwd, file), 'utf8');
  const text = await ctx.io.stdin.read(STDIN_LIMIT_BYTES);
  if (text === null) throw new Error('standard input is too long');
  return text;
}

/**
 * Leave the local record of a person's action: where it came from, never its
 * words. A journal line is never worth failing the verb (`auto-journal.ts`).
 *
 * @param ctx - The verb's context.
 * @param verb - The verb that acted.
 * @param item - The item.
 * @param caller - What {@link requirePersonShell} returned.
 */
export function recordPersonAct(
  ctx: VerbContext,
  verb: 'answer' | 'review',
  item: string,
  caller: PersonCaller
): void {
  recordEvent(ctx, {
    kind: 'person.act',
    verb,
    item,
    tty: caller.tty,
    parent: caller.parent,
    ...(caller.ppid === null ? {} : { ppid: caller.ppid }),
  });
}

/**
 * Refuse a caller whose session is one of `sessions` (empty and missing ids
 * ignored).
 *
 * @param ctx - The verb's context.
 * @param sessions - The sessions that may not act as the person here.
 * @param refusal - The message.
 * @throws {PreconditionError} When the caller is one of them.
 */
export function refuseSessions(
  ctx: VerbContext,
  sessions: readonly (string | null | undefined)[],
  refusal: string
): void {
  const barred = new Set(
    sessions.filter((id): id is string => typeof id === 'string' && id !== '')
  );
  if (callerSessionIds(ctx).some((id) => barred.has(id))) throw new PreconditionError(refusal);
}
