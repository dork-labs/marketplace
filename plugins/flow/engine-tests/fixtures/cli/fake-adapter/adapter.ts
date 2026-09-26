/**
 * A file-based fake tracker adapter for the `flow` CLI tests (spec
 * `flow-cli-core` Testing Strategy).
 *
 * It is a real code adapter in the contract's shape (`CONTRACT_VERSION` plus
 * `createAdapter`), so the loader finds and imports it exactly as it would a
 * project's own. Tests place this folder at `.agents/flow/adapters/fake/` in a
 * temp project by SYMLINK, so its relative imports still resolve.
 *
 * Its tracker is an in-memory {@link FakeBacklog}:
 *
 * - In-process tests call {@link createFakeAdapter} with a backlog and read the
 *   recorded `calls` and the live `backlog` afterwards.
 * - A spawned `flow` process reaches it through the loader's `createAdapter`,
 *   which re-reads the backlog from the JSON file named by `FLOW_FAKE_BACKLOG`
 *   on every call and writes every change back to that file, so the test can
 *   inspect it and two processes see each other's writes, as with a real
 *   tracker. `getItemDelayMs` holds each `getItem` answer back, widening the
 *   window a race between two processes needs.
 *
 * Two switches simulate a misbehaving tracker: `failReads` makes every read
 * throw a plain `Error` (the loader must map it to exit 4), and `dropWrites`
 * makes `applyWorkState` report success without changing anything (the CLI's
 * read-back must catch it).
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { PreconditionError } from '../../../../scripts/errors.ts';
import type {
  AdapterContext,
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
} from '../../../../scripts/tracker/types.ts';
import { labelsAfterChange } from '../../../../scripts/work-state.ts';

/** The contract version this fake targets. */
export const CONTRACT_VERSION = '2.0.0';

/** The environment variable naming the backlog file a spawned run reads and writes. */
export const FAKE_BACKLOG_ENV = 'FLOW_FAKE_BACKLOG';

/** The fake tracker's whole state. */
export interface FakeBacklog {
  /** The tracker slug the snapshot reports. Default `fake`. */
  tracker?: string;
  /** The team the snapshot reports. */
  team?: { key: string | null; id: string | null };
  /** The capabilities to declare. Default: all five. */
  capabilities?: Capability[];
  /** The account `getCurrentUser` returns. */
  user?: TrackerAccount;
  /** Open items. */
  items: WorkItem[];
  /** Closed items, returned only when `includeClosed` is asked for. */
  closed?: ClosedItem[];
  /** Projects the items reference. */
  projects?: WorkItemProject[];
  /** Comments per item identifier, oldest first. */
  comments?: Record<string, ItemComment[]>;
  /** When set, every read throws a plain `Error` with this message. */
  failReads?: string;
  /** When true, `applyWorkState` records the call but changes nothing. */
  dropWrites?: boolean;
  /**
   * File-backed only: wait this many ms after reading, before `getItem`
   * answers; a record gives the wait per identifier (others answer at once).
   */
  getItemDelayMs?: number | Record<string, number>;
}

/** One recorded write. */
export type FakeCall =
  | { method: 'applyWorkState'; identifier: string; change: WorkStateChange }
  | { method: 'comment'; identifier: string; body: string };

/** What {@link createFakeAdapter} returns. */
export interface FakeTracker {
  /** The adapter. */
  adapter: CodeAdapter;
  /** The live state; writes change it. */
  backlog: FakeBacklog;
  /** Every write, in order. */
  calls: FakeCall[];
}

const ALL: Capability[] = [
  'getCurrentUser',
  'getBacklogSnapshot',
  'getItem',
  'applyWorkState',
  'comment',
];

/**
 * Build a fake adapter over an in-memory backlog.
 *
 * @param backlog - The tracker's state. It is changed in place by writes.
 * @param opts - `persist` is called with the backlog after every write; `now`
 *   stamps snapshots and comments.
 * @returns The adapter, the live backlog and the recorded calls.
 */
