/**
 * OpenCode usage (spec `flow-usage` Amendment 1, A3, A4 and A8; task 4.2):
 * `flow usage scan --runtime opencode` reads a COPY of a real SQLite store built
 * here with `node:sqlite`, and `flow usage record --runtime opencode` takes one
 * message on stdin.
 *
 * The store is kept in WAL mode with its writer open, the way a running
 * OpenCode leaves it, so the newest rows exist only in the `-wal` file. It also
 * holds a decoy `credential` table that the reader must never reach.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedArgs } from '../../scripts/cli/args.ts';
import { createVerbContext } from '../../scripts/cli/context.ts';
import type { HostIo } from '../../scripts/cli/host-io.ts';
import {
  openCodeErrorObservations,
  openCodeSpend,
  scanOpenCode,
  type OpenCodeAccountScan,
} from '../../scripts/cli/usage-opencode.ts';
import {
  OPENCODE_MESSAGE_QUERY,
  pickMessageFields,
  readOpenCodeStore,
  resolveOpenCodeStorePath,
  type SqliteModule,
} from '../../scripts/fleet/opencode-store.ts';
import { ledgerPath, mergeLedger } from '../../scripts/fleet/usage-ledger.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOW_ROOT = path.resolve(here, '..', '..');

/** The clock of every September run: after every fixture message. */
const NOW = new Date('2026-09-20T00:00:00.000Z');

let root: string;
let dorkHome: string;
let osHome: string;
let xdg: string;
let live: string;
let writer: DatabaseSync | undefined;
let nextId = 0;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-usage-opencode-'));
  dorkHome = path.join(root, 'dork');
  osHome = path.join(root, 'home');
  xdg = path.join(root, 'xdg');
  live = path.join(xdg, 'opencode', 'opencode.db');
  mkdirSync(dorkHome, { recursive: true });
  mkdirSync(osHome, { recursive: true });
  mkdirSync(path.dirname(live), { recursive: true });
  nextId = 0;
});

