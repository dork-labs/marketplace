/**
 * The OpenCode store reader (spec `flow-usage` Amendment 1, A1 and A3; DorkOS
 * ADR 260825-110420): where OpenCode keeps `opencode.db`, and the one read flow
 * makes of it.
 *
 * The live store is never opened. `opencode.db` and any `-wal`/`-shm` beside it
 * are copied into a fresh temp folder, the COPY is opened read-only with
 * `node:sqlite`, one fixed query runs ({@link OPENCODE_MESSAGE_QUERY}), and the
 * folder is deleted. The same file holds OpenCode's stored sign-ins; the fixed
 * query is what keeps them out of reach, and the compliance guard pins it.
 *
 * Of each message's `data` JSON only seven fields are kept: `role`, `providerID`,
 * `cost`, `time.created`, `time.completed`, `error.name` and `error.data.statusCode`. Everything
 * else is dropped as soon as a row is parsed.
 *
 * `node:sqlite` is loaded with a dynamic `import()`, so a Node without it (or
 * one that needs a flag for it) gets an `unavailable` answer instead of a crash,
 * and the rest of flow never loads it.
 *
 * @module @dorkos/flow/fleet/opencode-store
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The one statement flow ever runs against a copy of the OpenCode store. The
 * compliance guard (`engine-tests/usage/compliance-guard.test.ts`) pins it and
 * checks that nothing else is prepared.
 */
export const OPENCODE_MESSAGE_QUERY = 'SELECT data FROM message';

/** The fields flow keeps from one OpenCode message; everything else is dropped. */
export interface OpenCodeMessage {
  /** `role`: `assistant` or `user`, or `null` when missing. */
  role: string | null;
  /** `providerID` (`openrouter`, `ollama`, ...), or `null` when missing. */
  providerID: string | null;
  /** `cost` in dollars when it is a finite number of 0 or more, else `null`. */
  cost: number | null;
  /** `time.created` in epoch milliseconds, or `null` when missing. */
  createdMs: number | null;
  /**
   * `time.completed` in epoch milliseconds, or `null` while the turn is still
   * running. OpenCode fills in `cost` and `error` on the same row as the turn
   * goes, so this, not `created`, dates what the row finally says.
   */
  completedMs: number | null;
  /** `error.name` (`APIError`, ...), or `null` when the message has no error. */
  errorName: string | null;
  /** `error.data.statusCode`, or `null` when there is none. */
  errorStatus: number | null;
}

/** One prepared statement, as much of `node:sqlite`'s `StatementSync` as flow uses. */
export interface SqliteStatement {
  /** Run it and return every row. */
  all(): unknown[];
}

/** One open database, as much of `node:sqlite`'s `DatabaseSync` as flow uses. */
export interface SqliteDatabase {
  /** Prepare one statement. */
  prepare(sql: string): SqliteStatement;
  /** Close the connection. */
  close(): void;
}

/** As much of the `node:sqlite` module as flow uses. */
export interface SqliteModule {
  /** The synchronous database class. */
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDatabase;
}

/** Loads `node:sqlite`, or answers `null` when this Node cannot. */
export type SqliteLoader = () => Promise<SqliteModule | null>;

/** Whether `warning` is the ExperimentalWarning `node:sqlite` emits when it loads. */
function isSqliteExperimentalWarning(warning: unknown, rest: unknown[]): boolean {
  const first = rest[0];
  const type =
    typeof first === 'string'
      ? first
      : typeof first === 'object' && first !== null
        ? (first as { type?: unknown }).type
        : undefined;
  const name = warning instanceof Error ? warning.name : undefined;
  const text = warning instanceof Error ? warning.message : String(warning);
  return (type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /sqlite/i.test(text);
}

/**
 * Load `node:sqlite` with a dynamic `import()`. Its ExperimentalWarning is
 * suppressed for this import only: `process.emitWarning` is wrapped while the
 * import runs and restored after, and any other warning passes through.
 *
 * @returns The module, or `null` when this Node has no `node:sqlite` or needs a
 *   flag for it.
 */
export const loadNodeSqlite: SqliteLoader = async () => {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    const module = (await import('node:sqlite')) as unknown as Partial<SqliteModule>;
    return typeof module.DatabaseSync === 'function' ? (module as SqliteModule) : null;
  } catch {
    return null;
  } finally {
    process.emitWarning = original;
  }
};

/**
 * The folder OpenCode keeps its data in (spec A1, the same rule as DorkOS
 * `opencode-data-dir.ts`): `$XDG_DATA_HOME/opencode` when `XDG_DATA_HOME` is set
 * and non-empty, else `<os home>/.local/share/opencode`, on every platform.
 *
 * @param env - The environment.
 * @param osHome - The OS home folder.
 * @returns An absolute path. It may not exist.
 */
export function resolveOpenCodeDataDir(
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== '' ? xdg : path.join(osHome, '.local', 'share');
  return path.join(base, 'opencode');
}

