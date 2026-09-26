/**
 * `flow usage scan` (spec `flow-usage` §2.4, task 2.2): recover past limit hits
 * from transcripts into the usage ledger, idempotently.
 *
 * Every case drives `main(argv, deps)` against a temp `DORK_HOME` and a temp
 * account folder holding the transcript fixtures under `projects/<slug>/`, so no
 * test touches the real home folder.
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
import { ledgerPath, recordUsage } from '../../scripts/fleet/usage-ledger.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', 'fixtures', 'usage', 'transcripts');

/** The clock every run sees: after every fixture hit. */
const NOW = new Date('2026-09-20T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let dorkHome: string;
let osHome: string;
let account: string;
let slugDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flow-usage-scan-'));
  dorkHome = path.join(root, 'dork');
  osHome = path.join(root, 'home');
  account = path.join(root, 'accounts', 'one');
  slugDir = path.join(account, 'projects', '-home-example-project');
  mkdirSync(dorkHome, { recursive: true });
  mkdirSync(osHome, { recursive: true });
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      runtimes: { claudeCode: { accounts: [{ id: 'one', path: account, label: 'One' }] } },
    })
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Copy a fixture into `dir` and date its mtime `ageDays` before {@link NOW}. */
function place(fixture: string, ageDays = 1, dir = slugDir, name = fixture): string {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  copyFileSync(path.join(FIXTURES, fixture), target);
  const when = new Date(NOW.getTime() - ageDays * DAY_MS);
  utimesSync(target, when, when);
  return target;
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

/** Run `flow <argv>` with a temp home. */
async function flow(argv: string[]) {
  const stdout = sink();
  const stderr = sink();
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome },
    cwd: root,
    now: () => NOW,
    stdout,
    stderr,
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: path.resolve(here, '..', '..'),
    io: { osHome },
  };
  const code = await main(argv, deps);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** Run a scan with `--json` and return the parsed payload. */
async function scanJson(extra: string[] = []) {
  const run = await flow(['usage', 'scan', '--json', ...extra]);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as {
    v: number;
    days: number | 'all';
    accounts: {
      id: string;
      files: number;
      hits: number;
      unidentified: number;
      observations: Record<string, unknown>[];
      changed: string[];
      dropped: boolean;
    }[];
    warnings: { code: string; message: string }[];
  };
}

function readLedgerFile(): { windows: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(ledgerPath(dorkHome, 'one'), 'utf8'));
}

