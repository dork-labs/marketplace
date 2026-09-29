/**
 * The file-backed `FlowRun` store (spec `flow-cli-core` §1.3):
 * `<main checkout>/.dork/flow/flow-state.json`, one file per project, shared by
 * every worktree of it.
 *
 * `<main checkout>` is the parent of `git rev-parse --git-common-dir`, so a
 * session in a linked worktree and one in the main checkout read and write the
 * same records.
 *
 * - **Reads take no lock** and fail soft ({@link parseFlowState}): `rename` is
 *   atomic, so a reader sees the old file or the new one. Unknown fields pass
 *   through, because `FlowRunSchema` is a `looseObject`.
 * - **Writes go through the shared lock-and-rename writer** (`atomic-json.ts`,
 *   lock at `flow-state.json.lock`), so two sessions writing different runs at
 *   once never lose each other's.
 * - **A write never replaces a file it could not read.** Before merging, the
 *   existing file is checked with {@link FlowStateSchema} (strict, not the
 *   fail-soft reader). A file that is present but not JSON, or fails the schema,
 *   makes the write throw a {@link ConfigError} naming it, and the file is left
 *   byte-for-byte alone. The fail-soft reader would read such a file as `{}`,
 *   and writing that back would delete every other in-flight run.
 *
 * The write helpers run against an in-memory {@link FlowStateStore} inside
 * the lock, with the reader and serializer in `flow-state.ts`, so the upsert
 * and update rules stay in one place. There is deliberately no plain `FlowStateStore` over the file: its
 * synchronous `write` could only replace the whole file without the lock, which
 * is exactly the lost-update this module exists to prevent.
 *
 * - **Every write stamps `updatedAt`** on the run it writes (spec
 *   `flow-multiproject` §6.3), with the store's clock, so a reader can tell a
 *   run that is still moving from one that went quiet.
 *
 * @module @dorkos/flow/flow-state-file
 */

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import {
  updateJsonFile,
  withHeldLock,
  type AtomicUpdateResult,
  type LockOptions,
  type HeldLockOptions,
  type HeldLockResult,
} from './atomic-json.ts';
import { ConfigError } from './errors.ts';
import { STATE_RELATIVE_PATH, resolveMainCheckout } from './main-checkout.ts';
import type { FlowRun, FlowRunStatus, FlowStage } from './flow-run.ts';
import {
  FlowStateSchema,
  parseFlowState,
  serializeFlowState,
  type FlowStateStore,
} from './flow-state.ts';

export { resolveMainCheckout };

/** Per-write options: lock tuning (the defaults are the contract values). */
export type FlowStateWriteOptions = LockOptions;

/** The run store for one project. */
export interface FlowStateFile {
  /** The absolute path of `flow-state.json`. */
  readonly path: string;
  /**
   * Read every run, without a lock. Missing, unparsable or schema-invalid files
   * read as `{}` (the fail-soft reader); unknown fields pass through.
   */
  read(): Record<string, FlowRun>;
  /** Insert or replace the run keyed by `run.issueId`. */
  upsertRun(run: FlowRun, options?: FlowStateWriteOptions): Promise<AtomicUpdateResult>;
  /** Delete the run for `issueId`; nothing happens when there is none. */
  removeRun(issueId: string, options?: FlowStateWriteOptions): Promise<AtomicUpdateResult>;
  /**
   * Set a run's status and optionally patch other fields; nothing happens when
   * there is no run for `issueId`.
   */
  setRunStatus(
    issueId: string,
    status: FlowRunStatus,
    patch?: Partial<FlowRun>,
    options?: FlowStateWriteOptions
  ): Promise<AtomicUpdateResult>;
  /**
   * Run `fn` holding the claim lock, `flow-state.json.claim.lock`, so two
   * claims on this machine run one after the other. It is not the store's own
   * lock: a claim holds it across slow tracker calls, and the store's writes
   * inside `fn` (and every other verb's) take the store lock only briefly.
   */
  withClaimLock<T>(fn: () => Promise<T>, options?: HeldLockOptions): Promise<HeldLockResult<T>>;

  /**
   * Replace a run with what `update` returns, inside the lock, so the update
   * sees the run as it is on disk at that moment; nothing happens when there is
   * no run for `issueId`. `update` must be pure: it can run on a retry.
   */
  updateRun(
    issueId: string,
    update: (run: FlowRun) => FlowRun,
    options?: FlowStateWriteOptions
  ): Promise<AtomicUpdateResult>;
  /** Set a run's stage, keeping its status; nothing happens when there is no run for `issueId`. */
  setRunStage(
    issueId: string,
    stage: FlowStage,
    options?: FlowStateWriteOptions
  ): Promise<AtomicUpdateResult>;
}

