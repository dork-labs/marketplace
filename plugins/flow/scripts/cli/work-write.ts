/**
 * What the four write verbs (`flow claim`, `release`, `done`, `stage`) share
 * (spec `flow-cli-core` §5, §6): load the project's config, build the adapter
 * and check its capabilities, open the run store, and apply one work-state
 * change and confirm it on read-back.
 *
 * Each verb turns its event into a change with `projectionFor` and writes it
 * only through {@link applyAndVerify}, so no verb decides a label or a state on
 * its own.
 *
 * Needs `zod` (through config loading), so it is only reached through a verb's
 * dynamic import.
 *
 * @module @dorkos/flow/cli/work-write
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';

import { findConfigRoots } from '../config-files.ts';
import { loadConfig, type LoadedConfig } from '../config-load.ts';
import { ConfigError, PreconditionError } from '../errors.ts';
import type { FlowRun, FlowRunProvenance, FlowStage } from '../flow-run.ts';
import { openFlowStateFile, type FlowStateFile } from '../flow-state-file.ts';
import { FlowStateSchema } from '../flow-state.ts';
import { requireCapabilities } from '../tracker/load.ts';
import type { Capability, CodeAdapter, ItemWithComments, WorkItem } from '../tracker/types.ts';
import { verifyWrite } from '../tracker/verify-write.ts';
import {
  AGENT_FROM_OUTSIDE,
  STAGE_LABEL_PREFIX,
  type StageTable,
  type WorkStateChange,
} from '../work-state.ts';
import type { VerbContext } from './context.ts';
import { verbLoadOptions } from './load-options.ts';
import { buildProvenance } from './provenance.ts';

/** Everything a write verb runs on. */
export interface WriteSetup {
  /** The project's loaded config. */
  loaded: LoadedConfig;
  /** Config `stages`, reduced to what the work-state rule reads. */
  stages: StageTable;
  /** The tracker adapter, with the verb's capabilities checked. */
  adapter: CodeAdapter;
  /** The project's run store. */
  store: FlowStateFile;
}

/**
 * Load config, build the adapter, check the capabilities the verb calls, and
 * open the run store (refusing a store file that could not be written back
 * safely, before the tracker is touched).
 *
 * @param ctx - The verb's context.
 * @param needed - The adapter methods the verb calls.
 * @returns The loaded setup.
 * @throws {ConfigError} On a config problem, a missing capability, or an
 *   unreadable run store.
 */
export async function setupWrite(
  ctx: VerbContext,
  needed: readonly Capability[]
): Promise<WriteSetup> {
  const loaded = loadConfig(
    findConfigRoots(ctx.projectDir, ctx.flowRoot),
    ctx.env,
    verbLoadOptions(ctx)
  );
  const adapter = await ctx.adapter();
  requireCapabilities(adapter, needed);
  const store = openFlowStateFile(ctx.projectDir, { now: ctx.now });
  checkStoreWritable(store.path);
  return { loaded, stages: loaded.config.stages as StageTable, adapter, store };
}

/**
 * Refuse a run store that is present but not a valid store, before any tracker
 * write: the writer would refuse it anyway, and by then the tracker would
 * already be changed with no run to match.
 *
 * @param file - The `flow-state.json` path.
 * @throws {ConfigError} Naming the file.
 */
function checkStoreWritable(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || !FlowStateSchema.safeParse(parsed).success) {
    throw new ConfigError(
      `${file} is not a valid flow run store; flow changed nothing. Fix or move the file, then retry.`
    );
  }
}

/**
 * The change flow may write to an item carrying `agent/from-outside`
 * (DOR-3258). Only a person, or the PM in its own triage, clears that label,
 * by editing the tracker with a comment saying who; no flow write may, attended
 * or not. Closing the item is allowed (a person may ask for it), and it closes
 * with the label still on, so reopening it never makes it triage-able.
 *
 * @param item - The item as read before the write.
 * @param change - The change asked for.
 * @returns The change to write: as asked, or a close that leaves `agent/*` alone.
 * @throws {PreconditionError} When the change would replace the label on an open item (exit 5).
 */
