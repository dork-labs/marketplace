/**
 * CLI wrapper over the crash & stall recovery oracle (§12) — the `/flow` engine's
 * next-tick recovery ladder. Reads the orphan signal, the durable {@link FlowRun}
 * record (or `null`), the probe context, and the resolved recovery config from
 * stdin (or `--input <path>`), then emits the {@link RecoveryAction} the runtime
 * should take (skip / resume / restart-clean / block / escalate / abandon /
 * re-derive). Once retries run out, `recovery.onExhausted` picks among `block`,
 * `escalate` and `abandon`; an absent value is the schema default, `block`, and
 * any other value is invalid input (exit 1).
 *
 * A run with `drain` set (a `flow drain` run) is always `skip` with reason
 * `drain-run`: its supervisor is its only recovery.
 *
 * Zero-runtime-dep: the oracle's imports are all `import type`, so this bundles
 * to a dependency-free `.mjs`. A `claimed-no-worker` (or `needs-input`) signal
 * with a `null` run is an oracle invariant violation (exit 2) — those signals are
 * only defined for an item that has a local run record.
 *
 * @module @dorkos/flow-engine/cli/recovery
 */

import { recoverOrphan } from './flow-run.ts';
import type { FlowRun, OrphanSignal, RecoveryConfig, RecoveryContext } from './flow-run.ts';
import { invokedDirectly, isPlainObject, parseArgs, readRawInput } from './_shared.ts';

/**
 * The `recovery.onExhausted` values, mirroring `OnExhaustedSchema` in
 * `config-schema.ts` (kept as a literal: this CLI must not load zod).
 */
export const ON_EXHAUSTED: readonly RecoveryConfig['onExhausted'][] = [
  'block',
  'escalate',
  'abandon',
];

/** The stdin/`--input` payload shape for the recovery script. */
interface RecoveryInput {
  /** The orphan disposition that triggered the sweep. */
  signal: OrphanSignal;
  /** The durable run record, or `null` for the `no-local-record` signal. */
  run: FlowRun | null;
  /** The probe facts the runtime gathered (`worktreeExists`, `sessionLogIntact`). */
  ctx: RecoveryContext;
  /** The resolved recovery config (`maxRetries` / `onExhausted` / `staleAfter`). */
  recovery: RecoveryConfig;
}

const HELP = `recovery — the /flow next-tick recovery ladder (§12): adopt or restart an orphaned run.

Reads JSON from stdin (or --input <path>):
  {
    "signal":   "needs-input" | "claimed-no-worker" | "no-local-record",
    "run":      FlowRun | null,        // null for the "no-local-record" signal
    "ctx":      { "worktreeExists": boolean, "sessionLogIntact": boolean },
    "recovery": RecoveryConfig          // { "maxRetries", "onExhausted", "staleAfter" }
  }

Writes the RecoveryAction as JSON to stdout (discriminated union over "kind"):
  { "kind": "skip"|"resume"|"restart-clean"|"block"|"escalate"|"abandon"|"re-derive", … }
Once retries run out, "recovery.onExhausted" picks the kind:
  "block" (default)  { "kind": "block", "label": "agent/blocked", "reason" }
                     apply the label, comment, nudge; nothing retries it.
  "escalate"         { "kind": "escalate", "label": "agent/needs-input", "reason", "question" }
                     the adapter's needsInput(item, question), not flow ask;
                     a person's reply resumes it.
  "abandon"          { "kind": "abandon", "releaseTo": "none", "reason" }
                     flow release <id> --to none --reason <reason>.
A run with "drain" set is always { "kind": "skip", "reason": "drain-run" }:
  flow drain's supervisor is its only recovery.

Exit codes: 0 ok | 1 invalid input (incl. an unknown onExhausted) | 2 oracle invariant violation
  (a "claimed-no-worker"/"needs-input" signal with run: null trips the invariant -> exit 2).
`;

/**
 * Run the recovery CLI: parse args, read + structurally validate the JSON
 * payload, evaluate the recovery ladder via {@link recoverOrphan}, and write the
 * resolved action JSON to stdout.
 *
 * @param argv - Process args after node + script (`process.argv.slice(2)`).
 * @returns The exit code: 0 ok, 1 invalid input, 2 oracle invariant violation.
 */
export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readRawInput(args.inputPath));
  } catch (err) {
    process.stderr.write(`recovery: invalid input — ${(err as Error).message}\n`);
    return 1;
  }

  if (
    !isPlainObject(parsed) ||
    typeof parsed.signal !== 'string' ||
    !isPlainObject(parsed.ctx) ||
    !isPlainObject(parsed.recovery)
  ) {
    process.stderr.write(
      'recovery: invalid input — expected { signal: string, run: FlowRun|null, ctx: {…}, recovery: {…} }\n'
    );
    return 1;
  }

  const onExhausted = parsed.recovery.onExhausted ?? 'block';
  if (!ON_EXHAUSTED.includes(onExhausted as RecoveryConfig['onExhausted'])) {
    process.stderr.write(
      `recovery: invalid input — recovery.onExhausted must be one of ${ON_EXHAUSTED.join(', ')}, got ${JSON.stringify(onExhausted)}\n`
    );
    return 1;
  }

  const { signal, run, ctx } = parsed as unknown as RecoveryInput;
  const recovery = {
    ...(parsed.recovery as unknown as RecoveryConfig),
    onExhausted: onExhausted as RecoveryConfig['onExhausted'],
  };

  try {
    const action = recoverOrphan(signal, run ?? null, ctx, recovery);
    process.stdout.write(`${JSON.stringify(action)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`recovery: oracle invariant violation — ${(err as Error).message}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
