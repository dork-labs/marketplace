/**
 * The fake tracker: an in-memory tracker behind the code-adapter contract
 * (adapter contract 2.1.0), for flow's self-test scenarios and live evals
 * (spec `specs/flow-self-improvement` §1, DOR-2390).
 *
 * It is not a mock that says yes. Where flow depends on how a real tracker
 * behaves, it behaves like the Linear adapter does against recorded Linear
 * answers, and `engine-tests/code-adapter-contract.test.ts` runs one contract
 * suite against both to keep it that way:
 *
 * - A write computes the label set from the tracker's current labels (never
 *   from the caller's copy), replaces only the families the change names, and
 *   keeps every other label. A state-only change keeps every label.
 * - Moving to a category picks that category's first state by position; an
 *   item already in the category keeps its state (In Review stays In Review).
 *   Display names are a team's (Triage, Todo, In Progress), never the category.
 * - A change the tracker already matches writes nothing.
 * - A label the team does not have is refused, and nothing is written.
 * - An item that does not exist, or belongs to another team, is a
 *   `PreconditionError` (exit 5).
 * - The snapshot holds open items only; closed ones appear as titles when
 *   asked, including items a write or a merged PR closed.
 * - A merged PR whose body says `Closes <id>` closes the item, as trackers
 *   linked to a forge do. Labels are left alone.
 *
 * Time comes from an injected clock, never `Date.now()`. Dependency-free.
 *
 * @module @dorkos/flow/tracker/fake
 */

import { PreconditionError, TrackerError } from '../errors.ts';
import { labelsAfterChange } from '../work-state.ts';
import type {
  BacklogSnapshot,
  Capability,
  ClosedItem,
  CodeAdapter,
  ItemComment,
  ItemWithComments,
  TrackerAccount,
  WorkItem,
  WorkItemProject,
  WorkStateChange,
} from './types.ts';
import { ALL_CAPABILITIES } from './types.ts';

/** The adapter contract version the fake implements. */
export const FAKE_CONTRACT_VERSION = '2.1.0';

/** The environment variable naming the JSON file a spawned run's fake tracker reads and writes. */
export const FAKE_BACKLOG_ENV = 'FLOW_FAKE_BACKLOG';

/** The five state categories. */
type Category = WorkItem['stateCategory'];

/** One workflow state of the fake team. */
export interface FakeState {
  /** Display name, for example `In Progress`. */
  name: string;
  /** The category it belongs to. */
  category: Category;
  /** Sort order within the team; the lowest of a category is where a move lands. */
  position: number;
}

/**
 * The fake team's states: the recorded Linear team's, with `Triage` in the
 * backlog category (the Linear adapter maps triage to backlog) and no
 * `Duplicate` state (the adapter cannot represent it).
 */
export const FAKE_STATES: readonly FakeState[] = [
  { name: 'Triage', category: 'backlog', position: -1 },
  { name: 'Backlog', category: 'backlog', position: 0 },
  { name: 'Todo', category: 'unstarted', position: 1 },
  { name: 'In Progress', category: 'started', position: 2 },
  { name: 'In Review', category: 'started', position: 1002 },
  { name: 'Done', category: 'completed', position: 3 },
  { name: 'Canceled', category: 'canceled', position: 4 },
];

/**
 * The fake team's labels: the generic families flow uses, as the recorded
 * Linear team has them. A seeded item's own labels are added to these.
 */
export const FAKE_TEAM_LABELS: readonly string[] = [
  'agent/ready',
  'agent/claimed',
  'agent/completed',
  'agent/needs-input',
  ...['capture', 'triage', 'ideate', 'specify', 'decompose', 'execute', 'verify', 'done'].map(
    (stage) => `stage/${stage}`
  ),
  ...['idea', 'research', 'hypothesis', 'task', 'monitor', 'signal', 'meta'].map(
    (type) => `type/${type}`
  ),
  'origin/human',
  'origin/from-agent',
  'origin/from-signal',
];

