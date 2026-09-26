/**
 * The live tier's breach check (spec `specs/flow-self-improvement` §1, tier
 * `live`): after a case, scan the child's `tool_use` events for anything that
 * left the fences. A breach fails the case whatever its oracle says.
 *
 * - **Reads** may reach the sandbox project or the flow root.
 * - **Writes** may reach the sandbox project ONLY. The sandbox's
 *   `.agents/flow/adapters/fake/` is a link into the plugin, so every path is
 *   judged by its realpath: an Edit through the link is a write into the flow
 *   root, the checkout the oracles themselves run from.
 * - A command naming a forbidden tool ({@link forbiddenName}) is a breach.
 * - A path the check cannot resolve is a breach: one taken from a variable
 *   (`$HOME/...`, `${X}`) or from `process.env` (how the fake's store path
 *   reaches code). The store sits outside the project, so a `..` path to it
 *   is caught by its realpath.
 *
 * What counts as a write in a Bash command: a redirect target (`>`, `>>`,
 * `2>`), the arguments of `tee`, `rm`, `touch`, `mkdir` and `mv`, the last
 * argument of `cp`, and every path in a command that calls a Node file-writing
 * function (`writeFileSync`, `rmSync`, ...). Everything else a command names
 * is a read. `git` with a mutating subcommand aimed at another folder
 * (`-C`, `--git-dir`, `--work-tree`) writes there, and `git config --global`
 * or `--system` is a breach. A Write or Edit whose content calls a Node
 * file-writing function is judged by every quoted string in it, so a script
 * written into the sandbox cannot carry a write out of it. On macOS the temp folder is `/var/...` and its realpath
 * `/private/var/...`, so both sides are compared as realpaths.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/selftest/live/breach
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { forbiddenName } from './denylist.ts';

/** A tool call the child made, as the stream reports it. */
export interface ToolUse {
  /** The tool, for example `Bash` or `Read`. */
  name: string;
  /** Its input. */
  input: Record<string, unknown>;
}

/** Where a case may read and write. */
export interface BreachBounds {
  /** The sandbox project: readable and writable. */
  sandbox: string;
  /** The flow root: readable only. */
  flowRoot: string;
  /** The home folder, for `~`. */
  home: string;
}

/** Tools whose path field is a write. */
const WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** The input fields that name a file or folder. */
const PATH_FIELDS: readonly string[] = ['file_path', 'path', 'notebook_path'];

/** Paths a command may name that are not files a case could reach anything through. */
const HARMLESS_PATHS: readonly string[] = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin'];

/** Commands whose every argument is a write target. */
const WRITING_COMMANDS: readonly string[] = ['tee', 'rm', 'rmdir', 'touch', 'mkdir', 'mv'];

