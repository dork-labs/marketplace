/**
 * The journal events the `flow` CLI writes on its own (spec
 * `flow-self-improvement` §2, DOR-2391 task 3.1): a `verb` line after every
 * verb run, an `oracle.error` line when one fails with an internal error, and
 * the `claim` and `stage` lines the write verbs add as they change an item.
 *
 * These lines are a by-product of a verb, never its point, so writing one is
 * invisible to the verb's caller: {@link recordEvent} never throws, never
 * prints (the journal's own failure warning is dropped), and does nothing when
 * the project has no journal to write, that is outside git, where flow refuses
 * to act, or with no flow config. A verb's stdout, stderr and exit code are the
 * same whether or not its line was written. `flow note` and `flow journal`
 * write their own lines and report their own failures; they do not use this.
 *
 * Dependency-free, like the journal itself: `main` reaches it on every run,
 * before `npm install` included.
 *
 * @module @dorkos/flow/cli/auto-journal
 */

import { flowVersion } from '../_shared.ts';
import {
  findConfigRoots,
  journalSettings,
  refusalFor,
  resolveConfigFiles,
  type JournalSettings,
} from '../config-files.ts';
import { append, runtimeOf, type JournalEvent } from '../journal.ts';
import type { Runtime } from '../runtime-detect.ts';
import type { VerbContext } from './context.ts';

/** The parts of a verb's context an automatic event reads. */
export type EventContext = Pick<
  VerbContext,
  'projectDir' | 'flowRoot' | 'env' | 'sessionId' | 'now'
>;

/** Each context's resolved journal (`null`: none to write), so one run resolves it once. */
const resolved = new WeakMap<EventContext, JournalSettings | null>();

/**
 * The journal a verb's automatic events go to, or `null` when there is none:
 * outside git, where flow must not act, or with no flow config in the project.
 */
function journalOf(ctx: EventContext): JournalSettings | null {
  const cached = resolved.get(ctx);
  if (cached !== undefined) return cached;
  let settings: JournalSettings | null = null;
  try {
    const roots = findConfigRoots(ctx.projectDir, ctx.flowRoot);
    if (roots.inGit && refusalFor(roots) === null) {
      const files = resolveConfigFiles(roots);
      if (files.committed !== null) settings = journalSettings(roots, files);
    }
  } catch {
    settings = null;
  }
  resolved.set(ctx, settings);
  return settings;
}

/**
 * Append one automatic event to the project's journal, stamped with the
 * session, the plugin version, and the runtime and harness read from the
 * verb's own environment. Never throws and never prints.
 *
 * @param ctx - The verb's context.
 * @param event - The event.
 * @param runtime - The runtime the verb itself resolved, when it did (`flow
 *   claim` records one on the run, and its line must agree). Default: what the
 *   environment says. A verb's own `--runtime` flag is not read here: on `flow
 *   usage` it names whose usage to read, not the runtime running the verb.
 */
export function recordEvent(ctx: EventContext, event: JournalEvent, runtime?: Runtime): void {
  try {
    const settings = journalOf(ctx);
    if (settings === null) return;
    const detected = runtimeOf(ctx.env);
    append(settings, event, {
      now: ctx.now(),
      flowVersion: flowVersion(ctx.flowRoot),
      session: ctx.sessionId,
      runtime: runtime ?? detected.runtime,
      harness: detected.harness,
      warn: () => {},
    });
  } catch {
    // A journal line is never worth failing, or even changing, the verb.
  }
}

/**
 * Whether a verb run gets a `verb` line. `note` and `journal` write to the
 * journal themselves, so a line about them would be the journal recording
 * itself. `usage record` runs on every status-line refresh, many times a
 * minute, so only a run that failed (a non-zero exit) is recorded; its
 * successes would crowd out everything else. An `oracle.error` line does not
 * ask this: an internal error is always recorded, whatever the verb.
 *
 * @param verb - The verb name.
 * @param positionals - Its positional arguments.
 * @param exit - The run's exit code.
 * @returns `true` when the run gets a `verb` line.
 */
export function recordsVerbRun(
  verb: string,
  positionals: readonly string[],
  exit: number
): boolean {
  if (verb === 'note' || verb === 'journal') return false;
  // The limit-check hook runs after every tool call of every session; a line
  // per call would bury the journal. Its manual form (an identifier) is kept.
  if (verb === 'limit-check' && positionals.length === 0) return false;
  return !(verb === 'usage' && positionals[0] === 'record' && exit === 0);
}
