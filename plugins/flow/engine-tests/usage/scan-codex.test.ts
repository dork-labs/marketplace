/**
 * `flow usage scan --runtime codex` (spec `flow-usage` Amendment 1, A2; task
 * 4.1): recover the latest Codex usage from the session logs under a Codex
 * home into the Codex usage ledger, idempotently.
 *
 * Every case drives `main(argv, deps)` against a temp `DORK_HOME` and a temp
 * `CODEX_HOME` holding the made-up rollout fixtures, so no test touches the real
 * home folder.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main, type MainDeps } from '../../scripts/flow.ts';
import { ledgerPath } from '../../scripts/fleet/usage-ledger.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', 'fixtures', 'usage', 'codex');

/** The clock every run sees: after every fixture reading. */
const NOW = new Date('2026-09-26T20:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let dorkHome: string;
let osHome: string;
let codexHome: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-usage-scan-codex-'));
  dorkHome = path.join(root, 'dork');
  osHome = path.join(root, 'home');
  codexHome = path.join(root, 'codex-home');
  mkdirSync(dorkHome, { recursive: true });
  mkdirSync(osHome, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Copy a fixture under `<codexHome>/<rel>` and date its mtime `ageDays` before {@link NOW}. */
function place(fixture: string, rel: string, ageDays = 0.1, home = codexHome): string {
  const target = path.join(home, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(FIXTURES, fixture), target);
  const when = new Date(NOW.getTime() - ageDays * DAY_MS);
  utimesSync(target, when, when);
  return target;
}

/** The two fixtures where Codex keeps them: a live session and an archived one 20 days old. */
function placeBoth(): void {
  place('rollout-pro.jsonl', 'sessions/2026/09/26/rollout-2026-09-26T19-00-00-0199aaaa.jsonl');
  place(
    'rollout-archived-plus.jsonl',
    'archived_sessions/rollout-2026-09-01T08-00-00-0199bbbb.jsonl',
    20
  );
}

/** Run `flow <argv>` with a temp home. */
async function flow(argv: string[], env: Record<string, string> = { CODEX_HOME: codexHome }) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome, ...env },
    cwd: root,
    now: () => NOW,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: path.resolve(here, '..', '..'),
    io: { osHome },
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

interface ScanJson {
  runtime: string;
  days: number | 'all';
  accounts: {
    id: string;
    home: string;
    files: number;
    readings: number;
    observations: Record<string, unknown>[];
    changed: string[];
    dropped: boolean;
  }[];
  warnings: { code: string; message: string }[];
}

/** Run a Codex scan with `--json` and return the parsed payload. */
async function scanJson(extra: string[] = []): Promise<ScanJson> {
  const run = await flow(['usage', 'scan', '--runtime', 'codex', '--json', ...extra]);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as ScanJson;
}

const ledgerFile = () => ledgerPath(dorkHome, 'codex', 'default');
const readLedgerFile = () => JSON.parse(readFileSync(ledgerFile(), 'utf8'));

describe('flow usage scan --runtime codex', () => {
  it('records the newest reading per window, keeps the Spark limit apart, and skips decoys', async () => {
    // Purpose: the main limit lands in five_hour and seven_day, the
    // interleaved GPT-5.3-Codex-Spark limit lands only in its model bucket (it
    // is newer, so letting it through would overwrite seven_day), and lines
    // that carry rate_limits outside a token_count event never count.
    placeBoth();
    const out = await scanJson();
    expect(out).toMatchObject({ runtime: 'codex', days: 8 });
    expect(out.accounts).toHaveLength(1);
    const [account] = out.accounts;
    expect(account).toMatchObject({ id: 'default', home: codexHome, files: 1, readings: 4 });
    expect(account.changed).toEqual([
      'credits',
      'five_hour',
      'model:gpt-5.3-codex-spark',
      'plan',
      'seven_day',
    ]);
    expect(out.warnings.map((warning) => warning.code)).toEqual(['line-unparsable']);

    const ledger = readLedgerFile();
    expect(ledger).toMatchObject({ v: 1, runtime: 'codex', accountId: 'default' });
    expect(ledger.windows).toEqual({
      five_hour: {
        usedPct: 22,
        resetsAt: '2026-09-26T23:30:00.000Z',
        windowMinutes: 300,
        status: null,
        observedAt: '2026-09-26T19:05:00.000Z',
        source: 'rollout',
      },
      seven_day: {
        usedPct: 36,
        resetsAt: '2026-10-01T12:00:00.000Z',
        windowMinutes: 10080,
        status: null,
        observedAt: '2026-09-26T19:05:00.000Z',
        source: 'rollout',
      },
      'model:gpt-5.3-codex-spark': {
        usedPct: 41,
        resetsAt: '2026-10-02T09:00:00.000Z',
        windowMinutes: 10080,
        status: null,
        observedAt: '2026-09-26T19:06:00.000Z',
        source: 'rollout',
      },
    });
    expect(ledger.plan).toEqual({
      name: 'pro',
      observedAt: '2026-09-26T19:06:00.000Z',
      source: 'rollout',
    });
    expect(ledger.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: '12.50',
      observedAt: '2026-09-26T19:05:00.000Z',
      source: 'rollout',
    });
  });

  it('reads archived sessions only within --days, and --all brings them back', async () => {
    // Purpose: the 20-day-old archive is outside the default 8 days; with --all
    // its premium limit is found, while its older plus plan and windows lose
    // to the newer pro readings.
    placeBoth();
    const byDefault = await scanJson(['--dry-run']);
    expect(byDefault.accounts[0]).toMatchObject({ files: 1, readings: 4 });

    const wider = await scanJson(['--dry-run', '--days', '21']);
    expect(wider.accounts[0]).toMatchObject({ files: 2, readings: 6 });

    const all = await scanJson(['--all']);
    expect(all.days).toBe('all');
    expect(all.accounts[0]).toMatchObject({ files: 2, readings: 6 });
    const ledger = readLedgerFile();
    expect(ledger.windows['model:premium']).toMatchObject({
      usedPct: 64,
      windowMinutes: 10080,
      observedAt: '2026-09-01T08:11:00.000Z',
    });
    expect(ledger.windows.five_hour.usedPct).toBe(22);
    expect(ledger.plan.name).toBe('pro');
  });

  it('leaves the ledger byte-identical, with the same mtime, on a second run', async () => {
    // Purpose: scan is safe to run on a schedule; an unchanged ledger is never rewritten.
    placeBoth();
    await scanJson();
    const bytes = readFileSync(ledgerFile());
    const mtime = statSync(ledgerFile()).mtimeMs;

    const second = await scanJson();
    expect(second.accounts[0].changed).toEqual([]);
    expect(readFileSync(ledgerFile()).equals(bytes)).toBe(true);
    expect(statSync(ledgerFile()).mtimeMs).toBe(mtime);

    const human = await flow(['usage', 'scan', '--runtime', 'codex']);
    expect(human.stdout).toContain('default: 1 file read, 4 readings');
    expect(human.stdout).toContain('seven_day  unchanged (a newer reading is stored)');
  });

  it('writes nothing with --dry-run, and says what it would record', async () => {
    // Purpose: a dry run reports and leaves no file or folder behind.
    placeBoth();
    const run = await flow(['usage', 'scan', '--runtime', 'codex', '--dry-run']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('Dry run: nothing was saved.');
    expect(run.stdout).toMatch(/five_hour {2}would record \(22% used, resets .+\)/);
    expect(run.stdout).toContain('plan  would record (pro)');
    expect(existsSync(path.join(dorkHome, 'runtimes', 'codex'))).toBe(false);
  });

  it('reads only rollout files, and follows no symlink', async () => {
    // Purpose: other files under sessions/ are not session logs, and a link
    // can point anywhere on disk.
    const elsewhere = path.join(root, 'elsewhere');
    place('rollout-pro.jsonl', 'rollout-2026-09-26T19-00-00-0199cccc.jsonl', 0.1, elsewhere);
    place('rollout-pro.jsonl', 'sessions/2026/09/26/history.jsonl');
    mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    symlinkSync(elsewhere, path.join(codexHome, 'sessions', 'linked'));
    symlinkSync(
      path.join(elsewhere, 'rollout-2026-09-26T19-00-00-0199cccc.jsonl'),
      path.join(codexHome, 'sessions', 'rollout-linked.jsonl')
    );
    const out = await scanJson();
    expect(out.accounts[0]).toMatchObject({ files: 0, readings: 0, observations: [] });
    expect(existsSync(ledgerFile())).toBe(false);
  });

  it('uses <os home>/.codex when CODEX_HOME is unset or empty', async () => {
    // Purpose: the implicit account is the ambient Codex home (A1).
    const home = path.join(osHome, '.codex');
    place('rollout-pro.jsonl', 'sessions/rollout-a.jsonl', 0.1, home);
    const run = await flow(['usage', 'scan', '--runtime', 'codex', '--json'], { CODEX_HOME: '' });
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).accounts[0]).toMatchObject({ home, files: 1, readings: 4 });
  });

  it('scans registered Codex accounts, and default beside them only when it stands alone', async () => {
    // Purpose: once config.json lists Codex accounts, the verbs read those rows
    // (A1). codex:default is CODEX_HOME (rev 6d): its own account while no row
    // has that folder, and an alias of the row once one does, so one real
    // account is scanned once and written to one ledger.
    const work = path.join(root, 'codex-work');
    place('rollout-pro.jsonl', 'sessions/rollout-w.jsonl', 0.1, work);
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(dorkHome, 'config.json'),
      JSON.stringify({ runtimes: { codex: { accounts: [{ id: 'work', path: work }] } } })
    );
    const out = await scanJson();
    expect(out.accounts.map((account) => account.id)).toEqual(['work', 'default']);
    expect(out.accounts[0].files).toBe(1);
    expect(existsSync(ledgerPath(dorkHome, 'codex', 'work'))).toBe(true);

    rmSync(ledgerFile(), { force: true });
    rmSync(ledgerPath(dorkHome, 'codex', 'work'), { force: true });
    const aliased = await flow(
      ['usage', 'scan', '--runtime', 'codex', '--account', 'default', '--json'],
      { CODEX_HOME: `${work}/` }
    );
    expect(aliased.code, aliased.stderr).toBe(0);
    expect(JSON.parse(aliased.stdout).accounts.map((a: { id: string }) => a.id)).toEqual(['work']);
    expect(existsSync(ledgerPath(dorkHome, 'codex', 'work'))).toBe(true);
    expect(existsSync(ledgerFile())).toBe(false);
  });
});
