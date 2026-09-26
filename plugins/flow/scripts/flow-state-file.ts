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
 * The write helpers run the existing store helpers in `flow-state.ts`
 * ({@link writeFlowRun}, {@link updateFlowRunStatus}) against an in-memory
 * {@link FlowStateStore} inside the lock, so the upsert and update rules stay in
 * one place. There is deliberately no plain `FlowStateStore` over the file: its
 * synchronous `write` could only replace the whole file without the lock, which
 * is exactly the lost-update this module exists to prevent.
 *
 * @module @dorkos/flow/flow-state-file
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  updateJsonFile,
  withFileLock,
  type AtomicUpdateResult,
  type LockOptions,
  type WithFileLockOptions,
  type WithFileLockResult,
} from './atomic-json.ts';
import { ConfigError } from './errors.ts';
import type { FlowRun, FlowRunStatus, FlowStage } from './flow-run.ts';
import {
  FlowStateSchema,
  parseFlowState,
  serializeFlowState,
  updateFlowRunStatus,
  writeFlowRun,
  type FlowStateStore,
} from './flow-state.ts';

/** Where the store lives inside the main checkout. */
const STATE_RELATIVE_PATH = path.join('.dork', 'flow', 'flow-state.json');

/**
 * The main checkout of the git checkout at `project`: the parent of
 * `git rev-parse --git-common-dir` (asked for as an absolute path, git 2.31 or
 * later, so a subfolder resolves the same as the checkout root). From a linked
 * worktree this is the main checkout, not the worktree.
 *
 * @param project - Any folder inside a git checkout (main or linked worktree).
 * @returns The absolute path of the main checkout.
 * @throws {ConfigError} When `project` is not inside a git checkout.
 */
export function resolveMainCheckout(project: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new ConfigError(
      `${project} is not inside a git checkout, so flow cannot find its run store. Run flow from the project's checkout or pass --project.`
    );
  }
  return path.dirname(path.resolve(project, commonDir));
}

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
   * Run `fn` holding the store's lock, so a check and the run written after it
   * see no other writer in between. The store's writes inside `fn` reuse the
   * held lock (see `withFileLock` in `atomic-json.ts`).
   */
  withLock<T>(fn: () => Promise<T>, options?: WithFileLockOptions): Promise<WithFileLockResult<T>>;
  /** Set a run's stage, keeping its status; nothing happens when there is no run for `issueId`. */
  setRunStage(
    issueId: string,
    stage: FlowStage,
    options?: FlowStateWriteOptions
  ): Promise<AtomicUpdateResult>;
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

/**
 * Open the run store of the project at `project` (any folder in its main
 * checkout or one of its linked worktrees).
 *
 * @param project - A folder inside the project's git checkout.
 * @returns The store; nothing is read or written until a method is called.
 * @throws {ConfigError} When `project` is not inside a git checkout.
 */
export function openFlowStateFile(project: string): FlowStateFile {
  const file = path.join(resolveMainCheckout(project), STATE_RELATIVE_PATH);
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
    withLock(fn, options) {
      return withFileLock(file, fn, options);
    },
    upsertRun(run, options) {
      return writeUnderLock(file, (store) => writeFlowRun(store, run), options);
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
        (store) => updateFlowRunStatus(store, issueId, status, patch),
        options
      );
    },
    setRunStage(issueId, stage, options) {
      return writeUnderLock(
        file,
        (store) => {
          const existing = parseFlowState(store.read())[issueId];
          if (existing === undefined) return;
          updateFlowRunStatus(store, issueId, existing.status, { stage });
        },
        options
      );
    },
  };
}