export function createFakeAdapter(
  backlog: FakeBacklog,
  opts: { persist?: (backlog: FakeBacklog) => void; now?: () => Date } = {}
): FakeTracker {
  const calls: FakeCall[] = [];
  const now = opts.now ?? (() => new Date('2026-09-26T12:00:00.000Z'));
  const persist = () => opts.persist?.(backlog);

  const read = () => {
    if (backlog.failReads !== undefined) throw new Error(backlog.failReads);
  };
  const find = (identifier: string): WorkItem => {
    const item = backlog.items.find((candidate) => candidate.identifier === identifier);
    if (item === undefined) throw new PreconditionError(`${identifier} was not found`);
    return item;
  };

  const adapter: CodeAdapter = {
    capabilities: backlog.capabilities ?? ALL,
    async getCurrentUser() {
      read();
      return backlog.user ?? { id: 'agent-1', name: 'Fake agent' };
    },
    async getBacklogSnapshot(options = {}): Promise<BacklogSnapshot> {
      read();
      return {
        v: 1,
        tracker: backlog.tracker ?? 'fake',
        team: backlog.team ?? { key: 'FAKE', id: 'team-1' },
        fetchedAt: now().toISOString(),
        items: structuredClone(backlog.items),
        closed: options.includeClosed ? structuredClone(backlog.closed ?? []) : [],
        projects: structuredClone(backlog.projects ?? []),
      };
    },
    async getItem(identifier, options = {}): Promise<ItemWithComments> {
      read();
      const item: ItemWithComments = structuredClone(find(identifier));
      if (options.comments !== undefined && options.comments > 0) {
        item.comments = structuredClone(
          (backlog.comments?.[identifier] ?? []).slice(-options.comments)
        );
      }
      return item;
    },
    async applyWorkState(item, change) {
      calls.push({ method: 'applyWorkState', identifier: item.identifier, change: { ...change } });
      const current = find(item.identifier);
      if (backlog.dropWrites) return;
      current.labels = labelsAfterChange(current.labels, change);
      if (change.stateCategory !== undefined) {
        current.stateCategory = change.stateCategory;
        current.stateName = change.stateCategory;
      }
      persist();
    },
    async comment(item, body) {
      calls.push({ method: 'comment', identifier: item.identifier, body });
      find(item.identifier);
      const list = ((backlog.comments ??= {})[item.identifier] ??= []);
      list.push({
        id: `comment-${list.length + 1}`,
        author: (backlog.user ?? { id: 'agent-1' }).id,
        body,
        createdAt: now().toISOString(),
      });
      persist();
    },
  };
  return { adapter, backlog, calls };
}

/**
 * The contract's factory. Re-reads the backlog from the file `FLOW_FAKE_BACKLOG`
 * names on every call (an empty backlog when unset) and writes every change
 * back to it.
 *
 * @param _ctx - The CLI's context; the fake needs none of it.
 * @returns The adapter.
 */
export function createAdapter(_ctx: AdapterContext): CodeAdapter {
  const file = process.env[FAKE_BACKLOG_ENV];
  if (file === undefined || file === '') return createFakeAdapter({ items: [] }).adapter;
  const load = (): FakeBacklog => JSON.parse(readFileSync(file, 'utf8')) as FakeBacklog;
  const persist = (state: FakeBacklog) =>
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  const fresh = (backlog: FakeBacklog = load()) => createFakeAdapter(backlog, { persist }).adapter;
  return {
    capabilities: load().capabilities ?? ALL,
    getCurrentUser: () => fresh().getCurrentUser(),
    getBacklogSnapshot: (options) => fresh().getBacklogSnapshot(options),
    async getItem(identifier, options) {
      const backlog = load();
      const item = await fresh(backlog).getItem(identifier, options);
      const wait = backlog.getItemDelayMs;
      const delay = typeof wait === 'number' ? wait : (wait?.[identifier] ?? 0);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return item;
    },
    applyWorkState: (item, change) => fresh().applyWorkState(item, change),
    comment: (item, body) => fresh().comment(item, body),
  };
}
