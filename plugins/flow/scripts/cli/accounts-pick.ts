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

import path from 'node:path';

import { findConfigRoots, refusalFor, resolveConfigFiles } from '../config-files.ts';
import { UsageError } from '../errors.ts';
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

/**
 * The project's config, or the settings' defaults when the folder has no flow
 * config of its own. Only that falls back: a project config that is broken,
 * or a folder flow must not act in, still fails (exit 3), so a pick is never
 * ranked with settings nobody chose.
 *
 * Settings left inside a shared plugin folder (the pre-0.9 place) are not this
 * folder's either: a controller outside flow, run from any folder, would
 * otherwise be refused by another project's leftovers. Those are ignored, with
 * a warning, and the defaults apply.
 */
async function configFor(ctx: VerbContext): Promise<NextConfig> {
  const roots = findConfigRoots(ctx.projectDir, ctx.flowRoot);
  if (refusalFor(roots) === null) {
    const files = resolveConfigFiles(roots);
    const sharedLegacy = files.origin === 'legacy' && files.shared;
    if (files.origin === 'none' || sharedLegacy) {
      if (sharedLegacy) {
        ctx.warn(
          `ignored the settings in ${path.dirname(files.committed ?? '')}: they sit in a plugin folder other projects may share, not in this folder; ranking with the defaults`
        );
      }
      const { FlowConfigSchema } = await import('../config-schema.ts');
      return FlowConfigSchema.parse({}) as NextConfig;
    }
  }
  return loadProjectConfig(ctx).loaded.config;
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
  // --runtime names the work's own runtime: it ranks first, and the operator's
  // fleet.runtimes order still decides any cross-runtime fallback. A model
  // binding is a Claude Code one, so another runtime ranks with no model unless
  // --model names one.
  const runtimes =
    runtime === undefined
      ? input.runtimes
      : [runtime as RuntimeSlug, ...input.runtimes.filter((r) => r !== runtime)];
  const [account] = assignAccounts([NO_ITEM], {
    ...input,
    runtimes,
    ...(repo === undefined ? {} : { repo }),
    model: model ?? (runtime !== undefined && runtime !== 'claude-code' ? null : input.model),
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