afterEach(() => {
  writer?.close();
  writer = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Create the live store: OpenCode's `message` table, WAL mode, and a decoy `credential` row. */
function createStore(): DatabaseSync {
  writer = new DatabaseSync(live);
  writer.exec('PRAGMA journal_mode = WAL');
  writer.exec(
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)'
  );
  writer.exec('CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  writer.prepare('INSERT INTO credential VALUES (?, ?)').run('openrouter', 'sk-or-DECOY-SECRET');
  return writer;
}

/** Insert one message the way OpenCode stores it. */
function insert(data: Record<string, unknown>): void {
  const created = (data.time as { created: number }).created;
  nextId += 1;
  (writer ?? createStore())
    .prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
    .run(`msg_${nextId}`, 'ses_1', created, created, JSON.stringify(data));
}

/** An assistant message from `providerID` at `when`, with an optional API error. */
function assistant(providerID: string, when: string, cost: number, statusCode?: number) {
  return {
    id: `msg_${nextId + 1}`,
    sessionID: 'ses_1',
    role: 'assistant',
    providerID,
    modelID: 'some-model',
    cost,
    tokens: { input: 10, output: 20 },
    path: { cwd: '/tmp/project', root: '/tmp/project' },
    time: { created: Date.parse(when), completed: Date.parse(when) + 1000 },
    ...(statusCode === undefined
      ? {}
      : {
          error: {
            name: 'APIError',
            data: { message: 'provider said no', statusCode, isRetryable: false },
          },
        }),
  };
}

/** The September story: last month's spend, an OpenRouter 402, an ollama success, a 429. */
function seedSeptember(): void {
  createStore();
  insert(assistant('openrouter', '2026-08-15T12:00:00.000Z', 5)); // last month: not counted
  insert(assistant('openrouter', '2026-09-02T10:00:00.000Z', 0.5));
  insert(assistant('openrouter', '2026-09-03T10:00:00.000Z', 0, 402));
  insert(assistant('ollama', '2026-09-04T10:00:00.000Z', 0)); // must not clear the 402
  insert(assistant('anthropic', '2026-09-05T10:00:00.000Z', 1.25, 429));
  insert({
    role: 'user',
    time: { created: Date.parse('2026-09-05T11:00:00.000Z') },
    cost: 99,
  }); // a user message never counts
}

/** A string sink. */
function sink() {
  let buffer = '';
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

/** The deps every `main` run sees. */
function deps(now: Date, io: Partial<HostIo> = {}) {
  const stdout = sink();
  const stderr = sink();
  const value: MainDeps = {
    env: { DORK_HOME: dorkHome, XDG_DATA_HOME: xdg },
    cwd: root,
    now: () => now,
    stdout,
    stderr,
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: FLOW_ROOT,
    io: { osHome, ...io },
  };
  return { value, stdout, stderr };
}

/** Run `flow usage scan --runtime opencode --json` and return the payload. */
async function scan(now = NOW, extra: string[] = []) {
  const d = deps(now);
  const code = await main(['usage', 'scan', '--runtime', 'opencode', '--json', ...extra], d.value);
  expect(code, d.stderr.text()).toBe(0);
  return JSON.parse(d.stdout.text()) as {
    runtime: string;
    accounts: OpenCodeAccountScan[];
    warnings: { code: string; message: string }[];
  };
}

/** Run `flow usage record --runtime opencode` with `input` on stdin. */
async function record(input: string | null, now = NOW) {
  const armWatchdog = vi.fn();
  const d = deps(now, { stdin: { isTTY: false, read: async () => input }, armWatchdog });
  const code = await main(['usage', 'record', '--runtime', 'opencode'], d.value);
  return { code, stdout: d.stdout.text(), stderr: d.stderr.text(), armWatchdog };
}

function ledgerFile(): string {
  return ledgerPath(dorkHome, 'opencode', 'default');
}

function ledger(): {
  windows: Record<string, Record<string, unknown>>;
  spend?: Record<string, unknown>;
} {
  return JSON.parse(readFileSync(ledgerFile(), 'utf8'));
}

/** `node:sqlite` wrapped so every open and statement is logged. */
function spySqlite() {
  const calls: { op: string; file?: string; options?: unknown; sql?: string }[] = [];
  class SpyDatabase {
    private readonly db: DatabaseSync;
    constructor(file: string, options: { readOnly: boolean }) {
      calls.push({ op: 'open', file, options });
      this.db = new DatabaseSync(file, options);
    }
    prepare(sql: string) {
      calls.push({ op: 'prepare', sql });
      return this.db.prepare(sql);
    }
    close() {
      calls.push({ op: 'close' });
      this.db.close();
    }
  }
  const module: SqliteModule = { DatabaseSync: SpyDatabase };
  return { calls, load: async () => module };
}

/** A verb context for `scanOpenCode`, so a test can inject the sqlite loader. */
function context(flags: Record<string, string | true> = {}) {
  const args: ParsedArgs = {
    verb: 'usage',
    positionals: ['scan'],
    flags: { runtime: 'opencode', ...flags },
    json: true,
  };
  const warnings: string[] = [];
  const ctx = createVerbContext(args, deps(NOW).value, FLOW_ROOT, (m) => warnings.push(m));
  return { ctx, warnings };
}

describe('the OpenCode store reader', () => {
  it('opens only a read-only copy, runs the one query, keeps seven fields and deletes the copy', async () => {
    // Purpose: DorkOS ADR 260825-110420 and spec A3. The live store (which holds
    // sign-ins) is never opened, the only statement is the allowlisted one, the
    // decoy credential never comes back, and no copy is left behind.
    seedSeptember();
    const spy = spySqlite();
    const read = await readOpenCodeStore(live, { loadSqlite: spy.load });

    expect(spy.calls.map((c) => c.op)).toEqual(['open', 'prepare', 'close']);
    const [open, prepare] = spy.calls;
    expect(prepare?.sql).toBe('SELECT data FROM message');
    expect(open?.options).toEqual({ readOnly: true });
    expect(open?.file).not.toBe(live);
    expect(path.dirname(open?.file ?? '')).not.toBe(path.dirname(live));
    expect(path.basename(open?.file ?? '')).toBe('opencode.db');
    expect(existsSync(path.dirname(open?.file ?? live))).toBe(false);

    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    // Every row lives only in the WAL (the writer is still open): the -wal was copied.
    expect(read.messages).toHaveLength(6);
    for (const message of read.messages) {
      expect(Object.keys(message).sort()).toEqual([
        'completedMs',
        'cost',
        'createdMs',
        'errorName',
        'errorStatus',
        'providerID',
        'role',
      ]);
    }
    expect(JSON.stringify(read)).not.toContain('DECOY');
  });

  it('answers missing for no store file and for OPENCODE_DB=:memory:, without loading sqlite', async () => {
    // Purpose: A1. OpenCode never having run is not an error, and `:memory:` means no file.
    const load = vi.fn();
    expect(await readOpenCodeStore(live, { loadSqlite: spySqlite().load })).toEqual({
      status: 'missing',
    });
    expect(await readOpenCodeStore(null, { loadSqlite: load })).toEqual({ status: 'missing' });
    expect(load).not.toHaveBeenCalled();
  });

  it('resolves the store as DorkOS does', () => {
    // Purpose: A1, the same rule as DorkOS opencode-data-dir.ts.
    expect(resolveOpenCodeStorePath({}, '/h')).toBe('/h/.local/share/opencode/opencode.db');
    expect(resolveOpenCodeStorePath({ XDG_DATA_HOME: '' }, '/h')).toBe(
      '/h/.local/share/opencode/opencode.db'
    );
    expect(resolveOpenCodeStorePath({ XDG_DATA_HOME: '/x' }, '/h')).toBe('/x/opencode/opencode.db');
    expect(resolveOpenCodeStorePath({ OPENCODE_DB: 'dev.db' }, '/h')).toBe(
      '/h/.local/share/opencode/dev.db'
    );
    expect(resolveOpenCodeStorePath({ OPENCODE_DB: '/abs/o.db' }, '/h')).toBe('/abs/o.db');
    expect(resolveOpenCodeStorePath({ OPENCODE_DB: ':memory:' }, '/h')).toBeNull();
  });

  it('keeps only the allowed fields of a message', () => {
    // Purpose: A3's field allowlist; nothing else of `data` survives parsing.
    const picked = pickMessageFields(
      JSON.stringify({ ...assistant('openrouter', '2026-09-01T00:00:00Z', 0.1, 402), secret: 'x' })
    );
    expect(picked).toEqual({
      role: 'assistant',
      providerID: 'openrouter',
      cost: 0.1,
      createdMs: Date.parse('2026-09-01T00:00:00Z'),
      completedMs: Date.parse('2026-09-01T00:00:00Z') + 1000,
      errorName: 'APIError',
      errorStatus: 402,
    });
    expect(pickMessageFields('not json')).toBeNull();
  });
});

describe('flow usage scan --runtime opencode', () => {
  it('records this month’s total spend and each provider’s error, and splits spend per provider in the output', async () => {
    // Purpose: A3. August is not counted, the ledger holds the total, the split
    // is output only, the 402 survives the ollama success, and the 429 lands.
    seedSeptember();
    const out = await scan();
    expect(out.runtime).toBe('opencode');
    const [account] = out.accounts;
    expect(account).toMatchObject({ id: 'default', store: live, status: 'read', messages: 6 });
    expect(account?.spend).toEqual({
      periodStart: '2026-09-01T00:00:00.000Z',
      costUsd: 1.75,
      providers: [
        { provider: 'anthropic', costUsd: 1.25, messages: 1 },
        { provider: 'openrouter', costUsd: 0.5, messages: 2 },
        { provider: 'ollama', costUsd: 0, messages: 1 },
      ],
    });

    const stored = ledger();
    expect(stored.spend).toEqual({
      periodStart: '2026-09-01T00:00:00.000Z',
      costUsd: 1.75,
      limitUsd: null,
      // The newest message's completion (fixtures complete 1 s after they start).
      observedAt: '2026-09-05T10:00:01.000Z',
      source: 'transcript',
    });
    // The ledger holds the total only; the per-provider split is output.
    expect(Object.keys(stored).sort()).toEqual([
      'accountId',
      'runtime',
      'spend',
      'updatedAt',
      'v',
      'windows',
    ]);
    const err = (status: string, at: string) => ({
      usedPct: null,
      resetsAt: null,
      status,
      observedAt: at,
      source: 'error',
    });
    expect(stored.windows).toEqual({
      'credits:openrouter': err('rejected', '2026-09-03T10:00:01.000Z'),
      'credits:ollama': err('allowed', '2026-09-04T10:00:01.000Z'),
      'rate_limit:ollama': err('allowed', '2026-09-04T10:00:01.000Z'),
      'rate_limit:anthropic': err('rejected', '2026-09-05T10:00:01.000Z'),
    });

    // A later OpenRouter success clears its 402 and adds to spend.
    insert(assistant('openrouter', '2026-09-06T10:00:00.000Z', 0.25));
    const again = await scan();
    expect(again.accounts[0]?.changed.sort()).toEqual([
      'credits:openrouter',
      'rate_limit:openrouter',
      'spend',
    ]);
    const after = ledger();
    expect(after.windows['credits:openrouter']).toEqual(err('allowed', '2026-09-06T10:00:01.000Z'));
    expect(after.windows['rate_limit:anthropic']?.status).toBe('rejected');
    expect(after.spend).toMatchObject({ costUsd: 2, observedAt: '2026-09-06T10:00:01.000Z' });
  });

  it('shows the per-provider split in the text output', async () => {
    // Purpose: A3, the split appears in scan's text as well as --json.
    seedSeptember();
    const d = deps(NOW);
    expect(await main(['usage', 'scan', '--runtime', 'opencode'], d.value)).toBe(0);
    const text = d.stdout.text();
    expect(text).toContain('default: 6 messages read');
    expect(text).toContain('spend since 2026-09-01: $1.75  recorded');
    expect(text).toMatch(/anthropic {2}\$1\.25 \(1 message\)/);
    expect(text).toMatch(/openrouter {2}\$0\.50 \(2 messages\)/);
    expect(text).toContain('credits:openrouter  rejected, recorded');
  });

  it('records $0 at the month start in a month with no messages, and a rerun leaves the file byte-identical', async () => {
    // Purpose: A3. Last month's total is replaced by this month's 0, observed at
    // periodStart, so a later rerun that month changes nothing.
    seedSeptember();
    await scan();
    await scan(new Date('2026-10-02T00:00:00.000Z'));
    expect(ledger().spend).toEqual({
      periodStart: '2026-10-01T00:00:00.000Z',
      costUsd: 0,
      limitUsd: null,
      observedAt: '2026-10-01T00:00:00.000Z',
      source: 'transcript',
    });
    const bytes = readFileSync(ledgerFile(), 'utf8');
    const rerun = await scan(new Date('2026-10-03T08:00:00.000Z'));
    expect(rerun.accounts[0]?.changed).toEqual([]);
    expect(readFileSync(ledgerFile(), 'utf8')).toBe(bytes);
  });

  it('with --dry-run reports what it would record and writes nothing', async () => {
    // Purpose: scan's --dry-run holds for OpenCode too.
    seedSeptember();
    const out = await scan(NOW, ['--dry-run']);
    expect(out.accounts[0]?.changed).toContain('spend');
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('warns once and records nothing when node:sqlite is unavailable', async () => {
    // Purpose: A3. A Node without node:sqlite (or behind a flag) is a warning, not a crash.
    seedSeptember();
    const { ctx, warnings } = context();
    const result = await scanOpenCode(ctx, { loadSqlite: async () => null });
    expect(result.json).toMatchObject({
      accounts: [{ id: 'default', status: 'sqlite-unavailable' }],
      warnings: [{ code: 'sqlite-unavailable' }],
    });
    expect(warnings).toHaveLength(1);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('never opens the live store on the scan path', async () => {
    // Purpose: A3 through the verb, not only the reader.
    seedSeptember();
    const spy = spySqlite();
    const { ctx } = context();
    await scanOpenCode(ctx, { loadSqlite: spy.load });
    const opened = spy.calls.filter((c) => c.op === 'open').map((c) => c.file);
    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toBe(live);
    expect(spy.calls.filter((c) => c.op === 'prepare').map((c) => c.sql)).toEqual([
      OPENCODE_MESSAGE_QUERY,
    ]);
  });

  it('says so when there is no store, and records nothing', async () => {
    // Purpose: OpenCode never ran here: not an error.
    const out = await scan();
    expect(out.accounts[0]).toMatchObject({ status: 'missing', store: live });
    expect(out.warnings).toEqual([]);
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('refuses --days with --runtime opencode', async () => {
    // Purpose: the store is read whole; a transcript flag must not look like it did something.
    const d = deps(NOW);
    expect(await main(['usage', 'scan', '--runtime', 'opencode', '--days', '3'], d.value)).toBe(2);
  });
});

describe('the OpenCode error rule', () => {
  const msg = (
    providerID: string,
    at: string,
    errorName: string | null,
    status: number | null
  ) => ({
    role: 'assistant',
    providerID,
    cost: 0,
    createdMs: Date.parse(at),
    completedMs: null,
    errorName,
    errorStatus: status,
  });

  it('lets a later scan of the same row win once it completes with an error and its full cost', () => {
    // Purpose: OpenCode writes cost and a 429 onto the row it created first; dating by
    // creation would tie the second scan with the first and drop the 429 and the cost.
    const now = new Date('2026-09-10T12:00:00.000Z');
    const created = Date.parse('2026-09-10T11:00:00.000Z');
    const running = {
      role: 'assistant',
      providerID: 'openrouter',
      cost: 0.1,
      createdMs: created,
      completedMs: null,
      errorName: null,
      errorStatus: null,
    };
    const done = {
      ...running,
      cost: 0.4,
      completedMs: created + 90_000,
      errorName: 'APIError',
      errorStatus: 429,
    };
    const first = mergeLedger(
      undefined,
      [...openCodeErrorObservations([running]), openCodeSpend([running], now).fact],
      now,
      { runtime: 'opencode', accountId: 'default' }
    );
    const second = mergeLedger(
      first.ledger,
      [...openCodeErrorObservations([done]), openCodeSpend([done], now).fact],
      now,
      { runtime: 'opencode', accountId: 'default' }
    );
    expect(second.changed).toBe(true);
    const ledger = second.ledger as {
      windows: Record<string, { status: string }>;
      spend: { costUsd: number };
    };
    expect(ledger.windows['rate_limit:openrouter'].status).toBe('rejected');
    expect(ledger.spend.costUsd).toBe(0.4);
  });

  it('records nothing for a provider whose newest message has another error', () => {
    // Purpose: B3. Only 402 and 429 are about usage; a 500 neither sets nor clears.
    const out = openCodeErrorObservations([
      msg('openrouter', '2026-09-01T00:00:00Z', null, null),
      msg('openrouter', '2026-09-02T00:00:00Z', 'APIError', 500),
      msg('ollama', '2026-09-02T00:00:00Z', 'MessageAbortedError', null),
    ]);
    expect(out).toEqual([]);
  });

  it('slugs the provider by the model-slug rule', () => {
    // Purpose: A3, the key uses bucketSlug.
    const out = openCodeErrorObservations([
      msg('My Provider', '2026-09-01T00:00:00Z', 'APIError', 429),
    ]);
    expect(out.map((o) => o.key)).toEqual(['rate_limit:my-provider']);
  });
});

describe('flow usage record --runtime opencode', () => {
  it('updates only that provider’s error keys, prints nothing and exits 0', async () => {
    // Purpose: A4. One message changes its own provider's keys and nothing else,
    // not even spend, and the hook contract (silence, exit 0, watchdog) holds.
    seedSeptember();
    await scan();
    const before = ledger();

    const result = await record(
      JSON.stringify(assistant('anthropic', '2026-09-19T10:00:00.000Z', 3))
    );
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.armWatchdog).toHaveBeenCalledWith(3000);

    const after = ledger();
    expect(after.spend).toEqual(before.spend);
    expect(after.windows['rate_limit:anthropic']?.status).toBe('allowed');
    expect(after.windows['credits:anthropic']?.status).toBe('allowed');
    for (const key of ['credits:openrouter', 'credits:ollama', 'rate_limit:ollama']) {
      expect(after.windows[key]).toEqual(before.windows[key]);
    }
  });

  it('records a 402 from stdin', async () => {
    // Purpose: A4, the rejected path through record.
    const result = await record(
      JSON.stringify(assistant('openrouter', '2026-09-19T10:00:00.000Z', 0, 402))
    );
    expect(result.code).toBe(0);
    expect(ledger().windows).toEqual({
      'credits:openrouter': {
        usedPct: null,
        resetsAt: null,
        status: 'rejected',
        observedAt: '2026-09-19T10:00:01.000Z',
        source: 'error',
      },
    });
  });

  it('stays silent and writes nothing for input that is not a message', async () => {
    // Purpose: §2.1's silence rules apply to every runtime.
    for (const input of ['not json', '[]', JSON.stringify({ role: 'user' }), null]) {
      const result = await record(input);
      expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    }
    expect(existsSync(ledgerFile())).toBe(false);
  });
});

describe('fixture sanity', () => {
  it('the decoy credential row exists in the live store', () => {
    // Purpose: the "never reached" assertions above mean something only if the decoy is there.
    seedSeptember();
    const row = writer?.prepare('SELECT value FROM credential').get() as { value: string };
    expect(row.value).toBe('sk-or-DECOY-SECRET');
  });
});
