/**
 * Sampled `usage.snapshot` journal lines (spec `flow-usage` Amendment 1 A7):
 * `flow usage snapshot` writes one line per account that is due one, by the
 * journal's own sampling rule, and nothing outside a flow project or with the
 * journal off. `record` never writes one.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordUsage, type UsageObservation } from '../../scripts/fleet/usage-ledger.ts';
import { snapshotEvent } from '../../scripts/cli/usage-journal.ts';
import { main, type MainDeps } from '../../scripts/flow.ts';

const FLOW_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T0 = new Date('2026-09-26T12:00:00.000Z');
const MIN = 60_000;

let root: string;
let project: string;
let dorkHome: string;
let journal: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-usage-snapshot-')));
  project = path.join(root, 'project');
  mkdirSync(project);
  execFileSync('git', ['init', '-q'], { cwd: project });
  dorkHome = path.join(root, 'dork');
  mkdirSync(dorkHome);
  writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'acct-a', path: path.join(root, '.claude-a'), label: null, color: null },
          ],
        },
      },
    })
  );
  journal = path.join(project, '.dork', 'flow', 'journal.jsonl');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function flow(argv: string[], now: Date, cwd = project) {
  let stdout = '';
  let stderr = '';
  const deps: MainDeps = {
    env: { DORK_HOME: dorkHome },
    cwd,
    now: () => now,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    createAdapter: async () => {
      throw new Error('flow usage must not need a tracker');
    },
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: FLOW_ROOT,
    io: {
      osHome: root,
      armWatchdog: () => {},
      stdin: { isTTY: false, read: async () => null },
    },
  };
  const code = await main(argv, deps);
  return { code, stdout, stderr };
}

function snapshots(): Record<string, unknown>[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'usage.snapshot');
}

function reading(usedPct: number, at: Date): UsageObservation {
  return {
    key: 'five_hour',
    usedPct,
    resetsAt: '2026-09-26T15:00:00.000Z',
    status: null,
    observedAt: at.toISOString(),
    source: 'statusline',
  };
}

describe('flow usage snapshot', () => {
  it('writes a line for an account with usage, then samples: nothing within 30 minutes unless usage moved 5 points', async () => {
    // Purpose: the journal keeps a history of usage without one line per status-line render.
    await recordUsage(dorkHome, 'claude-code', 'acct-a', [reading(40, T0)], T0);
    expect((await flow(['usage', 'snapshot'], T0)).code).toBe(0);
    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]).toMatchObject({
      accountRuntime: 'claude-code',
      account: 'acct-a',
      windows: { five_hour: { usedPct: 40, resetsAt: '2026-09-26T15:00:00.000Z' } },
    });

    const t1 = new Date(T0.getTime() + 5 * MIN);
    await recordUsage(dorkHome, 'claude-code', 'acct-a', [reading(42, t1)], t1);
    await flow(['usage', 'snapshot'], t1);
    expect(snapshots()).toHaveLength(1);

    const t2 = new Date(T0.getTime() + 10 * MIN);
    await recordUsage(dorkHome, 'claude-code', 'acct-a', [reading(46, t2)], t2);
    await flow(['usage', 'snapshot'], t2);
    expect(snapshots()).toHaveLength(2);

    const t3 = new Date(t2.getTime() + 31 * MIN);
    await flow(['usage', 'snapshot'], t3);
    expect(snapshots()).toHaveLength(3);
  });

  it('writes nothing for an account with no usage, and nothing with the journal off', async () => {
    // Purpose: no empty lines, and the off switch is honored.
    await flow(['usage', 'snapshot'], T0);
    expect(existsSync(journal)).toBe(false);
    await recordUsage(dorkHome, 'claude-code', 'acct-a', [reading(40, T0)], T0);
    mkdirSync(path.join(project, '.agents', 'flow'), { recursive: true });
    writeFileSync(
      path.join(project, '.agents', 'flow', 'config.json'),
      JSON.stringify({ selfImprovement: { journal: { enabled: false } } })
    );
    const off = await flow(['usage', 'snapshot', '--json'], T0);
    expect(off.code).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ journal: null, written: [] });
    expect(existsSync(journal)).toBe(false);
  });

  it('writes nothing for an account whose only reading is stale', async () => {
    // Purpose: a stale window is no reading; an empty line would claim usage that is not known.
    const old = new Date(T0.getTime() - 10 * 60 * MIN);
    await recordUsage(
      dorkHome,
      'claude-code',
      'acct-a',
      [{ ...reading(40, old), resetsAt: null }],
      old
    );
    await flow(['usage', 'snapshot'], T0);
    expect(snapshots()).toHaveLength(0);
  });

  it('writes nothing and says so outside a flow project', async () => {
    // Purpose: a folder that is not a checkout has no journal; the verb still succeeds.
    await recordUsage(dorkHome, 'claude-code', 'acct-a', [reading(40, T0)], T0);
    const outside = path.join(root, 'plain');
    mkdirSync(outside);
    const result = await flow(['usage', 'snapshot'], T0, outside);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/nothing written/);
  });

  it('is written by usage scan, and not by a dry run', async () => {
    // Purpose: scan and probe feed the journal's usage history (A7).
    const projects = path.join(root, '.claude-a', 'projects', 'p');
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      path.join(projects, 's.jsonl'),
      readFileSync(
        path.join(FLOW_ROOT, 'engine-tests', 'fixtures', 'usage', 'transcripts', 'structured.jsonl')
      )
    );
    const scanAt = new Date('2026-09-18T20:20:00.000Z');
    await flow(['usage', 'scan', '--all', '--dry-run'], scanAt);
    expect(snapshots()).toHaveLength(0);
    expect((await flow(['usage', 'scan', '--all'], scanAt)).code).toBe(0);
    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]).toMatchObject({ accountRuntime: 'claude-code', account: 'acct-a' });
  });

  it('never writes a journal line from usage record', async () => {
    // Purpose: the status-line path stays free of project config.
    await recordUsage(dorkHome, 'claude-code', 'acct-a', [reading(40, T0)], T0);
    await flow(['usage', 'record', '--account', 'acct-a'], T0);
    expect(existsSync(journal)).toBe(false);
  });
});

describe('snapshotEvent', () => {
  it('leaves out error keys, which have no percent and no status in a journal line', () => {
    // Purpose: an OpenCode error key would say nothing and use up a slot under the window cap.
    const event = snapshotEvent(
      { runtime: 'opencode', id: 'default' },
      {
        v: 1,
        runtime: 'opencode',
        accountId: 'default',
        updatedAt: T0.toISOString(),
        windows: {
          'credits:openrouter': {
            usedPct: null,
            resetsAt: null,
            status: 'rejected',
            observedAt: T0.toISOString(),
            source: 'error',
          },
        },
        spend: {
          periodStart: '2026-09-01T00:00:00.000Z',
          costUsd: 0.75,
          limitUsd: null,
          observedAt: T0.toISOString(),
          source: 'transcript',
        },
      },
      T0
    );
    expect(event).toMatchObject({ windows: {}, spend: { costUsd: 0.75 } });
  });
});
