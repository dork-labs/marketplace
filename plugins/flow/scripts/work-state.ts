/**
 * The work-state rule (spec `flow-cli-core` §5, F10): the one place flow says
 * what tracker state, `agent/*` and `stage/*` each mean.
 *
 * - The tracker **state category** says how far along an item is:
 *   `backlog`/`unstarted` not being worked, `started` being worked,
 *   `completed`/`canceled` closed.
 * - **At most one `agent/*` label** says who owns it: `agent/ready` (anyone may
 *   claim), `agent/claimed` (an agent is on it), `agent/needs-input` (parked on
 *   a person), `agent/completed` (an agent finished it).
 * - **At most one `stage/*` label** says where the next session resumes, and it
 *   exists only while the item is not started (`backlog` or `unstarted`).
 * - While an item is started, `FlowRun.stage` carries the stage.
 *
 * The writers (`flow claim`, `release`, `done`, `stage`) turn an event into a
 * {@link WorkStateChange} with {@link projectionFor} and use nothing else; the
 * audit reports breaches with {@link stateCoherence}. Keeping both here means
 * the rule is written once.
 *
 * Dependency-free on purpose: `audit-backlog.ts` imports this module and must
 * run before `npm install`. The only import is `errors.ts`, which imports
 * nothing. Types are declared locally rather than imported from `work-item.ts`
 * or `config-schema.ts`, which reach zod.
 *
 * @module @dorkos/flow/work-state
 */

import { PreconditionError } from './errors.ts';

/** A tracker workflow-state category (mirrors `StateCategorySchema`). */
export type WorkStateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

/** The label prefix that marks where the next session resumes. */
export const STAGE_LABEL_PREFIX = 'stage/';

/** The `agent/*` label an agent is working the item under. */
export const AGENT_CLAIMED = 'agent/claimed';
/** The `agent/*` label that makes an item claimable. */
export const AGENT_READY = 'agent/ready';
/** The `agent/*` label an agent leaves on an item it finished. */
export const AGENT_COMPLETED = 'agent/completed';

/**
 * The one change a writer applies to an item (spec §4, `applyWorkState`).
 * For each key: absent = leave as is; `null` = remove every label of that
 * family; a string = make it the one label of that family.
 */
export interface WorkStateChange {
  /** Move to a state of this category; absent = leave. */
  stateCategory?: WorkStateCategory;
  /** The one `agent/*` label; `null` = remove all; absent = leave. */
  agentLabel?: string | null;
  /** The one `stage/*` label; `null` = remove all; absent = leave. */
  stageLabel?: string | null;
}

/** The label prefix of the one-per-item ownership family. */
export const AGENT_LABEL_PREFIX = 'agent/';

/**
 * The label set an item carries after a {@link WorkStateChange}: for each
 * family the change names, every label of that family is dropped and the
 * change's label (when a string) added; every other label is kept in order.
 * Adapters compute their write from this, and `verifyWrite` checks against it,
 * so "replace the family" is written once.
 *
 * @param labels - The labels read from the tracker immediately before the write.
 * @param change - The change being applied.
 * @returns The labels the item should carry afterwards, without duplicates.
 */
export function labelsAfterChange(labels: readonly string[], change: WorkStateChange): string[] {
  const families: [string, string | null | undefined][] = [
    [AGENT_LABEL_PREFIX, change.agentLabel],
    [STAGE_LABEL_PREFIX, change.stageLabel],
  ];
  let next = [...new Set(labels)];
  for (const [prefix, label] of families) {
    if (label === undefined) continue;
    next = next.filter((existing) => !existing.startsWith(prefix));
    if (label !== null) next.push(label);
  }
  return next;
}

/** The fields of one config stage the rule reads (a slice of `StageSchema`). */
export interface StageInfo {
  /** The stage's `stage/*` label, when it has one. */
  label?: string;
  /** The state category entering this stage moves the item to, when set. */
  stateCategory?: WorkStateCategory;
}

/** Config `stages`, keyed by stage name, reduced to what the rule reads. */
export type StageTable = Readonly<Record<string, StageInfo>>;

