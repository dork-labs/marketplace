/**
 * Argv parsing for the `flow` CLI (spec `flow-cli-core` §2).
 *
 * A verb declares its own flags, which of the common flags it takes and its
 * positionals; this module turns an argv into a {@link ParsedArgs} against that
 * declaration and throws a {@link UsageError} (exit 2) for anything it does not
 * recognize. It never loads a verb module, so it runs before `npm install`.
 *
 * Grammar: `flow [common flags] <verb> [args] [flags]`. Flags come as
 * `--name value`, `--name=value` or `-x value`; `--` ends flag parsing. Only
 * the common flags may precede the verb, because they are the only ones known
 * before the verb is.
 *
 * Dependency-free: only other zero-dependency local modules.
 *
 * @module @dorkos/flow/cli/args
 */

import { UsageError } from '../errors.ts';

/** One flag a verb accepts. */
export interface FlagSpec {
  /** Long name without dashes, e.g. `dry-run`. Also the key in {@link ParsedArgs.flags}. */
  readonly name: string;
  /** `boolean` flags take no value; `string` flags take exactly one. */
  readonly kind: 'boolean' | 'string';
  /** Optional one-letter alias without the dash, e.g. `n` for `-n`. */
  readonly short?: string;
  /** Placeholder for the value in help, e.g. `N` renders `<N>`. Defaults to `value`. */
  readonly value?: string;
  /**
   * A `string` flag that may be given more than once. Every value lands in
   * {@link ParsedArgs.repeated}, in order; {@link ParsedArgs.flags} holds the last.
   */
  readonly repeatable?: boolean;
  /** One plain sentence for help output. */
  readonly description: string;
}

/** One positional argument a verb accepts, in order. */
export interface PositionalSpec {
  /** Name shown in help and errors, e.g. `identifier`. */
  readonly name: string;
  /** Whether the verb cannot run without it. Defaults to optional. */
  readonly required?: boolean;
  /** One plain sentence for help output. */
  readonly description?: string;
  /** The last positional only: it takes any number of values, none included. */
  readonly variadic?: boolean;
}

/** The common flags a verb can opt into (the spec's common-flag table). */
export type CommonFlag = 'project' | 'snapshot' | 'dry-run' | 'session' | 'manual';

/** Everything the parser and help need to know about a verb. */
export interface VerbSpec {
  /** The verb as typed, e.g. `claim`. */
  readonly name: string;
  /** One line for the verb list in `flow --help`. */
  readonly summary: string;
  /** Longer help text printed under the usage line. Defaults to {@link summary}. */
  readonly description?: string;
  /** Which common flags this verb takes. `--json` and `--help` are always accepted. */
  readonly common?: readonly CommonFlag[];
  /** The verb's own flags. One with a common flag's name replaces it for this verb. */
  readonly flags?: readonly FlagSpec[];
  /** Positional arguments in order. Required ones must come first. */
  readonly positionals?: readonly PositionalSpec[];
}

/** The result of parsing one invocation. */
export interface ParsedArgs {
  /** The verb name. */
  readonly verb: string;
  /** Positional arguments after the verb, in order. */
  readonly positionals: readonly string[];
  /**
   * Every flag given except `--json` and `--help`, keyed by long name: the
   * string value, or `true` for a boolean flag.
   */
  readonly flags: Readonly<Record<string, string | true>>;
  /** Every value of each repeatable flag given, in order. Absent when none was. */
  readonly repeated?: Readonly<Record<string, readonly string[]>>;
  /** Whether `--json` was given. */
  readonly json: boolean;
}

/** The flags every verb accepts. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: 'json',
    kind: 'boolean',
    description: 'Print one JSON object on stdout instead of text.',
  },
  { name: 'help', kind: 'boolean', short: 'h', description: 'Show this help.' },
];

/** The common flags, which a verb opts into by name through {@link VerbSpec.common}. */
export const COMMON_FLAGS: Readonly<Record<CommonFlag, FlagSpec>> = {
  project: {
    name: 'project',
    kind: 'string',
    value: 'dir',
    description: 'The checkout to read config and run state from. Default: the current folder.',
  },
  snapshot: {
    name: 'snapshot',
    kind: 'string',
    value: 'file',
    description: 'Read this saved "flow snapshot --json" output instead of the tracker.',
  },
  'dry-run': {
    name: 'dry-run',
    kind: 'boolean',
    description: 'Print the planned change and write nothing.',
  },
  session: {
    name: 'session',
    kind: 'string',
    value: 'id',
    description:
      "The harness session id. Default: FLOW_SESSION_ID, else the runtime's own (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID).",
  },
  manual: {
    name: 'manual',
    kind: 'boolean',
    description: 'A person is driving: run even while flow is paused.',
  },
};

/**
 * Every flag a verb accepts: its own, then the common flags it opted into, then
 * `--json` and `--help`. A verb flag with a common flag's name wins.
 *
 * @param spec - The verb.
 * @returns The verb's flag table in help order.
 */
export function flagsFor(spec: VerbSpec): FlagSpec[] {
  const own = spec.flags ?? [];
  const taken = new Set(own.map((flag) => flag.name));
  const common = (spec.common ?? [])
    .map((name) => COMMON_FLAGS[name])
    .filter((flag) => !taken.has(flag.name));
  return [...own, ...common, ...GLOBAL_FLAGS];
}

