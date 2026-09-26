/**
 * The shape of one journal line (spec `flow-self-improvement` §2, DOR-2391).
 *
 * A closed union on `kind`, every member `.strict()`: a line carries only the
 * fields named here, so nothing else (a comment body, a prompt, a diff) can ride
 * along. `journal.ts` writes and reads lines without zod and imports only the
 * {@link JournalLine} type from here; this schema is what `flow journal record`
 * checks a hand-entered event against, and what the tests hold every written line
 * to.
 *
 * Needs `zod`, so it is only ever loaded lazily, by the verb that validates.
 *
 * @module @dorkos/flow/journal-schema
 */

import { z } from 'zod';

import { RUNTIMES } from './runtime-detect.ts';
import {
  ERROR_CLASS_MAX,
  ITEM_MAX,
  JOURNAL_KINDS,
  NAME_MAX,
  NOTE_KINDS,
  NOTE_TEXT_MAX,
  REVIEW_CATEGORIES,
} from './journal.ts';

/** A short name or identifier: a verb, a stage, an account handle. */
const Name = z.string().min(1).max(NAME_MAX);
/** A count that cannot be negative. */
const Count = z.number().int().nonnegative();

/** The fields every line carries, whatever its kind. */
const common = {
  /** The line format version. */
  v: z.literal(1),
  /** When the event happened, ISO-8601 UTC. */
  ts: z.iso.datetime(),
  /** The flow plugin version that wrote the line. */
  flow: z.string().min(1).max(40),
  /**
   * The agent runtime the writer ran under (`detectRuntime`). Optional because
   * lines written before 0.21.0 lack it; `read` fills in `unknown`.
   */
  runtime: z.enum([...RUNTIMES, 'unknown']).optional(),
  /** What hosted the session (see `detectRuntime`); optional for the same reason. */
  harness: Name.optional(),
  /** The first 8 characters of the harness session id, when known. */
  session: z.string().min(1).max(8).optional(),
  /** The tracker identifier the event is about, when there is one. */
  item: z.string().min(1).max(ITEM_MAX).optional(),
};

/** Build one member of the union: the common fields, the kind, and its own fields. */
function line<K extends (typeof JOURNAL_KINDS)[number], S extends z.ZodRawShape>(
  kind: K,
  shape: S
) {
  return z.object({ ...common, kind: z.literal(kind), ...shape }).strict();
}

/** One journal line. See the kind table in spec §2. */
export const JournalLineSchema = z.discriminatedUnion('kind', [
  line('verb', { verb: Name, ms: Count, exit: z.number().int().min(0).max(255) }),
  line('oracle.error', {
    oracle: Name,
    exit: z.number().int(),
    errorClass: z.string().max(ERROR_CLASS_MAX),
  }),
  line('stage', {
    stage: Name,
    phase: z.enum(['start', 'end']),
    outcome: z.enum(['ok', 'failed', 'parked']).optional(),
  }),
  line('item.readied', { by: z.enum(['triage', 'decompose', 'human']) }),
  line('claim', { phase: z.enum(['claim', 'release']) }),
  line('retry', {
    rung: z.enum(['resume', 'restart', 'escalate']),
    attempt: z.number().int().positive(),
  }),
  line('operator.wait', { phase: z.enum(['start', 'end']), waitedMs: Count.optional() }),
  line('review', {
    round: z.number().int().positive(),
    sha7: z.string().regex(/^[0-9a-f]{7}$/, 'sha7 is the first 7 hex characters of a commit'),
    verdict: z.enum(['clean', 'changes']),
    blocker: Count,
    shouldFix: Count,
    nit: Count,
    categories: z.array(z.enum(REVIEW_CATEGORIES)),
  }),
  line('ci', {
    pr: z.number().int().positive(),
    event: z.enum(['red', 'ejected', 'merged']),
    class: z.enum(['own', 'innocent', 'flake', 'infra', 'unknown']),
  }),
  line('handoff', { from: Name, to: Name, reason: z.enum(['limit', 'stage', 'manual']) }),
  line('note', {
    noteKind: z.enum(NOTE_KINDS),
    text: z.string().min(1).max(NOTE_TEXT_MAX),
    skill: Name.optional(),
  }),
  line('selftest', {
    tiers: z.array(Name),
    pass: Count,
    fail: Count,
    skip: Count,
    ms: Count,
    failing: z.array(Name),
  }),
  line('retro', { window: Name, proposals: Count, filed: Count, commented: Count }),
  line('usage.snapshot', {
    /** The runtime the ACCOUNT belongs to (a server may sample another runtime's account). */
    accountRuntime: z.enum(RUNTIMES),
    /** The account id in that runtime's registry, or `default` for its implicit one. */
    account: Name,
    /** Readings by window name (fleet decision R2 names). */
    windows: z
      .record(
        z
          .string()
          .regex(
            /^(five_hour|seven_day|seven_day_opus|seven_day_sonnet|model:[a-z0-9._-]{1,40}|window:\d{1,6})$/,
            'a window is five_hour, seven_day, seven_day_opus, seven_day_sonnet, model:<slug> or window:<minutes>'
          ),
        z
          .object({
            usedPct: z.number().min(0).max(100),
            resetsAt: z.iso.datetime({ offset: true }).nullable(),
          })
          .strict()
      )
      .refine((windows) => Object.keys(windows).length <= 12, 'at most 12 windows'),
    /** The plan the runtime reports (for example max, pro, plus), when it reports one. */
    plan: Name.optional(),
    /** Metered spend in the current period, for accounts billed per use. */
    spend: z
      .object({
        costUsd: z.number().nonnegative(),
        limitUsd: z.number().nonnegative().optional(),
        periodStart: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
  }),
]);

/** One journal line. */
export type JournalLine = z.infer<typeof JournalLineSchema>;