/**
 * The fake tracker's whole state, as a JSON file holds it. The shape is a
 * superset of the CLI tests' fixture fake, so a backlog file written for that
 * fake reads here. (Not the reverse: this one keeps closed items in `items`.)
 */
export interface FakeBacklog {
  /** The tracker slug the snapshot reports. Default `fake`. */
  tracker?: string;
  /** The team. Items outside it are refused. Default `{ key: 'FAKE', id: 'team-fake' }`. */
  team?: { key: string | null; id: string | null };
  /** The capabilities to declare. Default: all five. */
  capabilities?: Capability[];
  /** The account the adapter acts as. */
  user?: TrackerAccount;
  /** Every item the tracker holds, open or closed. */
  items: WorkItem[];
  /** Closed items known only by title (seeded history). */
  closed?: ClosedItem[];
  /** When each closed item in `items` closed (ISO), by identifier; the fake records it on every close. */
  closedAt?: Record<string, string>;
  /** Projects the items may reference. */
  projects?: WorkItemProject[];
  /** Comments per item identifier, oldest first. */
  comments?: Record<string, ItemComment[]>;
  /** The team's labels beyond {@link FAKE_TEAM_LABELS}. */
  labels?: string[];
  /** When set, every read throws a plain `Error` with this message (an unreachable tracker). */
  failReads?: string;
  /** When true, writes report success and change nothing (a tracker that drops writes). */
  dropWrites?: boolean;
}

/** One write the tracker accepted, in order. */
export type FakeWrite =
  | { method: 'applyWorkState'; identifier: string; change: WorkStateChange }
  | { method: 'comment'; identifier: string; author: string; body: string }
  | { method: 'mergePr'; identifier: string };

/** How a {@link FakeTracker} is built. */
export interface FakeTrackerOptions {
  /** The clock. Default: a fixed instant, so runs are reproducible. */
  now?: () => Date;
  /** Called with the backlog after every write (a spawned run saves its file here). */
  persist?: (backlog: FakeBacklog) => void;
}

/** The default account the adapter acts as. */
const DEFAULT_USER: TrackerAccount = { id: 'user-flow-agent', name: 'Flow agent' };

/** A fixed default instant. */
const DEFAULT_NOW = (): Date => new Date('2026-09-26T12:00:00.000Z');

/** Whether a category is open. */
function isOpen(category: Category): boolean {
  return category === 'backlog' || category === 'unstarted' || category === 'started';
}

/** The dispositions an `agent/*` label names. */
const DISPOSITIONS = new Set(['ready', 'claimed', 'completed', 'needs-input']);

/**
 * An item as a read returns it: a copy whose `agentDisposition` is derived from
 * its `agent/*` label, as the Linear adapter derives it on every read (a write
 * changes labels, never the stored disposition).
 *
 * @param item - The stored item.
 * @returns A normalized copy.
 */
function view(item: WorkItem): WorkItem {
  const copy = structuredClone(item);
  const agent = copy.labels.find((label) => label.startsWith('agent/'))?.slice('agent/'.length);
  if (agent !== undefined && DISPOSITIONS.has(agent)) {
    copy.agentDisposition = agent as WorkItem['agentDisposition'];
  } else {
    delete copy.agentDisposition;
  }
  return copy;
}

/**
 * The state a move into `category` lands on: that category's lowest position,
 * as the Linear adapter picks it (never `Triage`, which is not a move target).
 *
 * @param category - The target category.
 * @returns The state.
 */
export function landingState(category: Category): FakeState {
  const states = FAKE_STATES.filter((state) => state.category === category).filter(
    (state) => state.name !== 'Triage'
  );
  return [...states].sort((a, b) => a.position - b.position)[0];
}

/**
 * An in-memory tracker with a code adapter over it.
 *
 * Tests and the scenario runner drive it in process: they seed a backlog,
 * hand {@link FakeTracker.adapter} to the code under test, and read the live
 * {@link FakeTracker.backlog} and {@link FakeTracker.writes} afterwards.
 */
