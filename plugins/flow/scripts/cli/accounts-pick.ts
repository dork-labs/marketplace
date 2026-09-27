/**
 * `flow accounts pick`: which account a new piece of work should start on, with
 * no tracker item. The same ranking `flow next` and `flow drain` use
 * (`rankAccounts` through {@link assignAccounts}): scope, room on the 5-hour,
 * weekly and model windows, the reserve, capacity, then the headroom that
 * expires soonest, with the main account last. For a controller outside flow
 * (cmux-control, a person at a terminal) choosing where to start a session.
 *
 * A folder with no flow config ranks with the settings' defaults.
 *
 * @module flow/cli/accounts-pick
 */

import { ConfigError, UsageError } from '../errors.ts';
import { RUNTIMES, type RuntimeSlug } from '../fleet/usage-ledger.ts';
import type { WorkItem } from '../tracker/types.ts';
import { loadProjectConfig } from './backlog.ts';
import type { VerbContext, VerbResult } from './context.ts';
import {
  accountSuffix,
  assignAccounts,
  gatherAssignmentInput,
  noAccountMessage,
  type NextConfig,
} from './next.ts';

/** A stand-in item: the ranking needs one, and it matches no run. */
const NO_ITEM = { id: '\u0000accounts-pick', identifier: 'new work' } as WorkItem;

/** The project's config, or the settings' defaults when the folder has none. */
async function configFor(ctx: VerbContext): Promise<NextConfig> {
  try {
    return loadProjectConfig(ctx).loaded.config;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    const { FlowConfigSchema } = await import('../config-schema.ts');
    return FlowConfigSchema.parse({}) as NextConfig;
  }
}

/** A string flag, or undefined. */
function stringFlag(ctx: VerbContext, name: string): string | undefined {
  const value = ctx.args.flags[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Run `flow accounts pick [--repo owner/name] [--runtime r] [--model m]`.
 *
 * @param ctx - The invocation and the injected world.
 * @returns The pick (or none, with every account's reasons) and the ranking.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const runtime = stringFlag(ctx, 'runtime');
  if (runtime !== undefined && !(RUNTIMES as readonly string[]).includes(runtime)) {
    throw new UsageError(`--runtime must be one of ${RUNTIMES.join(', ')}, not "${runtime}"`);
  }
  const repo = stringFlag(ctx, 'repo');
  if (repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new UsageError(`--repo must be owner/name, not "${repo}"`);
  }
  const config = await configFor(ctx);
  const input = await gatherAssignmentInput(ctx, config);
  const model = stringFlag(ctx, 'model');
  const [account] = assignAccounts([NO_ITEM], {
    ...input,
    ...(repo === undefined ? {} : { repo }),
    ...(model === undefined ? {} : { model }),
    ...(runtime === undefined ? {} : { runtimes: [runtime as RuntimeSlug] }),
  });
  const resolvedRepo = repo ?? input.repo;
  const path =
    account.pick === null
      ? null
      : (input.accounts.find(
          (a) => a.runtime === account.pick?.runtime && a.id === account.pick?.id
        )?.path ?? null);
  const text =
    account.pick === null
      ? noAccountMessage(resolvedRepo, account)
      : `Start new work on${accountSuffix(account).replace(' ->', '')} (${account.pick.runtime}:${account.pick.id}${path === null ? '' : `, ${path}`}).`;
  return {
    text,
    json: {
      v: 1,
      repo: resolvedRepo,
      runtime: account.runtime,
      pick: account.pick === null ? null : { ...account.pick, label: account.label, path },
      reason: account.reason,
      ranked: account.ranked,
      ineligible: account.ineligible,
    },
  };
}
