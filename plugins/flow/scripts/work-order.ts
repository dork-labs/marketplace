/**
 * The **work order** (DOR-5063): the one function that answers "what is
 * next?" for people and agents alike. `flow order` prints it; `flow next`
 * takes its picks from it when `dispatch.ladder` is `v2`. Nothing else in the
 * plugin sorts work items (`engine-tests/tracker-confinement.test.ts` holds
 * that), so every caller quotes the same list.
 *
 * ## Two lists
 *
 * 1. **Projects** ({@link rankProjects | `project-order.ts`}): Started projects
 *    are "now" and feed the issue order; Planned ones are "next"; Paused and
 *    Backlog ones are "later".
 * 2. **Issues**, in bands, first to last: pinned (label `pin`), Urgent
 *    (priority 1), release gate (label `release-gate`), Must (priority 2 in a
 *    `unstarted` state, i.e. Todo), Should (priority 3, or priority 2 still in
 *    Backlog), Could (priority 4). Inside a band the keys in
 *    `dispatch.orderKeys` decide, then the issue number. Urgent skips the
 *    project-rank key: broken is broken, whatever the project.
 *
 * ## What does not rank, and where it goes instead
 *
 * - Started items (In Progress, In Review) are {@link WorkOrder.inFlight}:
 *   shown, never re-ranked.
 * - Items in triage, or with no priority, no project or no estimate, are
 *   {@link WorkOrder.needsTriage}, with the missing fields named. Urgent items
 *   and release gates rank without a project.
 * - An item blocked by an open item is {@link WorkOrder.held} ("held by
 *   DOR-x"); its blocker inherits the better of its own place and the blocked
 *   item's, through any depth.
 * - An item in a project that is not Started is held "waits for project
 *   <P>", unless it is Urgent or a release gate.
 * - An item or project labelled `owner/dorian` is {@link WorkOrder.dorian}: out
 *   of the agent order.
 *
 * ## Pure
 *
 * Same input, same output: no clock (the caller passes `now`), no network, and
 * input order never matters. Bad adapter data degrades the way
 * `dispatch-policy.ts` describes (neutral, never a guess, never a throw).
 *
 * @see research/20261122_work-sequencing.md §3 (dorkos repo), the signed-off method
 * @module @dorkos/flow/work-order
 */

import type { OrderKeySchema, SizeOrderSchema } from './config-schema.ts';
import type { FlowConfig } from './config-schema.ts';
import type { ProjectInfo, WorkItem } from './work-item.ts';
import type { z } from 'zod';

/** One key that orders items inside a band (mirrors `OrderKeySchema`). */
export type OrderKey = z.infer<typeof OrderKeySchema>;

/** The band an item ranks in, first to last. */
export type Band = 'pin' | 'urgent' | 'releaseGate' | 'must' | 'should' | 'could';

/** One plain-words reason an item or project sits where it does. */
export interface OrderReason {
  /** The key that gave this reason: a band name, an {@link OrderKey}, `inherits`, `pin`. */
  key: string;
  /** Plain words: "due Nov 27", "project #2 Release branches", "size 2". */
  text: string;
}

/** Whether an item is ready to start, and if not, why. Readiness never moves an item. */
export interface Readiness {
  /** `true` when nothing stands between an agent and starting it. */
  ready: boolean;
  /** Each thing missing: "needs a size", "blocked by DOR-12", and so on. Empty when ready. */
  reasons: string[];
}

/** One ranked item of the issue order. */
export interface OrderedIssue {
  /** 1-based place in the order. */
  place: number;
  /** Human key, e.g. `DOR-123`. */
  identifier: string;
  /** The item's title. */
  title: string;
  /** The band it ranks in. */
  band: Band;
  /** One reason per key that decided its place, band first. */
  why: OrderReason[];
  /** Whether it is ready to start. */
  readiness: Readiness;
  /** Its project's id, when it has one. */
  projectId?: string;
  /** The blocked item whose place this one took, when it inherited a better one. */
  inheritsFrom?: string;
}

/** An item kept out of the order for now, with the reason. */
export interface HeldIssue {
  /** Human key. */
  identifier: string;
  /** Title. */
  title: string;
  /** Why it waits: "held by DOR-12", "waits for project Billing", "PR cap". */
  reason: string;
}