export class FakeTracker {
  /** The live state. Writes change it in place. */
  readonly backlog: FakeBacklog;
  /** Every write the tracker accepted, in order. */
  readonly writes: FakeWrite[] = [];
  /** The code adapter over this tracker. */
  readonly adapter: CodeAdapter;

  private readonly now: () => Date;
  private readonly persist: (backlog: FakeBacklog) => void;

  /**
   * @param backlog - The tracker's state; changed in place by writes.
   * @param options - The clock and the persistence hook.
   */
  constructor(backlog: FakeBacklog, options: FakeTrackerOptions = {}) {
    this.backlog = backlog;
    this.now = options.now ?? DEFAULT_NOW;
    this.persist = options.persist ?? (() => undefined);
    this.adapter = this.buildAdapter();
  }

  /** The team the tracker scopes every item to. */
  get team(): { key: string | null; id: string | null } {
    return this.backlog.team ?? { key: 'FAKE', id: 'team-fake' };
  }

  /** The account the adapter acts as. */
  get user(): TrackerAccount {
    return this.backlog.user ?? DEFAULT_USER;
  }

  /**
   * A person comments on an item (the adapter's own comments go through
   * `adapter.comment`).
   *
   * @param identifier - The item.
   * @param author - The commenting account's id.
   * @param body - The text.
   * @returns The stored comment.
   */
  addComment(identifier: string, author: string, body: string): ItemComment {
    this.find(identifier);
    const list = ((this.backlog.comments ??= {})[identifier] ??= []);
    const comment: ItemComment = {
      id: `comment-${identifier}-${list.length + 1}`,
      author,
      body,
      createdAt: this.now().toISOString(),
    };
    list.push(comment);
    this.writes.push({ method: 'comment', identifier, author, body });
    this.persist(this.backlog);
    return comment;
  }

  /**
   * A pull request merges. Every item of this team its body closes with
   * `Closes <id>` (also `Fixes`/`Resolves`) moves to Done; its labels are left
   * as they are, since a forge integration changes state only.
   *
   * @param pr - The merged PR's body.
   * @returns The identifiers it closed.
   */
  mergePr(pr: { body: string }): string[] {
    const closed: string[] = [];
    for (const match of pr.body.matchAll(
      /\b(?:closes|fixes|resolves)\s+([A-Z][A-Z0-9]*-\d+)\b/gi
    )) {
      const item = this.backlog.items.find((candidate) => candidate.identifier === match[1]);
      if (item === undefined || !isOpen(item.stateCategory)) continue;
      const done = landingState('completed');
      item.stateCategory = done.category;
      item.stateName = done.name;
      this.recordClose(item);
      closed.push(item.identifier);
      this.writes.push({ method: 'mergePr', identifier: item.identifier });
    }
    if (closed.length > 0) this.persist(this.backlog);
    return closed;
  }

  /** Record when an item closed, or forget it when the item is open again. */
  private recordClose(item: WorkItem): void {
    const dates = (this.backlog.closedAt ??= {});
    if (isOpen(item.stateCategory)) delete dates[item.identifier];
    else dates[item.identifier] = this.now().toISOString();
  }

  /** Throw when reads are switched off (an unreachable tracker). */
  private read(): void {
    if (this.backlog.failReads !== undefined) throw new Error(this.backlog.failReads);
  }

  /** Whether an identifier is this team's. */
  private ownId(identifier: string): boolean {
    const key = this.team.key;
    return key === null || identifier.startsWith(`${key}-`);
  }

  /**
   * The stored item, refusing another team's with a `PreconditionError`. A
   * missing item is a `PreconditionError` on a read and a `TrackerError` on a
   * write, as the Linear adapter reports them (its write paths do not map
   * Linear's "Entity not found").
   */
  private find(identifier: string, use: 'read' | 'write' = 'read'): WorkItem {
    const item = this.backlog.items.find((candidate) => candidate.identifier === identifier);
    if (item === undefined) {
      if (use === 'write') {
        throw new TrackerError(`the tracker could not find ${identifier} to write to`);
      }
      throw new PreconditionError(`${identifier} was not found`);
    }
    if (!this.ownId(identifier)) {
      throw new PreconditionError(
        `${identifier} belongs to another team, not ${this.team.key}; flow only acts on its own team`
      );
    }
    return item;
  }

