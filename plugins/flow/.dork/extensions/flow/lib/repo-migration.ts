/**
 * The record of moving "Only for these repos" into DorkOS (spec
 * `flow-multiproject` §8.5, A9): which project roots each account's repos
 * became, and which repos were not on this computer yet, so a later visit to
 * Settings → Flow adds them once they are.
 *
 * The move itself runs in the person's browser, because DorkOS's account rules
 * are changed only by a person. The record lives here, in the extension's
 * storage behind a person-only route, rather than in the browser's own
 * `saveData`: that writes the same stored value this server half keeps its
 * other keys in, and the two would overwrite each other.
 *
 * @module @dorkos/flow/extension/repo-migration
 */

import { RouteError } from './fleet.ts';
import type { SharedStorage } from './shared-storage.ts';

/** The storage key. */
export const REPO_MIGRATION_KEY = 'repoMigration';

/** One account's move. */
export interface AccountMove {
  /** The project roots its repos became in DorkOS. */
  movedRoots: string[];
  /** Its `owner/name` repos not on this computer yet. */
  pendingRepos: string[];
  /** When it last changed, ISO. */
  at: string;
  /**
   * DorkOS's rule is set, but flow's own repo list is kept too until every
   * project runs a flow that honours DorkOS's rule (both apply meanwhile).
   */
  held?: boolean;
}

/** The record, by the account's `fleet.json` key. */
export interface RepoMigration {
  /** Each account moved, by `<runtime>:<id>`. */
  accounts: Record<string, AccountMove>;
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list of non-empty strings, or `null`. */
function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '')
    ? [...(value as string[])]
    : null;
}

/**
 * Read a record, leniently: anything that is not one reads as empty.
 *
 * @param value - A stored or sent value.
 * @returns The record, or `null` when it is not one.
 */
export function parseRepoMigration(value: unknown): RepoMigration | null {
  if (!isObject(value) || !isObject(value.accounts)) return null;
  const accounts: Record<string, AccountMove> = {};
  for (const [key, move] of Object.entries(value.accounts)) {
    if (!isObject(move)) return null;
    const movedRoots = strings(move.movedRoots);
    const pendingRepos = strings(move.pendingRepos);
    if (movedRoots === null || pendingRepos === null || typeof move.at !== 'string') return null;
    if (move.held !== undefined && typeof move.held !== 'boolean') return null;
    accounts[key] = {
      movedRoots,
      pendingRepos,
      at: move.at,
      ...(move.held === undefined ? {} : { held: move.held }),
    };
  }
  return { accounts };
}

/**
 * The stored record.
 *
 * @param storage - The extension's storage.
 * @returns The record (empty when none).
 */
export async function readRepoMigration(
  storage: Pick<SharedStorage, 'get'>
): Promise<RepoMigration> {
  return parseRepoMigration(await storage.get(REPO_MIGRATION_KEY)) ?? { accounts: {} };
}

/**
 * Replace the stored record. Called only from the person-only route.
 *
 * @param storage - The extension's storage.
 * @param body - The new record.
 * @returns The record as stored.
 * @throws {RouteError} 400 when it is not a record.
 */
export async function writeRepoMigration(
  storage: Pick<SharedStorage, 'set'>,
  body: unknown
): Promise<RepoMigration> {
  const record = parseRepoMigration(body);
  if (record === null) throw new RouteError(400, 'Send the record of what moved.');
  await storage.set(REPO_MIGRATION_KEY, record);
  return record;
}