describe('flow usage scan', () => {
  it('records the structured hits and skips decoys and model limits', async () => {
    // Purpose: DOR-2369 validation 2. Real limit hits land in the ledger with
    // their window and reset; a user message quoting the text, an ordinary
    // assistant line and a model limit never do.
    place('structured.jsonl');
    place('decoy.jsonl');
    place('model-limit.jsonl');

    const out = await scanJson();
    expect(out.v).toBe(1);
    expect(out.days).toBe(8);
    expect(out.accounts).toHaveLength(1);
    const [one] = out.accounts;
    expect(one).toMatchObject({ id: 'one', files: 3, hits: 2, unidentified: 1 });
    expect(one.changed.sort()).toEqual(['five_hour', 'seven_day']);

    const windows = readLedgerFile().windows;
    expect(windows.five_hour).toEqual({
      usedPct: null,
      resetsAt: new Date(1789763400 * 1000).toISOString(),
      status: 'rejected',
      observedAt: '2026-09-18T20:11:48.382Z',
      source: 'transcript',
    });
    expect(windows.seven_day).toMatchObject({
      resetsAt: new Date(1790366400 * 1000).toISOString(),
      observedAt: '2026-09-19T15:00:00.000Z',
      source: 'transcript',
    });
    expect(Object.keys(windows).sort()).toEqual(['five_hour', 'seven_day']);
  });

  it('reads the window and reset from the text when there is no structured data', async () => {
    // Purpose: older Claude Code versions wrote only the message text; the scan
    // still keeps the latest hit per window.
    place('text-only.jsonl');
    place('decoy.jsonl');

    const [one] = (await scanJson()).accounts;
    expect(one).toMatchObject({ files: 2, hits: 3, unidentified: 0 });
    const windows = readLedgerFile().windows;
    expect(windows.five_hour).toMatchObject({
      observedAt: '2026-08-13T17:52:58.372Z',
      resetsAt: '2026-08-13T20:30:00.000Z',
      status: 'rejected',
    });
    // The later of the two weekly hits wins: 12pm Chicago the next day.
    expect(windows.seven_day).toMatchObject({
      observedAt: '2026-08-14T02:00:00.000Z',
      resetsAt: '2026-08-14T17:00:00.000Z',
    });
  });

  it('skips files older than --days, and --all reads them', async () => {
    // Purpose: the default reads only the last 8 days; an older file must be
    // excluded, and --all or a larger --days must bring it back.
    place('structured.jsonl', 10);

    const byDefault = await scanJson(['--dry-run']);
    expect(byDefault.accounts[0]).toMatchObject({ files: 0, hits: 0 });

    const wider = await scanJson(['--dry-run', '--days', '11']);
    expect(wider.accounts[0]).toMatchObject({ files: 1, hits: 2 });

    const all = await scanJson(['--dry-run', '--all']);
    expect(all.days).toBe('all');
    expect(all.accounts[0]).toMatchObject({ files: 1, hits: 2 });
  });

  it('leaves the ledger byte-identical, with the same mtime, on a second run', async () => {
    // Purpose: scan is safe to run on a schedule; an unchanged ledger is never rewritten.
    place('structured.jsonl');
    await scanJson();
    const file = ledgerPath(dorkHome, 'one');
    const bytes = readFileSync(file);
    const mtime = statSync(file).mtimeMs;

    const second = await scanJson();
    expect(second.accounts[0].changed).toEqual([]);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  it('never overwrites a newer statusline reading', async () => {
    // Purpose: an old limit hit must not replace a fresher reading the status line stored.
    await recordUsage(
      dorkHome,
      'one',
      [
        {
          key: 'five_hour',
          usedPct: 12,
          resetsAt: '2026-09-20T03:00:00.000Z',
          status: null,
          observedAt: '2026-09-19T23:00:00.000Z',
          source: 'statusline',
        },
      ],
      NOW
    );
    place('structured.jsonl');

    const run = await flow(['usage', 'scan']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('five_hour  unchanged (a newer reading is stored)');
    expect(run.stdout).toMatch(/seven_day {2}recorded \(limited until .+\)/);
    expect(run.stdout).toContain('one: 1 file read, 2 hits, 0 unidentified');

    const windows = readLedgerFile().windows;
    expect(windows.five_hour).toMatchObject({ source: 'statusline', usedPct: 12 });
    expect(windows.seven_day).toMatchObject({ source: 'transcript' });
  });

  it('says a locked usage file was not saved, never that a newer reading is stored', async () => {
    // Purpose: a dropped write must read as "not saved", so the person knows to run it again.
    place('structured.jsonl');
    mkdirSync(path.join(dorkHome, 'usage'), { recursive: true });
    // A live holder's fresh lock makes the writer give up after 2 s.
    writeFileSync(path.join(dorkHome, 'usage', 'one.json.lock'), `${process.pid}:held`);
    const human = await flow(['usage', 'scan']);
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/not saved \(the usage file stayed locked/);
    expect(human.stdout).not.toMatch(/a newer reading is stored/);
    const json = await scanJson();
    expect(json.accounts[0]).toMatchObject({ changed: [], dropped: true });
  }, 15_000);

  it('writes nothing with --dry-run', async () => {
    // Purpose: a dry run reports what it would record and leaves no file behind.
    place('structured.jsonl');
    const out = await scanJson(['--dry-run']);
    expect(out.accounts[0].changed.sort()).toEqual(['five_hour', 'seven_day']);
    expect(existsSync(ledgerPath(dorkHome, 'one'))).toBe(false);
    expect(existsSync(path.join(dorkHome, 'usage'))).toBe(false);
  });

  it('warns about a torn line and still records the hits around it', async () => {
    // Purpose: one broken line (a transcript cut mid-write) must not lose the rest of the file.
    place('broken.jsonl');
    const out = await scanJson();
    expect(out.accounts[0]).toMatchObject({ files: 1, hits: 2 });
    expect(out.warnings.map((warning) => warning.code)).toEqual(['line-unparsable']);
    expect(out.warnings[0].message).toContain('line 2');
    expect(Object.keys(readLedgerFile().windows).sort()).toEqual(['five_hour', 'seven_day']);
  });

  it('does not follow symlinks while walking projects/', async () => {
    // Purpose: a link can point anywhere on disk; the walk stays inside the account's own folder.
    const elsewhere = path.join(root, 'elsewhere');
    place('structured.jsonl', 1, elsewhere);
    symlinkSync(elsewhere, path.join(account, 'projects', 'linked'));
    symlinkSync(path.join(elsewhere, 'structured.jsonl'), path.join(slugDir, 'linked-file.jsonl'));
    const out = await scanJson();
    expect(out.accounts[0]).toMatchObject({ files: 0, hits: 0 });
  });

  it('exits 5 for an unknown --account and 2 for a bad --days', async () => {
    // Purpose: a typo in the id must fail loudly, not scan nothing and say "ok".
    const unknown = await flow(['usage', 'scan', '--account', 'nobody']);
    expect(unknown.code).toBe(5);
    expect(unknown.stderr).toContain('"nobody"');

    const badDays = await flow(['usage', 'scan', '--days', 'seven']);
    expect(badDays.code).toBe(2);
  });
});