  /** The labels the team has: the generic families plus `backlog.labels`, never an item's own. */
  private teamLabels(): Set<string> {
    return new Set([...FAKE_TEAM_LABELS, ...(this.backlog.labels ?? [])]);
  }

  /** The adapter, as a plain object with the five methods. */
  private buildAdapter(): CodeAdapter {
    return {
      capabilities: this.backlog.capabilities ?? [...ALL_CAPABILITIES],
      getCurrentUser: async () => {
        this.read();
        return { ...this.user };
      },
      getBacklogSnapshot: async (opts = {}) => {
        this.read();
        return this.snapshot(opts.includeClosed === true);
      },
      getItem: async (identifier, opts = {}) => {
        this.read();
        const item: ItemWithComments = view(this.find(identifier));
        if (opts.comments !== undefined && opts.comments > 0) {
          item.comments = structuredClone(
            (this.backlog.comments?.[identifier] ?? []).slice(-opts.comments)
          );
        }
        return item;
      },
      applyWorkState: async (item, change) => this.applyWorkState(item, change),
      comment: async (item, body) => {
        this.read();
        this.find(item.identifier, 'write');
        if (this.backlog.dropWrites) return;
        this.addComment(item.identifier, this.user.id, body);
      },
    };
  }

  /** One pull of the team's backlog. */
  private snapshot(includeClosed: boolean): BacklogSnapshot {
    const own = this.backlog.items.filter((item) => this.ownId(item.identifier));
    const open = own.filter((item) => isOpen(item.stateCategory));
    const closedNow: ClosedItem[] = own
      .filter((item) => !isOpen(item.stateCategory))
      .map((item) => {
        const closedAt = this.backlog.closedAt?.[item.identifier];
        return {
          identifier: item.identifier,
          title: item.title,
          stateCategory: item.stateCategory as 'completed' | 'canceled',
          ...(closedAt === undefined ? {} : { closedAt }),
        };
      });
    const referenced = new Set(open.flatMap((item) => (item.project ? [item.project.id] : [])));
    return {
      v: 1,
      tracker: this.backlog.tracker ?? 'fake',
      team: { ...this.team },
      fetchedAt: this.now().toISOString(),
      items: open.map(view),
      closed: includeClosed ? structuredClone([...(this.backlog.closed ?? []), ...closedNow]) : [],
      projects: structuredClone(
        (this.backlog.projects ?? []).filter((project) => referenced.has(project.id))
      ),
    };
  }

  /**
   * Apply one work-state change from the tracker's current state (never the
   * caller's copy of the item).
   */
  private applyWorkState(item: WorkItem, change: WorkStateChange): void {
    this.read();
    const current = this.find(item.identifier, 'write');
    const next = labelsAfterChange(current.labels, change);
    const known = this.teamLabels();
    // Only a label this change ADDS must be the team's: an item keeps whatever it
    // already carries, as the Linear adapter keeps an issue's own labels.
    const unknown = next.find((label) => !known.has(label) && !current.labels.includes(label));
    if (unknown !== undefined) {
      throw new TrackerError(
        `the ${this.team.key ?? 'fake'} team has no "${unknown}" label; create it in the tracker (flow never creates labels)`
      );
    }
    const moves =
      change.stateCategory !== undefined && change.stateCategory !== current.stateCategory;
    const sameLabels =
      next.length === current.labels.length &&
      next.every((label) => current.labels.includes(label));
    if (sameLabels && !moves) return;
    if (this.backlog.dropWrites) return;
    current.labels = next;
    if (moves && change.stateCategory !== undefined) {
      const state = landingState(change.stateCategory);
      current.stateCategory = state.category;
      current.stateName = state.name;
      this.recordClose(current);
    }
    this.writes.push({
      method: 'applyWorkState',
      identifier: current.identifier,
      change: { ...change },
    });
    this.persist(this.backlog);
  }
}
