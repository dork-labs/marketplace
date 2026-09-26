/**
 * `flow note --kind friction|workaround|confusion [--item <id>] [--skill <name>]
 * "<text>"` (spec `flow-self-improvement` §2, DOR-2391): an agent records, in
 * one sentence, friction it hit in flow itself.
 *
 * Exit 2 on a missing or unknown kind or empty text. A journal that is off, or
 * that cannot be written, is not an error: the verb says so and exits 0, because
 * a note must never fail the work around it.
 *
 * Dependency-free, so it works before `npm install`.
 *
 * @module @dorkos/flow/cli/note
 */

import { flowVersion } from '../_shared.ts';
import { ConfigError, UsageError } from '../errors.ts';
import { NOTE_KINDS, append, journalFor, runtimeOf, type JournalEvent } from '../journal.ts';
import type { VerbContext, VerbResult } from './context.ts';

/**
 * Run `flow note`.
 *
 * @param ctx - The parsed invocation and the injected world.
 * @returns Whether the note was recorded, and where.
 * @throws {UsageError} On a missing or unknown kind, or empty text.
 * @throws {ConfigError} When flow must not act in this folder.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const { flags, positionals } = ctx.args;
  const kind = flags.kind;
  if (typeof kind !== 'string') {
    throw new UsageError(`--kind is required: ${NOTE_KINDS.join(', ')}`);
  }
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`unknown --kind "${kind}"; use ${NOTE_KINDS.join(', ')}`);
  }
  const text = (positionals[0] ?? '').trim();
  if (text === '') throw new UsageError('the note is empty; write one sentence');

  const journal = journalFor(ctx.projectDir, ctx.flowRoot);
  if ('refusal' in journal) throw new ConfigError(journal.refusal);
  const { settings } = journal;

  const event: JournalEvent = {
    kind: 'note',
    noteKind: kind as (typeof NOTE_KINDS)[number],
    text,
    ...(typeof flags.item === 'string' ? { item: flags.item } : {}),
    ...(typeof flags.skill === 'string' ? { skill: flags.skill } : {}),
  };
  const outcome = append(settings, event, {
    now: ctx.now(),
    flowVersion: flowVersion(ctx.flowRoot),
    session: ctx.sessionId,
    ...runtimeOf(ctx.env),
    warn: ctx.warn,
  });

  const texts = {
    written: `Noted (${kind}) in ${settings.path}.`,
    off: 'The journal is off (selfImprovement.journal.enabled is false), so the note was not written.',
    failed: 'The note was not written: the journal could not be written (see the warning).',
  };
  return {
    json: { ok: true, recorded: outcome === 'written', outcome, path: settings.path },
    text: texts[outcome],
  };
}