export function fromOutsideChange(item: WorkItem, change: WorkStateChange): WorkStateChange {
  if (!item.labels.includes(AGENT_FROM_OUTSIDE) || change.agentLabel === undefined) return change;
  if (change.stateCategory === 'completed' || change.stateCategory === 'canceled') {
    const { agentLabel: _kept, ...close } = change;
    return close;
  }
  throw new PreconditionError(
    `${item.identifier} carries ${AGENT_FROM_OUTSIDE}: it came from outside the team, and only a person (or the PM in its own triage) clears that label, by editing the tracker after re-stating the work in our words, with a comment saying who. Flow leaves it alone.`
  );
}

/**
 * Refuse, before anything is written, a change {@link fromOutsideChange} would refuse.
 *
 * @param item - The item as read before the write.
 * @param change - The change about to be written.
 * @throws {PreconditionError} When the change would replace the label (exit 5).
 */
export function requireNotFromOutside(item: WorkItem, change: WorkStateChange): void {
  fromOutsideChange(item, change);
}

/**
 * Apply one change and confirm the tracker kept it. On an item carrying
 * `agent/from-outside`, a change that would replace the label is refused
 * before any write, and a close leaves the label on.
 *
 * @param adapter - The adapter.
 * @param item - The item as read before the write.
 * @param change - The projection to apply.
 * @returns The item as re-read after the write.
 * @throws {TrackerError} When the write fails or the re-read disagrees (exit 4).
 */
export async function applyAndVerify(
  adapter: CodeAdapter,
  item: WorkItem,
  change: WorkStateChange
): Promise<ItemWithComments> {
  const effective = fromOutsideChange(item, change);
  await adapter.applyWorkState(item, effective);
  return verifyWrite(adapter, item, effective);
}

/**
 * Whether an item is open (not completed or canceled).
 *
 * @param item - The item.
 * @returns `true` for `backlog`, `unstarted` and `started`.
 */
export function isOpenItem(item: WorkItem): boolean {
  return (
    item.stateCategory === 'backlog' ||
    item.stateCategory === 'unstarted' ||
    item.stateCategory === 'started'
  );
}

/**
 * The item's `stage/*` label, when it carries exactly one.
 *
 * @param item - The item.
 * @returns The label, or `undefined`.
 */
export function currentStageLabel(item: WorkItem): string | undefined {
  const labels = item.labels.filter((label) => label.startsWith(STAGE_LABEL_PREFIX));
  return labels.length === 1 ? labels[0] : undefined;
}

/**
 * The config stage key whose label is `label`.
 *
 * @param stages - Config stages.
 * @param label - A `stage/*` label.
 * @returns The stage key, or `undefined` when no stage carries that label.
 */
export function stageForLabel(
  stages: StageTable,
  label: string | undefined
): FlowStage | undefined {
  if (label === undefined) return undefined;
  const key = Object.keys(stages).find((name) => stages[name].label === label);
  return key as FlowStage | undefined;
}

/**
 * The run record for an item, when one exists.
 *
 * @param store - The run store.
 * @param item - The item.
 * @returns Its run, or `undefined`.
 */
export function runFor(store: FlowStateFile, item: WorkItem): FlowRun | undefined {
  const runs = store.read();
  return Object.hasOwn(runs, item.id) ? runs[item.id] : undefined;
}

/**
 * The provenance of the session running this verb.
 *
 * @param ctx - The verb's context.
 * @param launcher - The launcher, when known.
 * @returns The provenance block, unknown fields left out.
 */
export function sessionProvenance(ctx: VerbContext, launcher?: string): FlowRunProvenance {
  return buildProvenance({
    env: ctx.env,
    sessionId: ctx.sessionId,
    launcher,
    hostname: os.hostname(),
  });
}

/**
 * Refuse a write verb on an item the tracker has closed.
 *
 * @param item - The item.
 * @param verb - The verb, for the message.
 * @throws {PreconditionError} When the item is completed or canceled.
 */
export function requireOpen(item: WorkItem, verb: string): void {
  if (!isOpenItem(item)) {
    throw new PreconditionError(
      `${item.identifier} is ${item.stateCategory}, so "flow ${verb}" cannot act on it`
    );
  }
}

/**
 * Throw when the run store dropped a write because another flow held its lock.
 * The tracker change already landed, so the message says how to recover.
 *
 * @param status - The store write's status.
 * @param file - The store path.
 * @param recovery - What to run to put things right.
 * @throws {PreconditionError} When the write was dropped.
 */
export function requireStored(status: string, file: string, recovery: string): void {
  if (status === 'dropped') {
    throw new PreconditionError(
      `the tracker was updated, but ${file} stayed locked by another flow command, so the run record was not saved; ${recovery}`
    );
  }
}
