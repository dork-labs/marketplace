/**
 * `flow usage prune` (spec `flow-cli-core` §6, §1.2 "Removing an account"):
 * delete the usage files of accounts that are no longer registered.
 *
 * For each runtime it lists `<dorkHome>/runtimes/<runtime>/usage/<id>.json` and
 * removes every file whose id is not a registered account of that runtime.
 * `default.json` is never removed: it belongs to the runtime's implicit account,
 * which comes back whenever the runtime's registry is empty. Nothing is removed
 * when `config.json` cannot be read in full, since then every account would look
 * unregistered. Each removal takes the file's lock, so a writer merging at that
 * moment finishes first or starts after.
 *
 * Dependency-free: node builtins and local zero-dependency modules only.
 *
 * @module @dorkos/flow/cli/usage-prune
 */

import { ConfigError } from '../errors.ts';
import { loadAccounts, resolveDorkHome } from '../fleet/accounts.ts';
import {
  RUNTIMES,
  ledgerPath,
  listLedgerIds,
  pruneTargets,
  removeLedger,
  type RuntimeSlug,
} from '../fleet/usage-ledger.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** One usage file `prune` removed or, on a dry run, would remove. */
interface PrunedFile {
  runtime: RuntimeSlug;
  accountId: string;
  file: string;
  status: 'removed' | 'missing' | 'dropped' | 'planned';
}

/**
 * Run `flow usage prune`.
 *
 * @param ctx - The verb context.
 * @returns What was removed (or would be, with `--dry-run`).
 * @throws {ConfigError} When `config.json` cannot be read in full (exit 3).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const dorkHome = resolveDorkHome({ ...ctx.env }, ctx.io.osHome);
  const registry = loadAccounts(dorkHome);
  if (!registry.registryReadable) {
    throw new ConfigError(
      `${dorkHome}/config.json could not be read in full, so every account would look unregistered; nothing was removed. Fix the file, then retry.`
    );
  }
  const registered = {} as Record<RuntimeSlug, string[]>;
  const onDisk = {} as Record<RuntimeSlug, string[]>;
  for (const runtime of RUNTIMES) {
    registered[runtime] = registry.accounts.filter((a) => a.runtime === runtime).map((a) => a.id);
    onDisk[runtime] = listLedgerIds(dorkHome, runtime);
  }
  const targets = pruneTargets(registered, onDisk);

  const files: PrunedFile[] = [];
  for (const runtime of RUNTIMES) {
    for (const accountId of targets[runtime]) {
      const file = ledgerPath(dorkHome, runtime, accountId);
      if (ctx.dryRun) {
        files.push({ runtime, accountId, file, status: 'planned' });
        continue;
      }
      const result = await removeLedger(dorkHome, runtime, accountId);
      for (const warning of result.warnings) ctx.warn(warning.message);
      files.push({ runtime, accountId, file, status: result.status });
    }
  }

  const lines =
    files.length === 0
      ? ['Every usage file belongs to a registered account; nothing to remove.']
      : files.map((entry) => {
          const verb =
            entry.status === 'planned'
              ? 'Would remove'
              : entry.status === 'dropped'
                ? 'Could not remove (locked, retry)'
                : 'Removed';
          return `${verb} ${entry.file} (${entry.runtime}:${entry.accountId} is not registered).`;
        });
  return {
    json: { ok: true, dryRun: ctx.dryRun, dorkHome, files },
    text: lines.join('\n'),
  };
}