/** Whether two runs differ in nothing but `updatedAt`. */
function sameExceptStamp(a: FlowRun, b: FlowRun): boolean {
  const { updatedAt: _a, ...left } = a;
  const { updatedAt: _b, ...right } = b;
  return isDeepStrictEqual(left, right);
}

/**
 * Check the existing file before a write: missing is an empty store; anything
 * that fails {@link FlowStateSchema} is refused.
 *
 * @throws {ConfigError} Naming the file and the first problem.
 */
function validatedState(file: string, current: unknown): Record<string, FlowRun> {
  if (current === undefined) return {};
  const parsed = FlowStateSchema.safeParse(current);
  if (parsed.success) return parsed.data as Record<string, FlowRun>;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
  throw new ConfigError(
    `${file} is not a valid flow run store (${issue?.message ?? 'invalid'}${where}); flow did not change it. Fix or move the file, then retry.`
  );
}

/**
 * Run `apply` against the validated file contents under the lock. `apply` gets
 * an in-memory {@link FlowStateStore} and returns nothing; when it does not
 * write, the file is left untouched.
 */
function writeUnderLock(
  file: string,
  apply: (store: FlowStateStore) => void,
  options: FlowStateWriteOptions = {}
): Promise<AtomicUpdateResult> {
  return updateJsonFile(
    file,
    (current) => {
      const state = validatedState(file, current);
      let written: string | undefined;
      const store: FlowStateStore = {
        read: () => serializeFlowState(state),
        write: (contents) => {
          written = contents;
        },
      };
      apply(store);
      return written === undefined ? current : (JSON.parse(written) as unknown);
    },
    { ...options, onUnparsable: 'throw' }
  );
}

/** Options for {@link openFlowStateFile}. */
export interface FlowStateFileOptions {
  /** The clock that stamps `updatedAt` on every write. Default: the wall clock. */
  now?: () => Date;
}

/**
 * Open the run store of the project at `project` (any folder in its main
 * checkout or one of its linked worktrees).
 *
 * @param project - A folder inside the project's git checkout.
 * @param options - The clock that stamps `updatedAt`.
 * @returns The store; nothing is read or written until a method is called.
 * @throws {ConfigError} When `project` is not inside a git checkout.
 */
export function openFlowStateFile(
  project: string,
  options: FlowStateFileOptions = {}
): FlowStateFile {
  const file = path.join(resolveMainCheckout(project), STATE_RELATIVE_PATH);
  const clock = options.now ?? (() => new Date());
  /** The run as written now: `updatedAt` is the write time. */
  const stamped = (run: FlowRun): FlowRun => ({ ...run, updatedAt: clock().toISOString() });
  /**
   * Replace one run, unless nothing but its stamp would change: a write that
   * changes nothing leaves `updatedAt` (and the file) alone, so a run that is
   * only waiting never looks busy.
   */
  const put = (store: FlowStateStore, previous: FlowRun | undefined, next: FlowRun): void => {
    if (previous !== undefined && sameExceptStamp(previous, next)) return;
    const state = parseFlowState(store.read());
    state[next.issueId] = stamped(next);
    store.write(serializeFlowState(state));
  };
  return {
    path: file,
    read() {
      let raw: string | undefined;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        raw = undefined;
      }
      return parseFlowState(raw);
    },
    withClaimLock(fn, options) {
      return withHeldLock(`${file}.claim.lock`, fn, options);
    },
    upsertRun(run, options) {
      return writeUnderLock(
        file,
        (store) => put(store, parseFlowState(store.read())[run.issueId], run),
        options
      );
    },
    removeRun(issueId, options) {
      return writeUnderLock(
        file,
        (store) => {
          const state = parseFlowState(store.read());
          if (!Object.hasOwn(state, issueId)) return;
          delete state[issueId];
          store.write(serializeFlowState(state));
        },
        options
      );
    },
    setRunStatus(issueId, status, patch, options) {
      return writeUnderLock(
        file,
        (store) => {
          const existing = parseFlowState(store.read())[issueId];
          if (existing === undefined) return;
          put(store, existing, { ...existing, ...patch, issueId, status });
        },
        options
      );
    },
    updateRun(issueId, update, options) {
      return writeUnderLock(
        file,
        (store) => {
          const state = parseFlowState(store.read());
          const existing = state[issueId];
          if (existing === undefined) return;
          put(store, existing, { ...update(existing), issueId });
        },
        options
      );
    },
    setRunStage(issueId, stage, options) {
      return writeUnderLock(
        file,
        (store) => {
          const existing = parseFlowState(store.read())[issueId];
          if (existing === undefined) return;
          put(store, existing, { ...existing, stage });
        },
        options
      );
    },
  };
}
