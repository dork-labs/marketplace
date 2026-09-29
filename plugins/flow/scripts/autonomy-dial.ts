/**
 * The dial itself (spec `flow-multiproject` §7.7): its kinds and stops, how a
 * stored value is read, how a stop is resolved for a kind, and how a person's
 * choice changes the stored value. Pure, with no imports at all, so the Flow
 * extension's browser half, which DorkOS bundles for the page, uses the very
 * same definitions as the engine (`autonomy.ts` re-exports them).
 *
 * @module @dorkos/flow/autonomy-dial
 */

/** The kinds of ask the dial covers, in the order the settings page lists them. */
export const AUTONOMY_KINDS = ['ship', 'questions', 'sort', 'retry'] as const;

/** One kind of ask. */
export type AutonomyKind = (typeof AUTONOMY_KINDS)[number];

/** The dial's three stops. */
export const AUTONOMY_STOPS = ['ask', 'tell', 'auto'] as const;

/** One stop: Ask me first, Tell me after, Just do it. */
export type AutonomyStop = (typeof AUTONOMY_STOPS)[number];

/** How long an agent waits for an answer at Tell me after, when the copy says nothing. */
export const DEFAULT_QUESTION_DEADLINE_MINUTES = 240;

/** The shortest wait a question may have (DorkOS's floor for a deadline). */
export const MIN_QUESTION_DEADLINE_MINUTES = 5;

/** The longest wait a question may have: seven days. */
export const MAX_QUESTION_DEADLINE_MINUTES = 7 * 24 * 60;

/** The dial as the copy holds it. */
export interface AutonomyCopy {
  /** The stop every kind follows unless {@link kinds} sets it apart. */
  dial: AutonomyStop;
  /** Kinds set apart from the dial ("Customize…"); a missing kind follows the dial. */
  kinds: Partial<Record<AutonomyKind, AutonomyStop>>;
  /** How long an agent waits for an answer at Tell me after. */
  questionDeadlineMinutes: number;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is one of the three stops. */
function isStop(value: unknown): value is AutonomyStop {
  return typeof value === 'string' && (AUTONOMY_STOPS as readonly string[]).includes(value);
}

/**
 * Check a copy's contents. Anything that is not a dial as described (an
 * unknown stop, a deadline outside 5 minutes to 7 days) is not a copy flow can
 * trust, and reads as `null`, which the resolver treats as `ask`. Unknown keys
 * are ignored, so a newer extension's copy still reads.
 *
 * @param value - The parsed JSON.
 * @returns The dial, or `null`.
 */
export function parseAutonomyCopy(value: unknown): AutonomyCopy | null {
  if (!isObject(value) || !isStop(value.dial)) return null;
  const kinds: Partial<Record<AutonomyKind, AutonomyStop>> = {};
  if (value.kinds !== undefined) {
    if (!isObject(value.kinds)) return null;
    for (const kind of AUTONOMY_KINDS) {
      const stop = value.kinds[kind];
      if (stop === undefined) continue;
      if (!isStop(stop)) return null;
      kinds[kind] = stop;
    }
  }
  let minutes = DEFAULT_QUESTION_DEADLINE_MINUTES;
  if (value.questionDeadlineMinutes !== undefined) {
    const given = value.questionDeadlineMinutes;
    if (
      typeof given !== 'number' ||
      !Number.isInteger(given) ||
      given < MIN_QUESTION_DEADLINE_MINUTES ||
      given > MAX_QUESTION_DEADLINE_MINUTES
    ) {
      return null;
    }
    minutes = given;
  }
  return { dial: value.dial, kinds, questionDeadlineMinutes: minutes };
}

/** What the resolver needs to know about the project beyond the dial. */
export interface AutonomyContext {
  /**
   * Whether a reviewer agent checks this project's work (`review.adversarial`).
   * Without one, "someone must check" would have no checker for the review
   * gate, so `ship` never leaves `ask`. Default `true`.
   */
  reviewerAgent?: boolean;
}

/**
 * The stop in force for one kind of ask. The one resolver the engine, the
 * skills (through `flow autonomy`) and the Flow extension all use.
 *
 * - No copy, or one that is not a dial: `ask`.
 * - Else the kind's own stop when Customize set one, else the dial's.
 * - `ship` stays `ask` without a reviewer agent ({@link AutonomyContext}).
 *
 * @param copy - The dial, or `null` when there is none or it could not be read.
 * @param kind - The kind of ask.
 * @param context - Facts about the project.
 * @returns The stop.
 */
export function resolveAutonomy(
  copy: AutonomyCopy | null,
  kind: AutonomyKind,
  context: AutonomyContext = {}
): AutonomyStop {
  if (copy === null) return 'ask';
  if (kind === 'ship' && context.reviewerAgent === false) return 'ask';
  return copy.kinds[kind] ?? copy.dial;
}

/** The default for a project flow first sees with no history: Tell me after (V10). */
export const NEW_PROJECT_DIAL: AutonomyCopy = {
  dial: 'tell',
  kinds: {},
  questionDeadlineMinutes: DEFAULT_QUESTION_DEADLINE_MINUTES,
};

/**
 * What a project with no copy acts on, written out: Ask me first, except that
 * failing checks are still fixed as the committed `recovery` settings say
 * (the engine's "no copy" rule, `stopInForce` in `autonomy.ts`).
 */
export const NO_COPY_DIAL: AutonomyCopy = {
  dial: 'ask',
  kinds: { retry: 'tell' },
  questionDeadlineMinutes: DEFAULT_QUESTION_DEADLINE_MINUTES,
};

/**
 * The value a dial choice stores: every kind follows the new stop, so any
 * Customize choices are cleared, and the question deadline stays.
 *
 * @param copy - The dial now, or `null` when none was ever chosen.
 * @param stop - The stop chosen.
 * @returns The value to store.
 */
export function withDial(copy: AutonomyCopy | null, stop: AutonomyStop): AutonomyCopy {
  return {
    dial: stop,
    kinds: {},
    questionDeadlineMinutes: copy?.questionDeadlineMinutes ?? DEFAULT_QUESTION_DEADLINE_MINUTES,
  };
}

/**
 * The value a Customize choice, or a "Next time, on its own?" Yes, stores:
 * that one kind moves and every other kind keeps the stop it has now. A kind
 * that lands on the dial's own stop follows the dial again.
 *
 * @param copy - The dial now, or `null` when none was ever chosen.
 * @param kind - The kind to move.
 * @param stop - Its new stop.
 * @param base - The dial to start from when there is no copy (default Ask me first).
 * @returns The value to store.
 */
export function withKind(
  copy: AutonomyCopy | null,
  kind: AutonomyKind,
  stop: AutonomyStop,
  base: AutonomyCopy = {
    dial: 'ask',
    kinds: {},
    questionDeadlineMinutes: DEFAULT_QUESTION_DEADLINE_MINUTES,
  }
): AutonomyCopy {
  const from = copy ?? base;
  const kinds: Partial<Record<AutonomyKind, AutonomyStop>> = { ...from.kinds };
  if (stop === from.dial) delete kinds[kind];
  else kinds[kind] = stop;
  return { dial: from.dial, kinds, questionDeadlineMinutes: from.questionDeadlineMinutes };
}

/**
 * Whether any kind is set apart from the dial ("Custom").
 *
 * @param copy - The dial.
 * @returns True when Customize moved at least one kind off the dial's stop.
 */
export function isCustom(copy: AutonomyCopy): boolean {
  return AUTONOMY_KINDS.some((kind) => (copy.kinds[kind] ?? copy.dial) !== copy.dial);
}
