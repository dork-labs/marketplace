/**
 * The `flow` CLI entry point (spec `flow-cli-core` §2).
 *
 * Run it as `node --experimental-strip-types <flow-root>/scripts/flow.ts <verb>
 * [args] [flags]`. It owns three things and nothing else:
 *
 * - the verb table ({@link VERBS}), which the parser and `--help` read without
 *   loading any verb module;
 * - the run: parse argv, `import()` the one verb asked for, print its result;
 * - the one mapping from a thrown error to an exit code ({@link classifyError}).
 *
 * Every top-level import is dependency-free, so `--help`, a usage error and the
 * "run npm install" hint all work before `npm install`. Verbs that need `zod`
 * load it through their own module, and a failed load exits 6 naming the fix.
 *
 * @module @dorkos/flow/flow
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { invokedDirectly } from './_shared.ts';
import { locateVerb, parseVerbArgs, wantsHelp, wantsJson } from './cli/args.ts';
import {
  createVerbContext,
  realProcessRunner,
  type AdapterFactory,
  type CliDeps,
  type VerbDefinition,
} from './cli/context.ts';
import { Output, renderTopHelp, renderVerbHelp } from './cli/output.ts';
import { EXIT, FlowError, UsageError, type ExitCode } from './errors.ts';

/**
 * The verb table. Add a verb with one module under `scripts/cli/` and one entry
 * here whose `load` is `() => import('./cli/<verb>.ts')`. An unregistered verb
 * is a usage error, so no placeholder entry ever ships.
 */
export const VERBS: readonly VerbDefinition[] = [
  {
    name: 'checkpoint',
    summary: "Write the item's HANDOFF.md checkpoint in this worktree.",
    description:
      "Write .dork/flow/HANDOFF.md in the item's worktree, keeping the last one as HANDOFF.prev.md. The body file holds four ## sections: Done, Next, Open questions, Next command. flow measures the header (branch, commits, what is pushed) and records the checkpoint on the item's run.",
    common: ['project', 'session'],
    positionals: [
      { name: 'identifier', required: true, description: 'The work item, e.g. ACME-12.' },
    ],
    flags: [
      {
        name: 'trigger',
        kind: 'string',
        value: 'trigger',
        description:
          'Why it is written: stage, task, fix, limit-warning, limit-rejected, manual or synthesized.',
      },
      {
        name: 'body-file',
        kind: 'string',
        value: 'file',
        description: 'The body: Done, Next, Open questions, Next command. Relative to --project.',
      },
      {
        name: 'task',
        kind: 'string',
        value: 'id',
        description: 'The task this checkpoint follows. Required with --trigger task.',
      },
      {
        name: 'spec',
        kind: 'string',
        value: 'path',
        description: 'The spec the work follows, relative to the repository.',
      },
      {
        name: 'stage',
        kind: 'string',
        value: 'stage',
        description:
          "Where the next session resumes. Default: the run's stage; required when the item has no run.",
      },
    ],
    load: () => import('./cli/checkpoint.ts'),
  },
  {
    name: 'usage',
    summary: "Record each Claude Code account's usage, or set up the status line to.",
    description: [
      'Sub-verbs:',
      '  record              Read the status-line JSON on stdin and save the readings (the status line runs this).',
      '  scan                Recover past limit hits from saved conversations.',
      '  probe <id>          Run one short official turn on an account to read its usage (needs --yes).',
      "  install-statusline  Add the two recorder lines to each account's status-line script (needs --yes).",
    ].join('\n'),
    common: ['dry-run'],
    flags: [
      {
        name: 'account',
        kind: 'string',
        value: 'id',
        description: 'Only this account (record, scan, install-statusline).',
      },
      { name: 'verbose', kind: 'boolean', description: 'record: say on stderr what happened.' },
      {
        name: 'days',
        kind: 'string',
        value: 'n',
        description: 'scan: read files changed in the last n days. Default 8.',
      },
      { name: 'all', kind: 'boolean', description: 'scan: read every file.' },
      {
        name: 'yes',
        kind: 'boolean',
        description: 'probe, install-statusline: go ahead. Without it nothing runs or changes.',
      },
      {
        name: 'remove',
        kind: 'boolean',
        description: 'install-statusline: take the recorder lines out again.',
      },
      {
        name: 'model',
        kind: 'string',
        value: 'alias',
        description: 'probe: the model for the turn. Default haiku.',
      },
      {
        name: 'timeout',
        kind: 'string',
        value: 's',
        description: 'probe: give up after this many seconds. Default 90.',
      },
      {
        name: 'claude',
        kind: 'string',
        value: 'path',
        description: 'probe: the claude binary. Default FLOW_CLAUDE_BIN, else claude on PATH.',
      },
    ],
    positionals: [
      { name: 'sub-verb', description: 'record, scan, probe or install-statusline.' },
      { name: 'id', description: 'probe: the account id.' },
    ],
    load: () => import('./cli/usage.ts'),
  },
  {
    name: 'fleet',
    summary: 'Show every account and every running session on one screen. Changes nothing.',
    description: [
      "Show each account's 5-hour and weekly usage, and each running session with its",
      'account, item, state and host. Reads only; the one request it may make goes to',
      'a DorkOS on this machine.',
    ].join('\n'),
    common: ['project'],
    flags: [
      {
        name: 'dorkos-url',
        kind: 'string',
        value: 'url',
        description:
          'The DorkOS to ask. Default FLOW_DORKOS_URL, else http://127.0.0.1:<DORKOS_PORT or 4242>.',
      },
      { name: 'no-dorkos', kind: 'boolean', description: 'Do not ask DorkOS at all.' },
    ],
    load: () => import('./cli/fleet.ts'),
  },
];