/**
 * The OpenCode store file (spec A1): `OPENCODE_DB` when set and non-empty (an
 * absolute path as-is, else relative to the data folder; `:memory:` means no
 * file), else `opencode.db` in the data folder.
 *
 * @param env - The environment.
 * @param osHome - The OS home folder.
 * @returns The absolute store path, or `null` when OpenCode keeps no file. Not
 *   checked for existence.
 */
export function resolveOpenCodeStorePath(
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string | null {
  const override = env.OPENCODE_DB;
  if (override !== undefined && override !== '') {
    if (override === ':memory:') return null;
    return path.isAbsolute(override)
      ? override
      : path.join(resolveOpenCodeDataDir(env, osHome), override);
  }
  return path.join(resolveOpenCodeDataDir(env, osHome), 'opencode.db');
}

/** Whether `value` is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, else `null`. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A finite number, else `null`. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Keep only the seven allowed fields of one message (spec A3). Accepts the
 * parsed `data` object or its JSON text.
 *
 * @param data - A message's `data` column, or the message object itself.
 * @returns The kept fields, or `null` when `data` is not a JSON object.
 */
export function pickMessageFields(data: unknown): OpenCodeMessage | null {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isObject(value)) return null;
  const time = isObject(value.time) ? value.time : {};
  const error = isObject(value.error) ? value.error : null;
  const errorData = error !== null && isObject(error.data) ? error.data : {};
  const cost = finite(value.cost);
  return {
    role: text(value.role),
    providerID: text(value.providerID),
    cost: cost !== null && cost >= 0 ? cost : null,
    createdMs: finite(time.created),
    completedMs: finite(time.completed),
    errorName: error === null ? null : text(error.name),
    errorStatus: error === null ? null : finite(errorData.statusCode),
  };
}

/** What {@link readOpenCodeStore} found. */
export type OpenCodeStoreRead =
  | {
      /** The copy was read. */
      status: 'ok';
      /** Every message whose `data` parsed, reduced to the kept fields. */
      messages: OpenCodeMessage[];
      /** Rows whose `data` was not a JSON object. */
      skipped: number;
    }
  | {
      /** No store file: OpenCode never ran here, or it keeps no file. */
      status: 'missing';
    }
  | {
      /** This Node has no usable `node:sqlite`. */
      status: 'sqlite-unavailable';
    }
  | {
      /** The copy could not be made or read. */
      status: 'unreadable';
      /** What went wrong, for a warning. */
      reason: string;
    };

/** Options for {@link readOpenCodeStore}. */
export interface ReadStoreOptions {
  /** Loads `node:sqlite`. Default {@link loadNodeSqlite}; tests pass a spy. */
  loadSqlite?: SqliteLoader;
  /** Where the temp copy folder is made. Default the OS temp folder. */
  tempRoot?: string;
}

/**
 * Read every message of an OpenCode store from a throwaway copy (spec A3).
 *
 * 1. `node:sqlite` is loaded; without it nothing is copied.
 * 2. `storePath` and any `-wal`/`-shm` beside it are copied into a `mkdtemp`
 *    folder. The WAL matters: OpenCode runs in WAL mode, so its newest messages
 *    are in the log.
 * 3. The copy is opened with `readOnly: true`, {@link OPENCODE_MESSAGE_QUERY}
 *    runs once, and the connection is closed.
 * 4. The folder is deleted, whatever happened.
 *
 * @param storePath - The live store, or `null` when there is none. Copied, never opened.
 * @param options - The sqlite loader and temp root.
 * @returns The messages, or why there are none.
 */
export async function readOpenCodeStore(
  storePath: string | null,
  options: ReadStoreOptions = {}
): Promise<OpenCodeStoreRead> {
  if (storePath === null) return { status: 'missing' };
  const sqlite = await (options.loadSqlite ?? loadNodeSqlite)();
  if (sqlite === null) return { status: 'sqlite-unavailable' };

  const dir = mkdtempSync(path.join(options.tempRoot ?? tmpdir(), 'flow-opencode-'));
  try {
    const copy = path.join(dir, 'opencode.db');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        copyFileSync(`${storePath}${suffix}`, `${copy}${suffix}`);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A missing sibling is a checkpointed store; a missing main file is no store.
        if (code === 'ENOENT') {
          if (suffix === '') return { status: 'missing' };
          continue;
        }
        throw error;
      }
    }
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    let rows: unknown[];
    try {
      rows = db.prepare(OPENCODE_MESSAGE_QUERY).all();
    } finally {
      db.close();
    }
    const messages: OpenCodeMessage[] = [];
    let skipped = 0;
    for (const row of rows) {
      const picked = isObject(row) ? pickMessageFields(row.data) : null;
      if (picked === null) skipped += 1;
      else messages.push(picked);
    }
    return { status: 'ok', messages, skipped };
  } catch (error) {
    return {
      status: 'unreadable',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
