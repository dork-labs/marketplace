/**
 * The extension's zod-free view of flow's run store (spec `flow-cli-core`
 * §1.3): `<main checkout>/.dork/flow/flow-state.json`.
 *
 * flow's own `flow-state-file.ts` validates the whole store with zod before a
 * write. This extension is bundled by DorkOS, which installs no packages for
 * it, so it reads the file loosely and writes through flow's shared
 * lock-and-rename writer (`atomic-json.ts`), changing only the one run it
 * holds and refusing a file that is not a JSON object of run records. Every
 * other run, and every field this module does not know, is written back as it
 * was read.
 *
 * @module @dorkos/flow/extension/run-store
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { readJsonFile, updateJsonFile } from '../../../../scripts/atomic-json.ts';
import { ConfigError, PreconditionError } from '../../../../scripts/errors.ts';
import { STATE_RELATIVE_PATH, resolveMainCheckout } from '../../../../scripts/main-checkout.ts';

/** How long an advisor write waits for the store's lock: under DorkOS's 2 s bound. */
export const ADVISOR_LOCK_GIVE_UP_MS = 1_500;

/** The fields of a stored run this extension reads. Everything else passes through. */
export interface StoredRun {
  /** The run's key in the store. */
  issueId: string;
  /** The tracker item's human key, such as `ACME-12`. */
  identifier: string;
  /** The session the run is on now (`""` when unknown). */
  sessionId: string;
  /** The run's worktree. */
  worktreePath: string;
  /** The run's branch. */
  branch: string;
  /** The account the current session bills. */
  account?: string;
  /** The runtime the current session runs on. */
  runtime?: string;
  /** The drain's state, while `flow drain` carries the run. */
  drain?: { v?: number; rev?: number; [key: string]: unknown };
  /** The limit episode, when there is one. */
  limit?: Record<string, unknown> & { state?: string; resetsAt?: string | null };
  /** Unknown fields pass through. */
  [key: string]: unknown;
}

