/**
 * `flow journal` (spec `flow-self-improvement` §2, DOR-2391):
 *
 * - `flow journal record <review|ci|handoff> --field value ...` records an event
 *   the CLI cannot see for itself (a review verdict, a CI red, a handoff). The
 *   line is checked against the journal line schema first; a bad one is exit 2
 *   with the schema's message. Recording needs `zod`, loaded only here, so a
 *   missing install is exit 6 like every zod-needing verb.
 * - `flow journal tail [-n N] [--kind k]` prints the newest lines. No zod.
 *
 * @module @dorkos/flow/cli/journal
 */

import { flowVersion } from '../_shared.ts';
import { ConfigError, UsageError } from '../errors.ts';
import {
  ITEM_MAX,
  JOURNAL_KINDS,
  NAME_MAX,
  append,
  buildLine,
  runtimeOf,
  journalFor,
  read,
  type JournalEvent,
  type LineMeta,
} from '../journal.ts';
import type { JournalSettings } from '../config-files.ts';
import type { VerbContext, VerbResult } from './context.ts';
import { formatColumns } from './output.ts';
import { RECORD_FLAGS, TAIL_FLAGS } from './journal-verbs.ts';

/** The events a person or agent may record by hand; the CLI writes the rest itself. */
const RECORDABLE = ['review', 'ci', 'handoff'] as const;
/** Record flags whose value is a whole number. */
const NUMERIC = new Set(['round', 'blocker', 'shouldFix', 'nit', 'pr']);
/** Default tail length. */
const TAIL_DEFAULT = 20;

/**
 * Run `flow journal`.
 *
 * @param ctx - The parsed invocation and the injected world.
 * @returns The recorded line, or the tailed lines.
 * @throws {UsageError} On an unknown action or kind, a flag the action does not
 *   take, or an event the schema rejects.
 * @throws {ConfigError} When flow must not act in this folder.
 */
export async function run(ctx: VerbContext): Promise<VerbResult> {
  const [action, kind] = ctx.args.positionals;
  if (action !== 'record' && action !== 'tail') {
    throw new UsageError(`unknown action "${action}"; use record or tail`);
  }
  refuseFlags(ctx, action === 'record' ? TAIL_FLAGS : RECORD_FLAGS, action);

  const journal = journalFor(ctx.projectDir, ctx.flowRoot);
  if ('refusal' in journal) throw new ConfigError(journal.refusal);
  return action === 'record'
    ? record(ctx, journal.settings, kind)
    : tail(ctx, journal.settings, kind);
}

/** Refuse any flag given that belongs to the other action. */
function refuseFlags(ctx: VerbContext, foreign: readonly { name: string }[], action: string): void {
  const given = foreign.find((flag) => flag.name in ctx.args.flags);
  if (given) throw new UsageError(`"flow journal ${action}" does not take --${given.name}`);
}

/** `--should-fix` → `shouldFix`. */
function fieldName(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Build the event from the flags: numbers where the schema wants them, lists split. */
function eventFrom(kind: (typeof RECORDABLE)[number], ctx: VerbContext): Record<string, unknown> {
  const event: Record<string, unknown> = { kind };
  if (kind === 'review') Object.assign(event, { blocker: 0, shouldFix: 0, nit: 0, categories: [] });
  for (const [flag, value] of Object.entries(ctx.args.flags)) {
    if (!RECORD_FLAGS.some((f) => f.name === flag) || typeof value !== 'string') continue;
    const field = fieldName(flag);
    if (NUMERIC.has(field)) {
      event[field] = /^-?\d+$/.test(value) ? Number(value) : value;
    } else if (field === 'categories') {
      event[field] = value
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== '');
    } else {
      event[field] = value;
    }
  }
  return event;
}

/** `flow journal record <kind> ...`. */
async function record(
  ctx: VerbContext,
  settings: JournalSettings,
  kind: string | undefined
): Promise<VerbResult> {
  if (kind === undefined) {
    throw new UsageError(`missing <kind> for "flow journal record": ${RECORDABLE.join(', ')}`);
  }
  if (!(RECORDABLE as readonly string[]).includes(kind)) {
    throw new UsageError(`cannot record "${kind}" by hand; use ${RECORDABLE.join(', ')}`);
  }
  const event = eventFrom(kind as (typeof RECORDABLE)[number], ctx) as JournalEvent;
  // buildLine caps every field so an automatic event can never be refused; a
  // value typed by hand that is too long is a usage error instead (exit 2).
  for (const [field, value] of Object.entries(event)) {
    const values = Array.isArray(value) ? value : [value];
    const max = field === 'item' ? ITEM_MAX : NAME_MAX;
    const long = values.find((entry) => typeof entry === 'string' && entry.length > max);
    if (long !== undefined) {
      throw new UsageError(`invalid ${kind} event: ${field} is longer than ${max} characters`);
    }
  }
  const meta: LineMeta = {
    now: ctx.now(),
    flowVersion: flowVersion(ctx.flowRoot),
    session: ctx.sessionId,
    ...runtimeOf(ctx.env),
  };
  const { JournalLineSchema } = await import('../journal-schema.ts');
  const checked = JournalLineSchema.safeParse(buildLine(event, meta));
  if (!checked.success) {
    const issues = checked.error.issues.map((issue) => {
      const at = issue.path.join('.');
      return at === '' ? issue.message : `${at}: ${issue.message}`;
    });
    throw new UsageError(`invalid ${kind} event: ${issues.join('; ')}`);
  }

  const outcome = append(settings, event, { ...meta, warn: ctx.warn });
  const texts = {
    written: `Recorded ${kind} in ${settings.path}.`,
    off: `The journal is off (selfImprovement.journal.enabled is false), so the ${kind} event was not written.`,
    failed: `The ${kind} event was not written: the journal could not be written (see the warning).`,
  };
  return {
    json: {
      ok: true,
      recorded: outcome === 'written',
      outcome,
      path: settings.path,
      line: checked.data,
    },
    text: texts[outcome],
  };
}

/** `flow journal tail [-n N] [--kind k]`. */
function tail(ctx: VerbContext, settings: JournalSettings, extra: string | undefined): VerbResult {
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}" for tail`);
  const { lines: count, kind } = ctx.args.flags;
  let limit = TAIL_DEFAULT;
  if (typeof count === 'string') {
    if (!/^[1-9]\d*$/.test(count)) throw new UsageError('-n needs a whole number above 0');
    limit = Number(count);
  }
  if (typeof kind === 'string' && !(JOURNAL_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(`unknown --kind "${kind}"; use one of ${JOURNAL_KINDS.join(', ')}`);
  }

  const { lines, skipped } = read(settings);
  const shown = lines.filter((line) => kind === undefined || line.kind === kind).slice(-limit);
  if (skipped > 0) ctx.warn(`${skipped} journal line(s) could not be read and were skipped`);

  const text =
    shown.length === 0
      ? kind === undefined
        ? `The journal is empty (${settings.path}).`
        : `No ${kind} lines in the journal.`
      : formatColumns(
          shown.map((line) => {
            const {
              v: _v,
              ts,
              kind: k,
              flow: _f,
              session: _s,
              runtime,
              harness: _h,
              item,
              ...fields
            } = line;
            return [ts, k, runtime ?? 'unknown', item ?? '-', JSON.stringify(fields)];
          })
        );
  return {
    json: { ok: true, path: settings.path, lines: shown, skipped },
    text,
  };
}
