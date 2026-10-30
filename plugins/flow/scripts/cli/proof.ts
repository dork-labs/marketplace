/**
 * `flow proof <identifier> --tests <paths> --class <text> --command <cmd>
 * --red-file <f> --green-file <f> [--base <ref>]` (DOR-3261): record the
 * class-level test a bug fix ships.
 *
 * flow checks what it can measure (every test is committed and changed on the
 * branch since its merge base, both runs' output is there and differs) and
 * records the rest as given, at HEAD, in `.dork/flow/proof/<identifier>.json`.
 * `flow stage <id> review` refuses a bug item without a record at the head.
 *
 * @module @dorkos/flow/cli/proof
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { UsageError, PreconditionError } from '../errors.ts';
import { addExcludeLines } from '../git-exclude.ts';
import {
  DEFAULT_BASE,
  PROOF_EXCLUDE_LINE,
  measureProof,
  outputTail,
  proofPath,
  unchangedTests,
  type ProofRecord,
} from '../proof.ts';
import type { VerbContext, VerbResult } from './context.ts';

/** A required, non-blank string flag. */
function required(ctx: VerbContext, name: string, what: string): string {
  const value = ctx.args.flags[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${name} is required: ${what}`);
  }
  return value.trim();
}

/** A run's output file, read whole; empty output proves nothing. */
function readOutput(ctx: VerbContext, name: string, file: string): string {
  let text: string;
  try {
    text = readFileSync(path.resolve(ctx.projectDir, file), 'utf8');
  } catch {
    throw new UsageError(`cannot read --${name} ${file}`);
  }
  const tail = outputTail(text);
  if (tail === '') throw new PreconditionError(`--${name} ${file} is empty: save the run's output`);
  return tail;
}

/**
 * Run `flow proof`.
 *
 * @param ctx - The verb context.
 * @returns The record written (or that would be, with `--dry-run`).
 * @throws {UsageError} On a missing flag or unreadable file (exit 2).
 * @throws {PreconditionError} When a test is not changed on the branch, or the runs' output is empty or identical (exit 5).
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const identifier = ctx.args.positionals[0];
  const tests = required(ctx, 'tests', 'the proof test files, comma-separated')
    .split(',')
    .map((test) => test.trim())
    .filter((test) => test !== '');
  const bugClass = required(ctx, 'class', 'the class of bug the test covers, in one sentence');
  const command = required(ctx, 'command', 'the command that runs the proof test');
  const red = readOutput(ctx, 'red-file', required(ctx, 'red-file', 'its output before the fix'));
  const green = readOutput(
    ctx,
    'green-file',
    required(ctx, 'green-file', 'its output after the fix')
  );
  if (red === green) {
    throw new PreconditionError(
      'the red and green output are the same: run the test once on the code before the fix and once at the head'
    );
  }
  const baseFlag = ctx.args.flags.base;
  const base = typeof baseFlag === 'string' && baseFlag !== '' ? baseFlag : DEFAULT_BASE;

  const facts = await measureProof(ctx, base);
  const file = proofPath(facts.root, identifier);
  const missing = unchangedTests(tests, facts.changed);
  if (missing.length > 0) {
    throw new PreconditionError(
      `not changed on this branch since ${facts.baseSha.slice(0, 7)}: ${missing.join(', ')}. A proof test is new or changed, and committed; paths are relative to the repository root`
    );
  }

  const record: ProofRecord = {
    v: 1,
    identifier,
    headSha: facts.headSha,
    baseSha: facts.baseSha,
    tests,
    bugClass,
    command,
    red,
    green,
    recordedAt: ctx.now().toISOString(),
  };
  if (!ctx.dryRun) {
    addExcludeLines(facts.root, [PROOF_EXCLUDE_LINE]);
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, file);
  }
  const verb = ctx.dryRun ? 'Would record' : 'Recorded';
  return {
    json: { ok: true, dryRun: ctx.dryRun, path: file, record },
    text: `${verb} the proof for ${identifier} at ${facts.headSha.slice(0, 7)}: ${tests.join(', ')}.`,
  };
}
