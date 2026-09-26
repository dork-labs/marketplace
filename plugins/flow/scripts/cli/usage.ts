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

/** Each sub-verb, the flags it takes, and how to load it. */
const SUB_VERBS: Readonly<
  Record<string, { flags: readonly string[]; takesId: boolean; load(): Promise<VerbModule> }>
> = {
  record: {
    flags: ['account', 'verbose'],
    takesId: false,
    load: () => import('./usage-record.ts'),
  },
  scan: {
    flags: ['account', 'days', 'all', 'dry-run'],
    takesId: false,
    load: () => import('./usage-scan.ts'),
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
    flags: ['dry-run'],
    takesId: false,
    load: () => import('./usage-prune.ts'),
  },
};

/** The sub-verb list, for usage errors. */
const LIST =
  'flow usage record | scan | probe <id> | install-statusline | prune; run "flow usage --help" for details';

/**
 * Dispatch to the sub-verb named by the first positional, after checking it
 * takes every flag and argument it was given.
 *
 * @param ctx - The verb context.
 * @returns The sub-verb's result.
 * @throws {UsageError} For a missing or unknown sub-verb, a flag it does not
 *   take, or a missing or extra `<id>`.
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
  const module = await entry.load();
  return module.run(ctx);
}