/** The argv tokens before a bare `--`, where flags can appear. */
function flagZone(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

/**
 * Whether the invocation asks for help (`--help` or `-h` before any `--`).
 * Checked before strict parsing so help answers even a malformed call.
 *
 * @param argv - The arguments after the script path.
 * @returns `true` when help was asked for.
 */
export function wantsHelp(argv: readonly string[]): boolean {
  return flagZone(argv).some((token) => token === '--help' || token === '-h');
}

/**
 * Whether the invocation asks for JSON output (`--json` before any `--`).
 * Checked before strict parsing so a usage error can still be a JSON envelope.
 *
 * @param argv - The arguments after the script path.
 * @returns `true` when `--json` was given.
 */
export function wantsJson(argv: readonly string[]): boolean {
  return flagZone(argv).includes('--json');
}

/** Where the verb sits in argv, or `undefined` when there is none. */
export interface VerbLocation {
  /** The verb token. */
  readonly verb: string;
  /** Its index in argv. */
  readonly index: number;
}

/**
 * Find the verb: the first token that is not a flag or a common flag's value.
 * Only global and common flags may come before it.
 *
 * @param argv - The arguments after the script path.
 * @returns The verb and its index, or `undefined` when argv names no verb.
 * @throws {UsageError} On a flag before the verb that no verb shares.
 */
export function locateVerb(argv: readonly string[]): VerbLocation | undefined {
  const known = [...Object.values(COMMON_FLAGS), ...GLOBAL_FLAGS];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--')
      return argv[i + 1] === undefined ? undefined : { verb: argv[i + 1], index: i + 1 };
    if (!isFlagToken(token)) return { verb: token, index: i };
    const { flag, inlineValue } = matchFlag(token, known);
    if (flag.kind === 'string' && inlineValue === undefined) i += 1;
  }
  return undefined;
}

/**
 * Parse an invocation against its verb's declaration.
 *
 * @param argv - The arguments after the script path.
 * @param location - Where the verb sits, from {@link locateVerb}.
 * @param spec - The verb's declaration.
 * @returns The parsed invocation.
 * @throws {UsageError} On an unknown flag, a flag the verb does not take, a
 *   missing or unexpected value, a repeated flag, or a wrong positional count.
 */
export function parseVerbArgs(
  argv: readonly string[],
  location: VerbLocation,
  spec: VerbSpec
): ParsedArgs {
  const table = flagsFor(spec);
  const flags: Record<string, string | true> = {};
  const repeated: Record<string, string[]> = {};
  const positionals: string[] = [];
  let json = false;
  let flagsEnded = false;

  for (let i = 0; i < argv.length; i += 1) {
    if (i === location.index) continue;
    const token = argv[i];
    if (!flagsEnded && token === '--') {
      flagsEnded = true;
      continue;
    }
    if (flagsEnded || !isFlagToken(token)) {
      positionals.push(token);
      continue;
    }

    const { flag, inlineValue } = matchFlag(token, table, spec.name);
    if (flag.name === 'json') {
      if (inlineValue !== undefined) throw new UsageError('--json takes no value');
      json = true;
      continue;
    }
    if (flag.name === 'help') continue;
    if (flag.name in flags && !flag.repeatable) {
      throw new UsageError(`--${flag.name} was given twice`);
    }

    if (flag.kind === 'boolean') {
      if (inlineValue !== undefined) throw new UsageError(`--${flag.name} takes no value`);
      flags[flag.name] = true;
      continue;
    }
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || i + 1 === location.index || looksLikeFlag(next)) {
        throw new UsageError(`--${flag.name} needs a value`);
      }
      value = next;
      i += 1;
    }
    flags[flag.name] = value;
    if (flag.repeatable) (repeated[flag.name] ??= []).push(value);
  }

  checkPositionals(positionals, spec);
  return Object.keys(repeated).length > 0
    ? { verb: spec.name, positionals, flags, repeated, json }
    : { verb: spec.name, positionals, flags, json };
}

/** Enforce the verb's positional count: every required one present, none extra. */
function checkPositionals(positionals: readonly string[], spec: VerbSpec): void {
  const declared = spec.positionals ?? [];
  if (positionals.length > declared.length && !declared.at(-1)?.variadic) {
    throw new UsageError(
      `unexpected argument "${positionals[declared.length]}" for "flow ${spec.name}"`
    );
  }
  const missing = declared.slice(positionals.length).find((p) => p.required);
  if (missing) throw new UsageError(`missing <${missing.name}> for "flow ${spec.name}"`);
}

/** A token that parses as a flag: `--x`, `--x=y` or `-x`, but not `-` or `--`. */
function isFlagToken(token: string): boolean {
  return token.startsWith('-') && token !== '-' && token !== '--';
}

/**
 * Whether a token after a string flag is really another flag, not its value.
 * A negative number is a value.
 */
function looksLikeFlag(token: string): boolean {
  return isFlagToken(token) && !/^-\d/.test(token);
}

/** Resolve one flag token against a table, splitting off an `=value`. */
function matchFlag(
  token: string,
  table: readonly FlagSpec[],
  verb?: string
): { flag: FlagSpec; inlineValue?: string } {
  const long = token.startsWith('--');
  const body = token.slice(long ? 2 : 1);
  const eq = body.indexOf('=');
  const name = eq === -1 ? body : body.slice(0, eq);
  const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
  const flag = table.find((f) => (long ? f.name === name : f.short === name));
  if (flag) return { flag, inlineValue };

  const shown = long ? `--${name}` : `-${name}`;
  const commonName = Object.values(COMMON_FLAGS).find((f) => f.name === name);
  if (verb !== undefined && long && commonName) {
    throw new UsageError(`"flow ${verb}" does not take ${shown}`);
  }
  const where = verb === undefined ? '' : ` for "flow ${verb}"`;
  const help = verb === undefined ? 'flow --help' : `flow ${verb} --help`;
  throw new UsageError(`unknown flag ${shown}${where}; run "${help}" for the flags`);
}
