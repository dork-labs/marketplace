/**
 * `flow selftest` (spec `specs/flow-self-improvement` §1, DOR-2390): the verb
 * form of `scripts/selftest.ts`, running the same {@link runSelftest}.
 *
 * Exit codes are the self-test's: 0 no failures, 1 a check failed (or, with
 * `--strict`, was skipped), 2 a usage error. `--file` uses the project's own
 * tracker adapter, the one every other verb uses.
 *
 * @module @dorkos/flow/cli/selftest
 */

import { UsageError } from '../errors.ts';
import { renderText } from '../selftest/report.ts';
import { runSelftest, tiersFor, writeRebaseline } from '../selftest.ts';
import type { VerbContext, VerbResult } from './context.ts';

/**
 * Run `flow selftest`.
 *
 * @param ctx - The verb's context.
 * @returns The report (as JSON, or the text report); exit 1 on a failure.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const { flags } = ctx.args;
  if (flags.rebaseline === true) {
    const { file, count } = writeRebaseline(ctx.flowRoot);
    return { json: { ok: true, file, count }, text: `Wrote ${file} (${count} files).` };
  }
  const tiers = tiersFor(typeof flags.tier === 'string' ? flags.tier : undefined);
  if (typeof tiers === 'string') throw new UsageError(tiers);

  const { report, code } = await runSelftest({
    flowRoot: ctx.flowRoot,
    projectDir: ctx.projectDir,
    env: { ...ctx.env },
    now: () => ctx.now(),
    tiers,
    strict: flags.strict === true,
    save: flags['no-save'] !== true,
    file: flags.file === true,
    adapter: () => ctx.adapter(),
    sessionId: ctx.sessionId,
    warn: (message) => ctx.warn(message),
  });
  return {
    exitCode: code,
    json: report as unknown as Record<string, unknown>,
    text: renderText(report),
  };
}