/** An item that cannot rank until a person fills a field. */
export interface NeedsTriage {
  /** Human key. */
  identifier: string;
  /** Title. */
  title: string;
  /** What is missing: `priority`, `project`, `estimate`, `triage state`. */
  missing: string[];
}

/** An item already being worked on: shown, never re-ranked. */
export interface InFlight {
  /** Human key. */
  identifier: string;
  /** Title. */
  title: string;
  /** The tracker's state name, e.g. "In Review". */
  stateName: string;
  /** Account id of the assignee, when there is one. */
  assignee?: string;
}

/** A project as the project list shows it. */
export interface ProjectEntry {
  /** 1-based place inside its list ("now", "next" or "later"). */
  place: number;
  /** Tracker-native project id. */
  id: string;
  /** Project name. */
  name: string;
  /** Its status. */
  status: 'started' | 'planned' | 'paused' | 'backlog';
  /** One reason per key that decided its place. */
  why: OrderReason[];
  /** What a person should fix: "needs a priority", "needs a target date", "over cap", "can't start: waits on <P>". */
  flags: string[];
}

/** The ranked project lists. */
export interface ProjectRanking {
  /** Started projects, in rank: they feed the issue order. */
  now: ProjectEntry[];
  /** Planned projects, in rank: queued. */
  next: ProjectEntry[];
  /** Paused and Backlog projects, in rank: shown only with `--all`. */
  later: ProjectEntry[];
  /** Whole-list flags, e.g. "over cap: 9 Started, cap 6; lowest: P1, P2". */
  flags: string[];
  /**
   * Each listed project's rank for the issue order's project key: its place in
   * `now`, then `next`, then `later` read as one list (1 is best). A project
   * not listed has no rank and sorts after every ranked one.
   */
  rankOf: ReadonlyMap<string, number>;
}

/** The full answer to "what is next?". */
export interface WorkOrder {
  /** The `now` the caller passed, ISO-8601. Never read from a clock inside. */
  generatedAt: string;
  /** One-line notices printed above the order, e.g. "Urgent below pins: DOR-1, DOR-2". Display only. */
  banners: string[];
  /** The project lists. */
  projects: { now: ProjectEntry[]; next: ProjectEntry[]; later: ProjectEntry[]; flags: string[] };
  /** The issue order, best first. */
  issues: OrderedIssue[];
  /** Items being worked on now. */
  inFlight: InFlight[];
  /** Items kept out of the order, with reasons. */
  held: HeldIssue[];
  /** Items that need a person to fill a field before they can rank. */
  needsTriage: NeedsTriage[];
  /** Items labelled `owner/dorian`, or in such a project: out of the agent order. */
  dorian: { identifier: string; title: string }[];
}

/** The settings the work order reads, resolved from the flow config by {@link orderConfigOf}. */
export interface OrderConfig {
  /** `dispatch.orderKeys`: the in-band keys in precedence. */
  orderKeys: readonly OrderKey[];
  /** `dispatch.sizeOrder`: whether smaller or larger items go first in the size key. */
  sizeOrder: z.infer<typeof SizeOrderSchema>;
  /** `projects.startedCap`: how many projects may be Started at once. */
  startedCap: number;
}

/** What {@link computeWorkOrder} reads. */
export interface WorkOrderInput {
  /** Every open item of the team (the snapshot's `items`). */
  items: readonly WorkItem[];
  /** Every open project of the team (the snapshot's `projectInfo`). */
  projects: readonly ProjectInfo[];
  /** The resolved order settings. */
  config: OrderConfig;
  /** The moment to stamp the order with, ISO-8601. */
  now: string;
}

/**
 * Read the order settings out of a resolved flow config.
 *
 * @param config - The resolved flow config.
 * @returns The settings {@link computeWorkOrder} reads.
 */
export function orderConfigOf(config: FlowConfig): OrderConfig {
  return {
    orderKeys: config.dispatch.orderKeys,
    sizeOrder: config.dispatch.sizeOrder,
    startedCap: config.projects.startedCap,
  };
}

/**
 * Compute the work order: the project lists and the issue order, with a
 * reason per item and every item that does not rank listed with why.
 *
 * @param input - The open items, the open projects, the settings and the time.
 * @returns The work order.
 */
export function computeWorkOrder(input: WorkOrderInput): WorkOrder {
  void input;
  throw new Error('computeWorkOrder is not built yet (DOR-5063)');
}
