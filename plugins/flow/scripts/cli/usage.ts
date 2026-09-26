/**
 * The `flow usage` verb (spec `flow-usage` §2, `flow-cli-core` §6): one
 * dispatcher for its five sub-verbs. Each sub-verb lives in its own module and is loaded with
 * `import()`, so `usage record` (run by the status line) never loads the scan,
 * probe or install code.
 *
 * @module @dorkos/flow/cli/usage
 */

import { UsageError } from '../errors.ts';
import type { VerbContext, VerbModule, VerbResult } from './context.ts';
import { parseRuntime, runtimeHandler } from './usage-runtime.ts';

/**
 * Each sub-verb, the flags it takes, and how to load it. `record` and `scan`
 * pick their module by `--runtime` ({@link runtimeHandler}).
 */
const SUB_VERBS: Readonly<
  Record<
    string,
    {
      flags: readonly string[];
      takesId: boolean;
      load(ctx: VerbContext): Promise<VerbModule>;
    }
  >
> = {
  record: {
    flags: ['account', 'verbose', 'runtime'],
    takesId: false,
    load: (ctx) => runtimeHandler('record', parseRuntime(ctx.args.flags.runtime))(),
  },
  scan: {
    flags: ['account', 'days', 'all', 'dry-run', 'runtime'],
    takesId: false,
    load: (ctx) => runtimeHandler('scan', parseRuntime(ctx.args.flags.runtime))(),
  },
  probe: {
    flags: ['model', 'timeout', 'claude', 'yes'],
    takesId: true,
    load: () => import('./usage-probe.ts'),
  },
  'install-statusline': {
    flags: ['account', 'yes', 'remove'],
    takesId: false,
    load: () => import('./usage-install.ts'),
  },
  prune: {
    flags: ['yes', 'dry-run'],
    takesId: false,
    load: () => import('./usage-prune.ts'),
  },
  snapshot: {
    flags: [],
    takesId: false,
    load: () => import('./usage-snapshot.ts'),
  },
};

/** The sub-verb list, for usage errors. */
const LIST =
  'flow usage record | scan | probe <id> | install-statusline | prune | snapshot; run "flow usage --help" for details';

/**
 * Dispatch to the sub-verb named by the first positional, after checking it
 * takes every flag and argument it was given.
 *
 * @param ctx - The verb context.
 * @returns The sub-verb's result.
 * @throws {UsageError} For a missing or unknown sub-verb, an unknown or unbuilt
 *   `--runtime`, a flag it does not take, or a missing or extra `<id>`.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [sub, id] = ctx.args.positionals;
  if (sub === undefined) throw new UsageError(`a sub-verb is needed: ${LIST}`);
  const entry = SUB_VERBS[sub];
  if (entry === undefined) throw new UsageError(`unknown sub-verb "${sub}": ${LIST}`);
  for (const flag of Object.keys(ctx.args.flags)) {
    if (!entry.flags.includes(flag)) {
      throw new UsageError(`"flow usage ${sub}" does not take --${flag}`);
    }
  }
  if (entry.takesId && id === undefined) {
    throw new UsageError(`missing <id> for "flow usage ${sub}"`);
  }
  if (!entry.takesId && id !== undefined) {
    throw new UsageError(`unexpected argument "${id}" for "flow usage ${sub}"`);
  }
  const module = await entry.load(ctx);
  return module.run(ctx);
}
