/**
 * The code-adapter types: what a tracker adapter's `adapter.ts` exports and what
 * the flow CLI hands it (spec `flow-cli-core` §4, adapter contract since 1.4.0, "The
 * code realization").
 *
 * An adapter's code lives in `adapter.ts` beside its `SKILL.md`. It exports
 * `CONTRACT_VERSION` and `createAdapter(ctx: AdapterContext): CodeAdapter`. The
 * CLI builds the {@link AdapterContext}: the merged config, the secrets, the
 * transport `connection.transport` picked, and a warning sink. The adapter owns
 * every tracker string; this file names none.
 *
 * Dependency-free: every import here is `import type` and is erased at run
 * time, so importing this module never reaches zod, even though `work-item.ts`
 * and `config-schema.ts` do.
 *
 * @module @dorkos/flow/tracker/types
 */

import type { FlowConfig } from '../config-schema.ts';
import type { StateCategory, WorkItem, WorkItemProject } from '../work-item.ts';
import type { WorkStateChange } from '../work-state.ts';

export type { WorkStateChange } from '../work-state.ts';

/** The outcome of one external command the transport ran. */
export interface TransportResult {
  /** The command's exit code. A non-zero exit resolves; it never rejects. */
  code: number;
  /** Everything the command wrote to stdout. */
  stdout: string;
  /** Everything the command wrote to stderr. */
  stderr: string;
}

/**
 * How an adapter reaches its tracker. Only `cli` exists: the CLI refuses the
 * `mcp` transport, which lives inside an agent session (spec Decision D3).
 */
export interface TrackerTransport {
  /** The transport kind, from `connection.transport`. */
  kind: 'cli';
  /**
   * Run an external command with no shell, so no argument can inject a
   * command. Rejects with a `TrackerError` when the command cannot start or
   * runs past its timeout.
   *
   * @param cmd - The executable. The adapter names it; the transport names no tool.
   * @param args - Its arguments, passed as an array.
   * @param opts - `timeoutMs` (default 60 000).
   */
  run(
    cmd: string,
    args: readonly string[],
    opts?: { timeoutMs?: number }
  ): Promise<TransportResult>;
}

/** The tracker credentials, split off the policy config (never inside it). */
export interface AdapterSecrets {
  /** The account or connection handle the adapter acts as. */
  trackerAccount?: string;
  /** The tracker API token, when the host does not handle auth. */
  trackerToken?: string;
}

/** Everything the CLI hands an adapter's `createAdapter`. */
export interface AdapterContext {
  /** The merged, validated flow config. */
  config: FlowConfig;
  /** The tracker credentials. Never print them. */
  secrets: AdapterSecrets;
  /** The transport `connection.transport` chose. */
  transport: TrackerTransport;
  /** Print a warning to stderr (both output modes). */
  warn(message: string): void;
}

/** A closed item as the snapshot carries it: enough to match duplicates and shipped work. */
export interface ClosedItem {
  /** Human key, for example `ABC-123`. */
  identifier: string;
  /** Item title. */
  title: string;
  /** Which terminal category it closed in. */
  stateCategory: 'completed' | 'canceled';
  /**
   * When it closed (ISO), when the tracker says. Optional: an adapter that
   * cannot tell leaves it out, and a reader treats an unknown date as recent
   * (the self-test's `--file` never refiles over a close it cannot date).
   */
  closedAt?: string;
}

/**
 * One pull of the configured team's backlog: the input to `flow next`, `flow
 * audit` and `flow status`, and what `flow snapshot --json` prints.
 */
export interface BacklogSnapshot {
  /** Shape version. */
  v: 1;
  /** The configured tracker (the adapter slug). */
  tracker: string;
  /** The team the pull was scoped to. */
  team: { key: string | null; id: string | null };
  /** When the pull finished, ISO-8601 UTC. */
  fetchedAt: string;
  /** Every OPEN item of the team, fully normalized. */
  items: WorkItem[];
  /** Closed items as titles; empty unless `includeClosed` was asked for. */
  closed: ClosedItem[];
  /** Only the projects the items reference, with their state category when known. */
  projects: WorkItemProject[];
}

/** One comment on an item, oldest first in any list. */
export interface ItemComment {
  /** Tracker-native comment id. */
  id: string;
  /** Account id of the author, or `''` when the tracker gives none (never a guess). */
  author: string;
  /** The comment text. */
  body: string;
  /** When it was made, ISO-8601 with an explicit zone. */
  createdAt: string;
}

/** The five {@link CodeAdapter} methods. A verb checks the ones it needs before it runs. */
export type Capability =
  'getCurrentUser' | 'getBacklogSnapshot' | 'getItem' | 'applyWorkState' | 'comment';

/** Every {@link Capability}, in declaration order. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  'getCurrentUser',
  'getBacklogSnapshot',
  'getItem',
  'applyWorkState',
  'comment',
];

/** The account the adapter acts as. */
export interface TrackerAccount {
  /** Tracker-native account id. */
  id: string;
  /** Display name, when the tracker gives one. */
  name?: string;
}

/** A work item read on its own, optionally with its latest comments. */
export type ItemWithComments = WorkItem & {
  /** The latest comments, oldest first, when asked for. */
  comments?: ItemComment[];
};

/**
 * The code realization of the adapter contract (since contract 1.4.0). An
 * adapter lists the methods it implements in `capabilities`; a verb that needs
 * one it lacks exits 3 naming it.
 *
 * Every read that cannot reach the tracker throws; it never returns empty
 * (contract section 3). Every write that fails throws; it never reports
 * success.
 */
export interface CodeAdapter {
  /** The methods this adapter implements. */
  capabilities: readonly Capability[];
  /** The account the adapter acts as. */
  getCurrentUser(): Promise<TrackerAccount>;
  /**
   * One pull of the configured team's backlog: every open item, fully
   * normalized, plus closed titles when `includeClosed` is set.
   */
  getBacklogSnapshot(opts?: { includeClosed?: boolean }): Promise<BacklogSnapshot>;
  /**
   * One item by its human key, with its latest `comments` when asked. Throws a
   * `PreconditionError` when the item does not exist or belongs to another team.
   */
  getItem(identifier: string, opts?: { comments?: number }): Promise<ItemWithComments>;
  /**
   * Apply one work-state change (spec §5 projections). Computes the label set
   * from a read taken immediately before the write, never from `item`, and
   * writes labels and state in one tracker write where the tracker allows it
   * (else labels first).
   */
  applyWorkState(item: WorkItem, change: WorkStateChange): Promise<void>;
  /** Post a comment. The caller has already signed the body. */
  comment(item: WorkItem, body: string): Promise<void>;
}

/** What an adapter's `adapter.ts` module exports. */
export interface CodeAdapterModule {
  /** The adapter contract version the code targets, for example `2.1.0`. */
  CONTRACT_VERSION: string;
  /** Build the adapter for one run. */
  createAdapter(ctx: AdapterContext): CodeAdapter;
}

/** Re-exported so an adapter can name the category type without reaching zod. */
export type { StateCategory, WorkItem, WorkItemProject };
