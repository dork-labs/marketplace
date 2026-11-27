/**
 * The two type vocabularies (DOR-5069): flow's own `type/*` label group and
 * the bare `Bug`, `Improvement` and `Feature` labels people use in the tracker.
 * `flow create` accepts either; the work order's type key reads either; the
 * groom's GRM-12 lets the three bare names through.
 *
 * - A bare label maps onto one flow type: `Bug` and `Improvement` are
 *   `type/task`, `Feature` is `type/idea`. Given alone, it brings its
 *   `type/*` label, which every flow team has (GRM-1).
 * - Of flow's types, only `type/task` implies a bare label (`Improvement`).
 *   `type/idea` implies none: it is capture's placeholder until triage
 *   reclassifies the item, so a bare `Feature` on it would go stale.
 * - A bare label flow implies is **optional**: written only when the team has
 *   it (`NewItem.optionalLabels`, `WorkStateChange.optionalLabels`), so a team
 *   that deleted the bare labels still files and triages.
 * - A reclassification swaps only a bare label flow itself implied; one a
 *   person set that names a different type is left, with a note.
 *
 * @module @dorkos/flow/type-labels
 */

import type { WorkStateChange } from './work-state.ts';

/** Flow's own types, the leaves of the `type/*` group (`WorkItemType`). */
export const FLOW_TYPES: readonly string[] = [
  'idea',
  'research',
  'hypothesis',
  'task',
  'monitor',
  'signal',
  'meta',
];

/** The bare type labels, exactly as the tracker names them. */
export const BARE_TYPE_LABELS: readonly string[] = ['Bug', 'Improvement', 'Feature'];

/** A bare type label (tracker spelling) to the flow `type/*` label it names. */
const FLOW_TYPE_OF_BARE = new Map<string, string>([
  ['Bug', 'type/task'],
  ['Improvement', 'type/task'],
  ['Feature', 'type/idea'],
]);

/** A flow `type/*` label to the bare type label it implies, when there is one. */
const BARE_OF_FLOW_TYPE = new Map<string, string>([['type/task', 'Improvement']]);

/** The `type/*` family prefix. */
const TYPE_PREFIX = 'type/';

/**
 * The bare type label a label names, in the tracker's own spelling, or
 * `undefined` when it names none.
 *
 * @param label - Any label.
 * @returns `Bug`, `Improvement` or `Feature`, or `undefined`.
 */
export function bareTypeOf(label: string): string | undefined {
  return BARE_TYPE_LABELS.find((name) => name.toLowerCase() === label.trim().toLowerCase());
}

/** What {@link resolveTypes} decides for a new item's labels. */
export interface ResolvedTypes {
  /** The labels to write: bare type labels in tracker spelling, each once, plus an implied `type/*`. */
  labels: string[];
  /** The bare label `type/*` implies: written only when the team has it. */
  optional: string[];
  /** Why the labels cannot be filed as given; empty when they can. */
  problems: string[];
}

/**
 * Settle a new item's type labels: either vocabulary is accepted, a bare
 * label is written in the tracker's spelling and once (whatever its case), a
 * bare label alone brings its `type/*` label, and `type/task` alone brings
 * `Improvement` as an optional label. Two bare types, or a bare and a `type/*`
 * label naming different types, are refused.
 *
 * @param given - The labels as asked for.
 * @returns The labels to write, the optional ones, and any problems.
 */
export function resolveTypes(given: readonly string[]): ResolvedTypes {
  const labels = [...new Set(given.map((label) => bareTypeOf(label) ?? label))];
  const problems: string[] = [];
  const bares = labels.filter((label) => FLOW_TYPE_OF_BARE.has(label));
  const flow = labels.find((label) => label.startsWith(TYPE_PREFIX));
  if (bares.length > 1) {
    problems.push(
      `${bares.map((label) => `"${label}"`).join(' and ')} are both type labels, and an item takes one type`
    );
    return { labels, optional: [], problems };
  }
  const bare = bares[0];
  if (bare !== undefined) {
    const implied = FLOW_TYPE_OF_BARE.get(bare) as string;
    if (flow === undefined) labels.push(implied);
    else if (flow !== implied) {
      problems.push(
        `"${flow}" and "${bare}" name different types ("${bare}" is a ${implied}): keep one`
      );
    }
    return { labels, optional: [], problems };
  }
  const implied = flow === undefined ? undefined : BARE_OF_FLOW_TYPE.get(flow);
  return { labels, optional: implied === undefined ? [] : [implied], problems };
}

/** The change {@link typeChange} plans for `flow triage --type`. */
export interface TypeChange {
  /** The label part of the work-state change. */
  change: Pick<WorkStateChange, 'typeLabel' | 'dropLabels' | 'optionalLabels'>;
  /** A plain line when a person's bare label was left alone, else `null`. */
  note: string | null;
}

/**
 * Plan a reclassification to `type/<kind>`: the `type/*` label is replaced;
 * a bare label flow implied for the old type is swapped for the one the new
 * type implies (optional: only when the team has it); a bare label that
 * already agrees is kept; one a person set that names a different type is
 * left alone, and the note says so.
 *
 * @param labels - The item's labels as read before the write.
 * @param kind - The new flow type, e.g. `task`.
 * @returns The label change and a note.
 */
export function typeChange(labels: readonly string[], kind: string): TypeChange {
  const typeLabel = `${TYPE_PREFIX}${kind}`;
  const oldFlow = labels.find((label) => label.startsWith(TYPE_PREFIX));
  // Any case: a label is dropped as the tracker spells it, compared by name.
  const bare = labels.find((label) => bareTypeOf(label) !== undefined);
  const name = bare === undefined ? undefined : (bareTypeOf(bare) as string);
  const impliedNew = BARE_OF_FLOW_TYPE.get(typeLabel);
  const optional = impliedNew === undefined ? {} : { optionalLabels: [impliedNew] };
  if (bare === undefined || name === undefined) {
    return { change: { typeLabel, ...optional }, note: null };
  }
  if (FLOW_TYPE_OF_BARE.get(name) === typeLabel) return { change: { typeLabel }, note: null };
  if (oldFlow !== undefined && BARE_OF_FLOW_TYPE.get(oldFlow) === name) {
    return { change: { typeLabel, dropLabels: [bare], ...optional }, note: null };
  }
  return {
    change: { typeLabel },
    note: `left "${bare}" on it: a person set it, and it names a different type than ${typeLabel}`,
  };
}