/** A Node call that writes, deletes or moves a file. */
const JS_WRITE =
  /\b(writeFile|appendFile|rmSync|rm|unlink|rename|cpSync|cp|copyFile|mkdir|rmdir|createWriteStream|truncate|symlink|link)(Sync)?\s*\(/;

/**
 * Git subcommands that change a repository or its config. Run against the
 * sandbox they are fine; aimed with `-C`, `--git-dir` or `--work-tree` at any
 * other folder they are writes there.
 */
const GIT_MUTATING: readonly string[] = [
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'config',
  'fetch',
  'gc',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
  'update-ref',
  'worktree',
];

/** Git options that take the next token as a folder the command acts on. */
const GIT_DIR_OPTIONS: readonly string[] = ['-C', '--git-dir', '--work-tree'];

/**
 * A variable used as a value: `$NAME` or `${NAME}` at the start of a token.
 * `$PWD` is left out: it is followed, per command segment, as the folder that
 * segment runs in.
 */
const VARIABLE_PATH = /(?:^|[\s'"=(:>])(\$\{?(?!PWD\b)[A-Za-z_][A-Za-z0-9_]*\}?)/;

/** `$PWD` or `${PWD}`. */
const PWD_VARIABLE = /\$\{PWD\}|\$PWD\b/g;

/** Commands that change the folder later segments run in. */
const FOLDER_CHANGERS: readonly string[] = ['cd', 'pushd', 'popd'];

/** A path read from the environment inside code. */
const ENV_READ = /\bprocess\.env\b/;

/** A redirect and its target: `>`, `>>`, `2>`, `&>`, but not `>&2`. */
const REDIRECT = /(?:^|[^>])>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g;

/** Characters that split a command into tokens. */
const TOKEN_SPLIT = /[\s'"`=(),;|&<>{}[\]]+/;

/**
 * The realpath of a path that may not exist yet: the realpath of its nearest
 * existing ancestor, with the rest appended. A write to a new file under a
 * link is then judged by where the link goes.
 */
function realpathOf(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return path.join(real, ...rest);
}

/** Whether `child` is `base` or inside it. */
function within(child: string, base: string): boolean {
  return child === base || child.startsWith(`${base}${path.sep}`);
}

/** Strip one layer of matching quotes. */
function unquote(token: string): string {
  return /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token;
}

/** Whether a token looks like a path worth resolving for a READ: absolute, `~`, or with a `..` segment. */
function readCandidate(token: string): boolean {
  return (
    token.startsWith('/') ||
    token === '~' ||
    token.startsWith('~/') ||
    /(^|\/)\.\.(\/|$)/.test(token)
  );
}

/** One piece of a command: a simple command, or the start or end of a nested one. */
type Piece = { kind: 'segment'; text: string } | { kind: 'open' } | { kind: 'close' };

/**
 * Split a command into its simple commands, in order, marking where a nested
 * command starts and ends: `$(...)`, backticks, and a `(...)` subshell at a
 * command position. Separators are `;`, `&&`, `||`, `|`, `&` and newlines.
 * Quotes are respected: nothing inside single quotes splits, and inside double
 * quotes only `$(` and backticks open a nested command (the shell runs those
 * too). So `$(cd x && node -e "f('a')")` is three pieces and a pair of marks,
 * and the parentheses in the quoted code are left alone.
 */
function pieces(command: string): Piece[] {
  const out: Piece[] = [];
  const frames: { quote: string | null; closer: string | null }[] = [{ quote: null, closer: null }];
  let buffer = '';
  const flush = () => {
    if (buffer.trim() !== '') out.push({ kind: 'segment', text: buffer.trim() });
    buffer = '';
  };
  const open = (closer: string) => {
    flush();
    out.push({ kind: 'open' });
    frames.push({ quote: null, closer });
  };
  const close = () => {
    flush();
    out.push({ kind: 'close' });
    frames.pop();
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const next = command[i + 1];
    const frame = frames[frames.length - 1];
    if (frame.quote === "'") {
      buffer += c;
      if (c === "'") frame.quote = null;
    } else if (c === '\\') {
      buffer += c + (next ?? '');
      i += 1;
    } else if (c === '$' && next === '(') {
      open(')');
      i += 1;
    } else if (c === '`') {
      if (frame.closer === '`') close();
      else open('`');
    } else if (frame.quote === '"') {
      buffer += c;
      if (c === '"') frame.quote = null;
    } else if (c === "'" || c === '"') {
      buffer += c;
      frame.quote = c;
    } else if (c === '(' && buffer.trim() === '') {
      open(')');
    } else if (c === ')' && frame.closer === ')') {
      close();
    } else if (
      c === ';' ||
      c === '\n' ||
      c === '|' ||
      // `&` separates, except in a redirect: `2>&1`, `&>file`, `>&2`.
      (c === '&' && command[i - 1] !== '>' && command[i - 1] !== '<' && next !== '>')
    ) {
      flush();
      if ((c === '|' || c === '&') && next === c) i += 1;
    } else {
      buffer += c;
    }
  }
  flush();
  return out;
}

/**
 * What a `git` command writes: the folder a mutating subcommand is aimed at,
 * or a refusal for a config write outside any repository (`--global`,
 * `--system`).
 */
function gitWrites(segment: string): { writes: string[]; refusal?: string } {
  // Split on whitespace only: `-c key=value` and `--git-dir=<dir>` keep their shape.
  const tokens = segment
    .split(/\s+/)
    .filter((t) => t !== '')
    .map(unquote);
  const dirs: string[] = [];
  let subcommand: string | undefined;
  for (let i = 1; i < tokens.length && subcommand === undefined; i += 1) {
    const token = tokens[i];
    const [option, attached] = token.split(/=(.*)/s, 2);
    if (attached !== undefined && GIT_DIR_OPTIONS.includes(option)) {
      dirs.push(attached);
    } else if (GIT_DIR_OPTIONS.includes(token)) {
      if (tokens[i + 1] !== undefined) dirs.push(tokens[i + 1]);
      i += 1;
    } else if (token === '-c') {
      i += 1;
    } else if (!token.startsWith('-')) {
      subcommand = token;
    }
  }
  if (subcommand === undefined || !GIT_MUTATING.includes(subcommand)) return { writes: [] };
  if (subcommand === 'config' && tokens.some((t) => t === '--global' || t === '--system')) {
    return { writes: [], refusal: 'changed git config outside the sandbox' };
  }
  return { writes: dirs };
}

/** A path a command names, and the folder it was named from. */
interface Located {
  /** The path as the command spells it. */
  raw: string;
  /** The folder the command was in when it named the path. */
  base: string;
}

/**
 * The paths one Bash command reads and writes, following `cd`, `pushd` and
 * `popd` through it, or why it is a breach outright.
 *
 * Each path is resolved against the folder the command is in at that point.
 * A nested command (`$(...)`, backticks, a `(...)` subshell) starts in its
 * parent's folder, and a `cd` inside it ends with it, as in the shell.
 *
 * A `cd` into the flow root is allowed: a read there is fine, and a relative
 * write there resolves into the flow root and fails as a write. A `cd`
 * outside both the sandbox and the flow root is a breach by itself.
 *
 * @param command - The command, with `$CLAUDE_PLUGIN_ROOT` already expanded.
 * @param start - The sandbox (the folder the command starts in).
 * @param into - The realpath a `cd` target resolves to, from a given folder.
 * @param reachable - Whether a realpath is inside the sandbox or the flow root.
 */
function commandPaths(
  command: string,
  start: string,
  into: (from: string, target: string) => string,
  reachable: (real: string) => boolean
): { reads: Located[]; writes: Located[]; refusal?: string } {
  const reads: Located[] = [];
  const writes: Located[] = [];
  // One pushd stack per nesting level; a nested command starts in its parent's folder.
  const scopes: string[][] = [[start]];
  for (const piece of pieces(command)) {
    const stack = scopes[scopes.length - 1];
    const current = stack[stack.length - 1];
    if (piece.kind === 'open') {
      scopes.push([current]);
      continue;
    }
    if (piece.kind === 'close') {
      if (scopes.length > 1) scopes.pop();
      continue;
    }
    const segment = piece.text.replace(PWD_VARIABLE, current);
    const at = (list: Located[], paths: readonly string[]) =>
      list.push(...paths.map((p) => ({ raw: p, base: current })));
    at(
      writes,
      [...segment.matchAll(REDIRECT)].map((m) => unquote(m[1]))
    );
    const tokens = segment.split(TOKEN_SPLIT).filter((t) => t !== '');
    const verb = path.basename(tokens[0] ?? '');
    const args = tokens.slice(1).filter((t) => !t.startsWith('-'));
    if (FOLDER_CHANGERS.includes(verb)) {
      if (verb === 'popd') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const words = segment
        .split(/\s+/)
        .filter((t) => t !== '')
        .map(unquote);
      const target = words.slice(1).find((t) => !t.startsWith('-') || t === '-') ?? '~';
      const next = target === '-' ? (stack[stack.length - 2] ?? start) : into(current, target);
      if (!reachable(next)) {
        return {
          reads,
          writes,
          refusal: `changed folder to ${target}, outside the sandbox and the flow root`,
        };
      }
      if (verb === 'pushd') stack.push(next);
      else stack[stack.length - 1] = next;
      continue;
    }
    if (JS_WRITE.test(segment)) {
      // Every quoted string in the program, and any path-like argument after it.
      at(writes, [
        ...quotedPaths(segment),
        ...tokens.filter((t) => t.includes('/') || readCandidate(t)),
      ]);
    } else if (WRITING_COMMANDS.includes(verb)) {
      at(writes, args);
    } else if (verb === 'cp' && args.length > 0) {
      at(writes, [args[args.length - 1]]);
    } else if (verb === 'git') {
      const git = gitWrites(segment);
      if (git.refusal !== undefined) return { reads, writes, refusal: git.refusal };
      at(writes, git.writes);
    }
    at(reads, tokens.filter(readCandidate));
  }
  return { reads, writes };
}

/**
 * The strings in some code that could be a file path: every single-, double-
 * and backtick-quoted string, each kind read on its own (so `'a.ts'` inside a
 * double-quoted `node -e` program is found), leaving out empty ones and ones
 * holding whitespace or parentheses, which are code or prose, not a path.
 */
function quotedPaths(code: string): string[] {
  const found: string[] = [];
  for (const re of [/'([^'\\\n]*)'/g, /"([^"\\\n]*)"/g, /`([^`\\\n]*)`/g]) {
    for (const match of code.matchAll(re)) found.push(match[1]);
  }
  // Path-shaped strings first, so a breach names the file rather than `'fs'`.
  const pathShaped = (p: string) => (/[./]/.test(p) ? 0 : 1);
  return found
    .filter((p) => p !== '' && !/[\s()]/.test(p))
    .sort((a, b) => pathShaped(a) - pathShaped(b));
}

/**
 * The file paths a script writes: when `code` calls a Node file-writing
 * function, every quoted string in it ({@link quotedPaths}), since any of them
 * may be the target. A script that takes its path from the environment cannot
 * be followed.
 */
function scriptWrites(code: string): { writes: string[]; refusal?: string } {
  if (!JS_WRITE.test(code)) return { writes: [] };
  if (ENV_READ.test(code)) return { writes: [], refusal: 'writes to a path from process.env' };
  return { writes: quotedPaths(code) };
}

/** `$CLAUDE_PLUGIN_ROOT` read as the flow root (`$PWD` is followed per segment). */
function expandPluginRoot(command: string, bounds: BreachBounds): string {
  return command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, bounds.flowRoot);
}

/**
 * Find the first tool call that left the fences.
 *
 * `$CLAUDE_PLUGIN_ROOT` (how flow's own commands name its scripts) is read as
 * the flow root and `$PWD` as the folder the command is in at that point (the
 * sandbox, or where a `cd` took it); any other variable is a breach.
 *
 * Call it before the sandbox is deleted: realpaths are read from disk.
 *
 * @param uses - The child's tool calls.
 * @param bounds - The sandbox project, the flow root and the home folder.
 * @returns What breached, in one line, or `undefined`.
 */
export function findBreach(uses: readonly ToolUse[], bounds: BreachBounds): string | undefined {
  const sandbox = realpathOf(bounds.sandbox);
  const flowRoot = realpathOf(bounds.flowRoot);
  const resolve = (raw: string, base: string = bounds.sandbox): string => {
    const expanded =
      raw === '~' ? bounds.home : raw.startsWith('~/') ? path.join(bounds.home, raw.slice(2)) : raw;
    return realpathOf(path.resolve(base, expanded));
  };
  const badRead = (raw: string, base?: string): boolean => {
    if (HARMLESS_PATHS.includes(raw)) return false;
    const real = resolve(raw, base);
    return !within(real, sandbox) && !within(real, flowRoot);
  };
  const badWrite = (raw: string, base?: string): boolean => {
    if (HARMLESS_PATHS.includes(raw)) return false;
    return !within(resolve(raw, base), sandbox);
  };

  for (const use of uses) {
    const raw = use.input.command;
    if (typeof raw === 'string') {
      const command = expandPluginRoot(raw, bounds);
      const named = forbiddenName(command);
      if (named !== undefined) return `${use.name} ran a command naming ${named}: ${command}`;
      const variable = VARIABLE_PATH.exec(command);
      if (variable !== null) {
        return `${use.name} used ${variable[1]} as a path, which the check cannot follow: ${command}`;
      }
      if (ENV_READ.test(command)) {
        return `${use.name} read process.env, which the check cannot follow: ${command}`;
      }
      const { reads, writes, refusal } = commandPaths(
        command,
        sandbox,
        (from, target) => resolve(target, from),
        (real) => within(real, sandbox) || within(real, flowRoot)
      );
      if (refusal !== undefined) return `${use.name} ${refusal}: ${command}`;
      const write = writes.find((w) => badWrite(w.raw, w.base));
      if (write !== undefined) return `${use.name} wrote ${write.raw}, outside the sandbox`;
      const read = reads.find((r) => badRead(r.raw, r.base));
      if (read !== undefined) {
        return `${use.name} named ${read.raw}, outside the sandbox and the flow root`;
      }
    }
    const writing = WRITE_TOOLS.includes(use.name);
    if (writing) {
      const edits = Array.isArray(use.input.edits) ? (use.input.edits as unknown[]) : [];
      const code = [use.input.content, use.input.new_string, use.input.new_source]
        .concat(edits.map((e) => (e as { new_string?: unknown } | null)?.new_string))
        .filter((c): c is string => typeof c === 'string')
        .join('\n');
      const script = scriptWrites(code);
      if (script.refusal !== undefined) {
        return `${use.name} wrote a script that ${script.refusal}, which the check cannot follow`;
      }
      const target = script.writes.find((w) => badWrite(w));
      if (target !== undefined) {
        return `${use.name} wrote a script that writes ${target}, outside the sandbox`;
      }
    }
    for (const field of PATH_FIELDS) {
      const value = use.input[field];
      if (typeof value !== 'string' || value === '') continue;
      if (value.includes('$')) {
        return `${use.name} named ${value}, a path the check cannot follow`;
      }
      if (writing && badWrite(value)) return `${use.name} wrote ${value}, outside the sandbox`;
      if (!writing && badRead(value)) {
        return `${use.name} reached ${value}, outside the sandbox and the flow root`;
      }
    }
  }
  return undefined;
}