/** A flow run found for a session, and where its store is. */
export interface FoundRun {
  /** The project's main checkout. */
  mainCheckout: string;
  /** The run. */
  run: StoredRun;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a stored value has the fields this module needs to treat it as a run. */
function isRun(value: unknown): value is StoredRun {
  return (
    isObject(value) &&
    typeof value.issueId === 'string' &&
    typeof value.identifier === 'string' &&
    typeof value.sessionId === 'string'
  );
}

/**
 * The store's path for a main checkout.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns `<mainCheckout>/.dork/flow/flow-state.json`.
 */
export function flowStatePath(mainCheckout: string): string {
  return path.join(mainCheckout, STATE_RELATIVE_PATH);
}

/**
 * The main checkout of the folder `cwd` is in, or `null` when it is not in a
 * git checkout (flow's own `resolveMainCheckout`, the rule DorkOS D8 uses).
 *
 * @param cwd - Any folder.
 * @returns The main checkout, or `null`.
 */
export function mainCheckoutOf(cwd: string): string | null {
  try {
    return resolveMainCheckout(cwd);
  } catch {
    return null;
  }
}

/**
 * Every run in a store, read without a lock. A missing or unreadable file, and
 * any record without an issue id, identifier and session id, read as absent.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The runs by issue id.
 */
export function readRuns(mainCheckout: string): Record<string, StoredRun> {
  const { value } = readJsonFile(flowStatePath(mainCheckout));
  const runs: Record<string, StoredRun> = {};
  if (!isObject(value)) return runs;
  for (const [key, run] of Object.entries(value)) {
    if (isRun(run)) runs[key] = run;
  }
  return runs;
}

/**
 * The store's modification time in ms, or `null` when there is no file.
 *
 * @param mainCheckout - The project's main checkout.
 * @returns The mtime, or `null`.
 */
export function storeMtime(mainCheckout: string): number | null {
  try {
    return statSync(flowStatePath(mainCheckout)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The flow run a session is on: the run in its project's store whose
 * `sessionId` is this session's. A session with no git checkout, no store, or
 * no matching run is not a flow run.
 *
 * @param cwd - The session's working directory.
 * @param sessionId - The session's id.
 * @returns The run and its main checkout, or `null`.
 */
export function findFlowRun(cwd: string, sessionId: string | undefined): FoundRun | null {
  if (sessionId === undefined || sessionId === '') return null;
  const mainCheckout = mainCheckoutOf(cwd);
  if (mainCheckout === null) return null;
  const run = Object.values(readRuns(mainCheckout)).find((r) => r.sessionId === sessionId);
  return run === undefined ? null : { mainCheckout, run };
}

/** A person's hold on a run, as flow's `flow handoff --wait` writes it (§5.2a). */
export interface RunHold {
  /** Until when the hold lasts (ISO); `null` means until the account's own reset. */
  heldUntil: string | null;
  /** Whether flow may resume the run on its own account at the reset. */
  resumeOnReset: boolean;
}

/**
 * Hold a run on its own account for a person, under the store's lock: the
 * limit reads `waiting-reset` with `heldBy: "person"` and `heldUntil`, exactly
 * the fields flow's handoff reducer honours (`flow handoff --wait`), and the
 * drain's `wakeAfter` moves to the hold's end. `resumeOnReset: false` keeps
 * the run held, neither resumed nor moved, until a person acts; `true`
 * resumes it once its account clears. A run flow has not yet seen limited gets a
 * limit episode here, so the hold has something to attach to. Compare-and-set
 * on the session read, as flow's own hold is.
 *
 * @param found - The run, as read.
 * @param hold - The hold.
 * @param now - The clock.
 * @throws {PreconditionError} When the run moved on, is being handed off, or the lock never freed.
 * @throws {ConfigError} When the store is not a JSON object of runs.
 */
export async function holdRun(found: FoundRun, hold: RunHold, now: Date): Promise<void> {
  const { mainCheckout, run: read } = found;
  const file = flowStatePath(mainCheckout);
  let why = '';
  const result = await updateJsonFile(
    file,
    (current) => {
      why = '';
      if (!isObject(current)) {
        throw new ConfigError(
          `${file} is not a flow run store; flow did not change it. Fix or move the file, then retry.`
        );
      }
      const run = current[read.issueId];
      if (!isRun(run) || run.sessionId !== read.sessionId) {
        why = 'another session took the run over since it was read';
        return current;
      }
      if (run.limit?.state === 'handing-off') {
        why = 'a handoff of it is in progress';
        return current;
      }
      const limit = isObject(run.limit)
        ? { ...run.limit }
        : {
            level: 'exhausted',
            account: run.account ?? null,
            window: null,
            resetsAt: hold.heldUntil,
            cause: 'limit',
            since: now.toISOString(),
            handoffToken: null,
            handingOffAt: null,
            handoffSessionId: null,
            notifiedAt: null,
          };
      const next: StoredRun = {
        ...run,
        limit: {
          ...limit,
          state: 'waiting-reset',
          heldBy: 'person',
          heldUntil: hold.heldUntil,
          resumeOnReset: hold.resumeOnReset,
        },
      };
      if (isObject(run.drain) && run.drain.v === 1) {
        const rev = typeof run.drain.rev === 'number' ? run.drain.rev : 0;
        const resetsAt = typeof limit.resetsAt === 'string' ? limit.resetsAt : null;
        next.drain = { ...run.drain, wakeAfter: hold.heldUntil ?? resetsAt, rev: rev + 1 };
      }
      return { ...current, [read.issueId]: next };
    },
    { onUnparsable: 'throw', giveUpMs: ADVISOR_LOCK_GIVE_UP_MS }
  );
  if (result.status === 'dropped') {
    throw new PreconditionError(
      result.warnings[0]?.message ?? `Could not lock ${file}; nothing was changed.`
    );
  }
  if (why !== '') throw new PreconditionError(`${read.identifier} was not held: ${why}`);
}