/** An event a writer turns into a {@link WorkStateChange}. */
export type WorkStateEvent =
  | {
      /** `flow claim`: an agent starts working the item. */
      type: 'claim';
    }
  | {
      /** `flow release`: an agent lets go of the item. */
      type: 'release';
      /** `ready` hands it back to the queue; `none` leaves it unowned. */
      to: 'ready' | 'none';
      /** An explicit resume stage (`--stage`), a key of {@link StageTable}. */
      stage?: string;
    }
  | {
      /** `flow done`: an agent finished the item. */
      type: 'done';
    }
  | {
      /** `flow stage`: the item moves to another stage. */
      type: 'stage';
      /** The target stage, a key of {@link StageTable}. */
      stage: string;
    };

/** What {@link projectionFor} needs besides the event. */
export interface ProjectionContext {
  /** Config `stages` (labels and categories). */
  stages: StageTable;
  /** `FlowRun.stage` of the item's run record, when one exists. */
  runStage?: string;
  /** The `stage/*` label the claim removed, when known. */
  removedStageLabel?: string;
}

/**
 * Whether a category counts as open (not closed).
 *
 * @param category - A state category.
 * @returns `true` for `backlog`, `unstarted` and `started`.
 */
function isOpen(category: unknown): boolean {
  return category === 'backlog' || category === 'unstarted' || category === 'started';
}

/**
 * Whether an item in this category may carry a `stage/*` label.
 *
 * @param category - A state category, or absent when the change leaves state alone.
 * @returns `true` for `backlog` and `unstarted`.
 */
function mayCarryStageLabel(category: WorkStateCategory | undefined): boolean {
  return category === undefined || category === 'backlog' || category === 'unstarted';
}

/**
 * Look up a stage by key, refusing a key that is not in config.
 *
 * @param stages - Config `stages`.
 * @param key - The stage key to find.
 * @returns The stage's info.
 * @throws PreconditionError when `key` is not a configured stage.
 */
function stageOrThrow(stages: StageTable, key: string): StageInfo {
  const stage = Object.hasOwn(stages, key) ? stages[key] : undefined;
  if (stage === undefined) {
    throw new PreconditionError(
      `"${key}" is not a stage in config; use one of: ${Object.keys(stages).join(', ')}`
    );
  }
  return stage;
}

/**
 * The `stage/*` label to resume at: the explicit stage, else `FlowRun.stage`,
 * else the label the claim removed. A run stage with no label (such as
 * `review`) is skipped for the next source.
 *
 * @param explicit - The `--stage` key, when given.
 * @param ctx - The run stage, removed label and config stages.
 * @returns The resume label, or `undefined` when none is known.
 * @throws PreconditionError when `explicit` is not a configured stage with a label.
 */
function resumeLabel(explicit: string | undefined, ctx: ProjectionContext): string | undefined {
  if (explicit !== undefined) {
    const label = stageOrThrow(ctx.stages, explicit).label;
    if (label === undefined) {
      throw new PreconditionError(
        `stage "${explicit}" has no stage/* label to resume at; pass --stage with a stage that has one`
      );
    }
    return label;
  }
  const runLabel =
    ctx.runStage !== undefined && Object.hasOwn(ctx.stages, ctx.runStage)
      ? ctx.stages[ctx.runStage].label
      : undefined;
  if (runLabel !== undefined) return runLabel;
  if (ctx.removedStageLabel?.startsWith(STAGE_LABEL_PREFIX)) return ctx.removedStageLabel;
  return undefined;
}

/**
 * Turn a writer's event into the one change it applies (spec §5, the
 * projection table). The writers use nothing else.
 *
 * | Event | `stateCategory` | `agentLabel` | `stageLabel` |
 * | --- | --- | --- | --- |
 * | `claim` | `started` | `agent/claimed` | `null` |
 * | `release` to `ready` | `unstarted` | `agent/ready` | the resume label (required) |
 * | `release` to `none` | `unstarted` | `null` | the resume label when known, else absent |
 * | `done` | `completed` | `agent/completed` | `null` |
 * | `stage` to a stage not in `backlog`/`unstarted` | that category | absent | `null` |
 * | `stage` to any other stage | its category if set, else absent | absent | its label (`null` when it has none) |
 *
 * @param event - What the writer is doing.
 * @param ctx - Config stages plus what is known about the resume stage.
 * @returns The {@link WorkStateChange} to apply.
 * @throws PreconditionError when a release to `ready` has no known resume
 *   stage, or when a named stage is not in config.
 */
