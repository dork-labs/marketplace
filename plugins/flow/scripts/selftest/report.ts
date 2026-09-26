/**
 * The self-test report: the record every check returns, the report a run
 * produces, how it renders, and what exit code it maps to (spec
 * `specs/flow-self-improvement/02-specification.md` §1, "Report and --file").
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/selftest/report
 */

import { createHash } from 'node:crypto';

import { renderFiling, type FilingResult } from './file.ts';

/** The self-test tiers. `live` runs a real model: opt-in, paid, never in CI. */
export type Tier = 'fast' | 'scenarios' | 'live';

/** A check's outcome. A `skip` is never a pass. */
export type CheckStatus = 'pass' | 'fail' | 'skip';

/** One check's result. */
export interface Check {
  /** The check id, for example `config` or `doc-lint/words`. */
  id: string;
  /** The tier it belongs to. */
  tier: Tier;
  /** What happened. */
  status: CheckStatus;
  /** How long it took, in milliseconds. */
  ms: number;
  /** One line a person can act on: what failed and what to do, or why it was skipped. */
  detail: string;
  /** A stable 12-hex-character id for this exact problem (see {@link fingerprint}). */
  fingerprint: string;
  /** A live case's reported spend, in US dollars. */
  costUsd?: number;
  /** A live case's turns. */
  turns?: number;
}

/** Totals over a report's checks. */
export interface Totals {
  /** Checks that passed. */
  pass: number;
  /** Checks that failed. */
  fail: number;
  /** Checks that were skipped. */
  skip: number;
  /** Wall time of the whole run, in milliseconds. */
  ms: number;
}

/** A whole self-test run, as `--json` prints it and `latest.json` stores it. */
export interface SelftestReport {
  /** Report format version. */
  v: 1;
  /** `true` when nothing failed. */
  ok: boolean;
  /** When the run started (ISO-8601, UTC). */
  startedAt: string;
  /** The flow plugin version that ran. */
  flowVersion: string;
  /** The tiers that ran. */
  tiers: Tier[];
  /** Every check, in run order. */
  checks: Check[];
  /** The totals. */
  totals: Totals;
  /** What `--file` did, when it was asked for. */
  filing?: FilingResult;
  /** Which credential paid for the live tier (`none` when none answered); absent when it did not run. */
  credentialSource?: string;
}

/**
 * A stable id for one problem: the first 12 hex characters of
 * `sha1(checkId + ":" + stableKey)`. The key must leave out counts and times so
 * the same problem keeps its id from run to run (for a word budget, the file path).
 *
 * @param checkId - The check id.
 * @param stableKey - What identifies the problem within the check.
 * @returns 12 lowercase hex characters.
 */
export function fingerprint(checkId: string, stableKey: string): string {
  return createHash('sha1').update(`${checkId}:${stableKey}`).digest('hex').slice(0, 12);
}

/**
 * Assemble a report from finished checks.
 *
 * @param checks - The checks, in run order.
 * @param meta - When the run started, what version ran, which tiers, and the wall time.
 * @returns The report.
 */
export function buildReport(
  checks: readonly Check[],
  meta: {
    startedAt: string;
    flowVersion: string;
    tiers: Tier[];
    ms: number;
    credentialSource?: string;
  }
): SelftestReport {
  const totals: Totals = { pass: 0, fail: 0, skip: 0, ms: meta.ms };
  for (const check of checks) totals[check.status] += 1;
  return {
    v: 1,
    ok: totals.fail === 0,
    startedAt: meta.startedAt,
    flowVersion: meta.flowVersion,
    tiers: meta.tiers,
    checks: [...checks],
    totals,
    ...(meta.credentialSource !== undefined ? { credentialSource: meta.credentialSource } : {}),
  };
}

/**
 * The exit code a report maps to: 1 when anything failed, or when `strict` and
 * anything was skipped; otherwise 0.
 *
 * @param report - The report.
 * @param options - `strict` turns a skip into a failure.
 * @returns 0 or 1.
 */
export function exitCode(report: SelftestReport, options: { strict: boolean }): 0 | 1 {
  if (report.totals.fail > 0) return 1;
  if (options.strict && report.totals.skip > 0) return 1;
  return 0;
}

/**
 * Render a report as plain text: failures first, then skips with their reasons,
 * then a count of passes and the totals line.
 *
 * @param report - The report.
 * @returns The text, ending in a newline.
 */
export function renderText(report: SelftestReport): string {
  const lines: string[] = [
    `flow selftest (${report.tiers.join(', ')}), flow ${report.flowVersion}`,
  ];
  const failed = report.checks.filter((c) => c.status === 'fail');
  const skipped = report.checks.filter((c) => c.status === 'skip');
  const passed = report.checks.filter((c) => c.status === 'pass');
  if (failed.length > 0) {
    lines.push('', 'Failed:');
    for (const c of failed) lines.push(`  FAIL  ${c.id}: ${c.detail}`);
  }
  if (skipped.length > 0) {
    lines.push('', 'Skipped (not passed):');
    for (const c of skipped) lines.push(`  SKIP  ${c.id}: ${c.detail}`);
  }
  if (passed.length > 0) {
    lines.push('', 'Passed:');
    for (const c of passed) lines.push(`  ok    ${c.id}${c.detail === '' ? '' : `: ${c.detail}`}`);
  }
  if (report.filing !== undefined) lines.push(...renderFiling(report.filing));
  if (report.credentialSource !== undefined) {
    const spent = report.checks.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
    lines.push('', `Live tier: $${spent.toFixed(4)} spent, paid by ${report.credentialSource}`);
  }
  const { pass, fail, skip, ms } = report.totals;
  lines.push('', `${pass} passed, ${fail} failed, ${skip} skipped in ${(ms / 1000).toFixed(1)}s`);
  return `${lines.join('\n')}\n`;
}