/** The plugin folder, `<flow-root>`: the parent of `scripts/`. */
const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** {@link CliDeps} plus the entry's own seams, which tests override. */
export interface MainDeps extends CliDeps {
  /** The verb table. Default {@link VERBS}; tests register test-only verbs here. */
  verbs?: readonly VerbDefinition[];
  /** The plugin folder named in the install hint. Default: this file's `..`. */
  flowRoot?: string;
}

/** An exit code and the plain sentence printed with it. */
export interface ClassifiedError {
  /** The exit code the run ends with. */
  code: ExitCode;
  /** The message for stderr and the JSON envelope. */
  message: string;
}

/**
 * Whether an error is Node failing to find the `zod` package (or a subpath of
 * it), as opposed to any other missing module.
 */
function isMissingZod(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ERR_MODULE_NOT_FOUND' && /'zod(\/[^']*)?'/.test(error.message);
}

/**
 * The one place a thrown error becomes an exit code.
 *
 * - A missing `zod` is exit 6 with the install line.
 * - A typed error from `scripts/errors.ts` carries its own code (2, 3, 4, 5, 7).
 * - Anything else is a bug in flow: exit 70, labelled as an internal error.
 *
 * @param error - What was thrown.
 * @param flowRoot - The plugin folder, named in the install hint.
 * @returns The exit code and the message to print.
 */
export function classifyError(error: unknown, flowRoot: string): ClassifiedError {
  if (isMissingZod(error)) {
    return { code: EXIT.dependency, message: `run "npm install --omit=dev" in ${flowRoot}` };
  }
  if (error instanceof FlowError) return { code: error.exitCode, message: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { code: EXIT.internal, message: `internal error: ${message}` };
}

/**
 * Run one `flow` invocation.
 *
 * Never throws and never exits the process: every outcome, errors included, is
 * printed through the injected streams and returned as the exit code.
 *
 * @param argv - The arguments after the script path.
 * @param deps - The injected world (env, cwd, clock, streams, adapter factory,
 *   process runner) plus optional test seams.
 * @returns The exit code.
 */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const verbs = deps.verbs ?? VERBS;
  const flowRoot = deps.flowRoot ?? FLOW_ROOT;
  const output = new Output(wantsJson(argv), deps.stdout, deps.stderr);

  try {
    const location = locateVerb(argv);
    if (location === undefined) {
      if (!wantsHelp(argv)) throw new UsageError('no verb given; run "flow --help" for the list');
      output.help(renderTopHelp(verbs));
      return EXIT.ok;
    }

    const verb = verbs.find((candidate) => candidate.name === location.verb);
    if (verb === undefined) {
      throw new UsageError(`unknown verb "${location.verb}"; run "flow --help" for the list`);
    }
    if (wantsHelp(argv)) {
      output.help(renderVerbHelp(verb), verb.name);
      return EXIT.ok;
    }

    const args = parseVerbArgs(argv, location, verb);
    const module = await verb.load();
    const ctx = createVerbContext(args, deps, flowRoot, (message) => output.warn(message));
    const result = await module.run(ctx);
    output.result(result);
    return result.exitCode ?? EXIT.ok;
  } catch (error) {
    const { code, message } = classifyError(error, flowRoot);
    output.error(code, message);
    return code;
  }
}

/**
 * The adapter factory the script wires (spec §4). `tracker/load.ts` needs zod
 * (through config loading), so it is imported only when a verb asks for the
 * tracker; a missing install then exits 6 through {@link classifyError}.
 */
const createCodeAdapter: AdapterFactory = async (request) => {
  const load = await import('./tracker/load.ts');
  return load.createCodeAdapter(request);
};

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    stdout: process.stdout,
    stderr: process.stderr,
    createAdapter: createCodeAdapter,
    runProcess: realProcessRunner,
  });
}