export function projectionFor(event: WorkStateEvent, ctx: ProjectionContext): WorkStateChange {
  switch (event.type) {
    case 'claim':
      return { stateCategory: 'started', agentLabel: AGENT_CLAIMED, stageLabel: null };
    case 'done':
      return { stateCategory: 'completed', agentLabel: AGENT_COMPLETED, stageLabel: null };
    case 'release': {
      const label = resumeLabel(event.stage, ctx);
      if (event.to === 'ready') {
        if (label === undefined) {
          throw new PreconditionError(
            'no resume stage is known for this item; pass --stage <stage> so a ready item says where to resume'
          );
        }
        return { stateCategory: 'unstarted', agentLabel: AGENT_READY, stageLabel: label };
      }
      return label === undefined
        ? { stateCategory: 'unstarted', agentLabel: null }
        : { stateCategory: 'unstarted', agentLabel: null, stageLabel: label };
    }
    case 'stage': {
      const stage = stageOrThrow(ctx.stages, event.stage);
      if (!mayCarryStageLabel(stage.stateCategory)) {
        return { stateCategory: stage.stateCategory, stageLabel: null };
      }
      const change: WorkStateChange = { stageLabel: stage.label ?? null };
      return stage.stateCategory === undefined
        ? change
        : { stateCategory: stage.stateCategory, ...change };
    }
  }
}

/** The fields of an item {@link stateCoherence} reads; everything else is ignored. */
export interface WorkStateItem {
  /** The item's state category. */
  stateCategory?: unknown;
  /** Every label on the item. */
  labels?: unknown;
}

/** The coherence check ids (spec §5). */
export type StateCheck = 'STATE-1' | 'STATE-2' | 'STATE-3' | 'STATE-4' | 'STATE-5';

/** One breach of the rule on one item. */
export interface StateViolation {
  /** Which check failed. */
  check: StateCheck;
  /** A plain sentence naming what is wrong. */
  detail: string;
}

/**
 * Check one item against the rule (spec §5, `STATE-1` to `STATE-5`). Only open
 * items are checked; closed ones return nothing. More than one `agent/*` label
 * is GRM-13's job and is not repeated here.
 *
 * Reads raw snapshot data, so a missing or malformed field degrades to "no
 * labels" or "not open" instead of throwing.
 *
 * @param item - The item, as the tracker adapter normalized it.
 * @returns Every breach found, in check order; empty when coherent.
 */
export function stateCoherence(item: WorkStateItem): StateViolation[] {
  const category = item.stateCategory;
  if (!isOpen(category)) return [];
  const labels = Array.isArray(item.labels)
    ? item.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const stageLabels = labels.filter((l) => l.startsWith(STAGE_LABEL_PREFIX));
  const started = category === 'started';
  const violations: StateViolation[] = [];

  if (stageLabels.length > 1) {
    violations.push({
      check: 'STATE-1',
      detail: `carries more than one stage/* label: ${stageLabels.join(', ')}`,
    });
  }
  if (started && stageLabels.length > 0) {
    violations.push({
      check: 'STATE-2',
      detail: `is started but carries ${stageLabels.join(', ')}; the stage lives on the run record while started`,
    });
  }
  if (!started && labels.includes(AGENT_CLAIMED)) {
    violations.push({
      check: 'STATE-3',
      detail: `carries ${AGENT_CLAIMED} but its state is ${String(category)}, not started`,
    });
  }
  if (started && labels.includes(AGENT_READY)) {
    violations.push({ check: 'STATE-4', detail: `carries ${AGENT_READY} but is started` });
  }
  if (labels.includes(AGENT_COMPLETED)) {
    violations.push({
      check: 'STATE-5',
      detail: `carries ${AGENT_COMPLETED} but is still open (${String(category)})`,
    });
  }
  return violations;
}

/**
 * The stage a run resumes at when there is no local run record (the recovery
 * ladder's `re-derive`: claimed on another machine). The tracker no longer
 * carries the stage of a started item, so it comes from the workspace.
 *
 * @param facts - What the workspace shows.
 * @param facts.hasOpenPr - Whether the item's branch has an open pull request.
 * @returns `verify` when a PR is open, else `execute`.
 */
export function deriveStage(facts: { hasOpenPr: boolean }): 'verify' | 'execute' {
  return facts.hasOpenPr ? 'verify' : 'execute';
}
