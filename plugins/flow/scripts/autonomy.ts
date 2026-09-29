/**
 * How much flow does on its own in a project (spec `flow-multiproject` §7.7):
 * one dial per project with three stops, **Ask me first** (`ask`), **Tell me
 * after** (`tell`) and **Just do it** (`auto`), set per kind of ask.
 *
 * | Kind        | What it decides                                        |
 * | ----------- | ------------------------------------------------------ |
 * | `ship`      | who answers the review gate: you, or the reviewer agent |
 * | `questions` | who answers an agent's question: you, or its own pick   |
 * | `sort`      | whether new ideas are sorted every morning on their own |
 * | `retry`     | whether failing checks are fixed without asking         |
 *
 * **Where the dial lives.** Not in the repo: the dial decides who checks the
 * agents, and any agent working in a checkout can write the checkout's files.
 * DorkOS keeps it in its per-project settings for flow, written only by a
 * person. The CLI cannot reach DorkOS's storage, so the Flow extension writes a
 * read-only copy to `<dorkHome>/flow/autonomy/<projectId>.json`
 * ({@link autonomyCopyPath}) and this module reads it. No flow code writes the
 * copy but the extension, and nothing here writes it at all.
 *
 * **A missing or unreadable copy reads as `ask` for every kind**, so a broken
 * copy only ever makes flow ask more. One exception keeps an install without the
 * dial working exactly as before: with no copy at all (DorkOS never wrote one,
 * as on a terminal-only install), "Retry and fix problems" follows the
 * committed `recovery` settings as it always has ({@link stopInForce}).
 *
 * Whatever the stop, someone checks (charter G12): at `auto` the check moves to
 * the reviewer agent or a safe default, never to nobody. See `calibration.ts`
 * (`answeredBy`) for the questions half of that rule.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/autonomy
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
export {
  AUTONOMY_KINDS,
  AUTONOMY_STOPS,
  DEFAULT_QUESTION_DEADLINE_MINUTES,
  MAX_QUESTION_DEADLINE_MINUTES,
  MIN_QUESTION_DEADLINE_MINUTES,
  parseAutonomyCopy,
  resolveAutonomy,
  type AutonomyContext,
  type AutonomyCopy,
  type AutonomyKind,
  type AutonomyStop,
} from './autonomy-dial.ts';
import {
  parseAutonomyCopy,
  resolveAutonomy,
  type AutonomyContext,
  type AutonomyCopy,
  type AutonomyKind,
  type AutonomyStop,
} from './autonomy-dial.ts';

/** What reading the copy found. */
export type AutonomyRead =
  | { state: 'missing'; file: string }
  | { state: 'unreadable'; file: string }
  | { state: 'ok'; file: string; copy: AutonomyCopy };

/**
 * The project id the copy's file is named by: the first 12 hex characters of
 * the SHA-256 of the project's canonical root (see `canonicalProjectRoot` in
 * `main-checkout.ts`). The same id names the project in the Flow extension's
 * cache and inbox keys, so a path never appears in a key.
 *
 * @param root - The project's canonical root.
 * @returns The id.
 */
export function projectId(root: string): string {
  return createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Where the copy of a project's dial lives.
 *
 * @param dorkHome - The DorkOS home (`DORK_HOME`, else `~/.dork`).
 * @param root - The project's canonical root.
 * @returns `<dorkHome>/flow/autonomy/<projectId>.json`.
 */
export function autonomyCopyPath(dorkHome: string, root: string): string {
  return path.join(dorkHome, 'flow', 'autonomy', `${projectId(root)}.json`);
}

/**
 * Read the copy of a project's dial.
 *
 * @param file - The copy's path ({@link autonomyCopyPath}).
 * @returns `missing` when there is no file, `unreadable` when it is not a dial,
 *   else the dial.
 */
export function readAutonomyCopy(file: string): AutonomyRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing', file }
      : { state: 'unreadable', file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable', file };
  }
  const copy = parseAutonomyCopy(parsed);
  return copy === null ? { state: 'unreadable', file } : { state: 'ok', file, copy };
}

/**
 * The stop flow acts on for one kind, from what reading the copy found: the
 * resolver's answer, except that with no copy at all "Retry and fix problems"
 * stays as it always was (the committed `recovery` settings, which fix failing
 * checks on their own), so an install that never chose a dial behaves as before.
 * An unreadable copy still reads as `ask`.
 *
 * @param read - What reading the copy found.
 * @param kind - The kind of ask.
 * @param context - Facts about the project.
 * @returns The stop in force.
 */
export function stopInForce(
  read: AutonomyRead,
  kind: AutonomyKind,
  context: AutonomyContext = {}
): AutonomyStop {
  if (read.state === 'missing' && kind === 'retry') return 'tell';
  return resolveAutonomy(read.state === 'ok' ? read.copy : null, kind, context);
}

/** The parts of the config the dial changes when it is read. */
export interface AutonomyTunables {
  /** `recovery`: how often a failing step is retried, and what happens after. */
  recovery: { maxRetries: number; onExhausted: 'block' | 'escalate' | 'abandon' };
  /** `involvement.calibration.stageBias`: how the ambiguous middle is routed. */
  stageBias: { intake: 'ask' | 'proceed-and-log'; execution: 'ask' | 'proceed-and-log' };
}

/**
 * The config as the dial reads it (spec §7.7): the stop is applied at read
 * time and never written back, so the committed values stay as the team set
 * them.
 *
 * - `retry` at `ask` (with a copy present, or an unreadable one): no retries,
 *   and exhaustion escalates, so every failure asks. With no copy at all, the
 *   committed `recovery` stands (an install without the dial behaves as before).
 * - `questions` at `auto`: the ambiguous middle proceeds with a trail in every
 *   stage (`stageBias` both `proceed-and-log`); the agent writes down why.
 *
 * @param config - The loaded config's tunable parts.
 * @param read - What reading the copy found.
 * @returns The tunables in force (the input when nothing changes).
 */
export function applyAutonomy<T extends AutonomyTunables>(config: T, read: AutonomyRead): T {
  let next = config;
  if (stopInForce(read, 'retry') === 'ask') {
    next = { ...next, recovery: { ...next.recovery, maxRetries: 0, onExhausted: 'escalate' } };
  }
  if (stopInForce(read, 'questions') === 'auto') {
    next = { ...next, stageBias: { intake: 'proceed-and-log', execution: 'proceed-and-log' } };
  }
  return next;
}
