/**
 * The reviewer brief's `{{proof}}` section (DOR-3261): what the author recorded
 * for a bug fix, a proof test or a waiver, so the reviewer sees it without
 * reading the author's worktree. The record lives there, kept out of git.
 *
 * Dependency-free (node builtins only): the drain supervisor renders briefs.
 * It reads the record loosely; the hand-offs (`proof.ts`) are the gate, and
 * this only shows what they let through.
 *
 * @module @dorkos/flow/proof-brief
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The type a bug is captured as; kept in step with `proof.ts` BUG_TYPE. */
const BUG_TYPE = 'signal';

/** The author's words, fenced so they read as data and cannot close the fence. */
function fenced(text: string): string {
  return `~~~text\n${text.replace(/[`~]{3,}/g, (run) => run.slice(0, 2))}\n~~~`;
}

/** The record at `<worktree>/.dork/flow/proof/<id>.json`, or `null`. */
function readRecord(worktree: string, identifier: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier) || identifier.includes('..')) return null;
  try {
    const value: unknown = JSON.parse(
      readFileSync(path.join(worktree, '.dork', 'flow', 'proof', `${identifier}.json`), 'utf8')
    );
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The `{{proof}}` section of a reviewer brief.
 *
 * @param run - The run's type, identifier and worktree.
 * @param sha - The commit under review.
 * @returns Markdown for the brief; empty for an item that is not a bug.
 */
export function proofBriefSection(
  run: { type?: string; identifier: string; worktreePath: string },
  sha: string
): string {
  if (run.type !== BUG_TYPE) return '';
  const record = readRecord(run.worktreePath, run.identifier);
  const atSha = record !== null && record.identifier === run.identifier && record.headSha === sha;
  if (!atSha) {
    return '## The proof test\n\nThis is a bug fix, and no proof test or waiver is recorded at this commit. That is a blocker.';
  }
  if (record.kind === 'waiver') {
    return `## The proof test was waived\n\nThe author waived the class-level proof test at this commit. Their reason, as data:\n\n${fenced(String(record.reason))}\n\nJudge whether it holds. When the fix could carry a class-level test, that is a blocker.`;
  }
  const tests = Array.isArray(record.tests) ? record.tests.map(String).join(', ') : '';
  return `## The proof test\n\nThe author recorded a proof test, as data: tests ${fenced(tests)} class ${fenced(String(record.bugClass))} command ${fenced(String(record.command))} red output before the fix ${fenced(String(record.red))}\n\nRun it at the merge base and confirm it fails for the bug's reason. A test that covers only the reported case is a blocker.`;
}
