/**
 * `flow claim` as real processes (spec `flow-cli-core` §6): the exact command
 * lines the drain prose documents, and two claims racing for one item.
 *
 * Every case spawns the real `scripts/flow.ts` with `node
 * --experimental-strip-types` in a temp git project whose tracker is the
 * file-backed fake adapter, linked in at `.agents/flow/adapters/fake/`. No
 * `FLOW_SESSION_ID` is set: an unattended drain may have none.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from '../../scripts/errors.ts';
import type { FlowRun } from '../../scripts/flow-run.ts';
import { FAKE_BACKLOG_ENV, type FakeBacklog } from '../fixtures/cli/fake-adapter/adapter.ts';
import { item } from './write-harness.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOW_ROOT = path.resolve(here, '..', '..');
const FAKE_ADAPTER_DIR = path.join(FLOW_ROOT, 'engine-tests', 'fixtures', 'cli', 'fake-adapter');

let dir: string;
let backlogFile: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-claim-process-')));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'work');
  git(
    '-c',
    'user.email=t@example.test',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  );
  mkdirSync(path.join(dir, '.agents', 'flow', 'adapters'), { recursive: true });
  writeFileSync(
    path.join(dir, '.agents', 'flow', 'config.json'),
    JSON.stringify({ tracker: 'fake', identity: { agent: 'agent-1' } })
  );
  symlinkSync(FAKE_ADAPTER_DIR, path.join(dir, '.agents', 'flow', 'adapters', 'fake'), 'dir');
  backlogFile = path.join(dir, 'backlog.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeBacklog(backlog: FakeBacklog): void {
  writeFileSync(backlogFile, JSON.stringify(backlog, null, 2));
}

function readBacklog(): FakeBacklog {
  return JSON.parse(readFileSync(backlogFile, 'utf8')) as FakeBacklog;
}

function runs(): Record<string, FlowRun> {
  const store = path.join(dir, '.dork', 'flow', 'flow-state.json');
  return existsSync(store)
    ? (JSON.parse(readFileSync(store, 'utf8')) as Record<string, FlowRun>)
    : {};
}

/** The environment a spawned claim gets: no session id, the fake backlog. */
function claimEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    [FAKE_BACKLOG_ENV]: backlogFile,
    ...extra,
  };
}

/** Run one shell command line in the project, as an agent's Bash tool would. */
function runLine(line: string, env: NodeJS.ProcessEnv = claimEnv()) {
  return spawnSync('sh', ['-c', line], { cwd: dir, env, encoding: 'utf8' });
}

/** The first `flow.ts claim` command line documented in `file` (relative to the plugin root). */
function documentedClaim(file: string): string {
  const text = readFileSync(path.join(FLOW_ROOT, file), 'utf8');
  const match = /`(node --experimental-strip-types "[^"]+\/scripts\/flow\.ts" claim [^`]+)`/.exec(
    text
  );
  if (match === null) throw new Error(`${file} documents no flow claim command`);
  return match[1];
}

/** Fill the placeholders an agent fills. */
function fill(line: string, session: string | null): string {
  let filled = line
    .replace('<flow-root>', FLOW_ROOT)
    .replace('<id>', 'FAKE-1')
    .replace('<path>', dir)
    .replace('<branch>', 'work');
  filled =
    session === null
      ? filled.replace(' --session <session id>', '')
      : filled.replace('<session id>', session);
  expect(filled).not.toMatch(/<[^>]+>/);
  return filled;
}

describe('the documented drain claim runs as written', () => {
  it('claims with the command line skills/flow-drain/SKILL.md documents', () => {
    // Purpose: the unattended drain runs exactly this line every tick; if it
    // cannot claim, the drain never carries any work.
    writeBacklog({ items: [item('FAKE-1')] });
    const result = runLine(fill(documentedClaim('skills/flow-drain/SKILL.md'), 'sess-drain'));
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(runs()['id-FAKE-1']).toMatchObject({ sessionId: 'sess-drain', branch: 'work' });
    expect(readBacklog().items[0].labels).toContain('agent/claimed');
  });

  it('still claims when the agent does not know its session id', () => {
    // Purpose: with no --session and no FLOW_SESSION_ID the claim used to exit 5
    // on every tick; now it records the session as unknown and warns.
    writeBacklog({ items: [item('FAKE-1')] });
    const result = runLine(fill(documentedClaim('skills/flow-drain/SKILL.md'), null));
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(result.stderr).toMatch(/--session/);
    expect(runs()['id-FAKE-1'].sessionId).toBe('');
  });

  it('claims with the command line commands/flow.md documents', () => {
    // Purpose: the interactive drain's line must work the same way.
    writeBacklog({ items: [item('FAKE-1')] });
    const line = fill(documentedClaim('commands/flow.md'), 'sess-cmd');
    const result = runLine(line, claimEnv({ CLAUDE_PLUGIN_ROOT: FLOW_ROOT }));
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(runs()['id-FAKE-1'].sessionId).toBe('sess-cmd');
  });
});

/** Spawn one claim and resolve with its exit code. */
function claimAsync(session: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(FLOW_ROOT, 'scripts', 'flow.ts'),
        'claim',
        'FAKE-1',
        '--session',
        session,
        '--pid',
        '1',
        '--json',
      ],
      { cwd: dir, env: claimEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

describe('two claims of one item on one machine', () => {
  it('serialize: exactly one wins and the other exits 5', async () => {
    // Purpose: both read the item before either writes (the fake holds each
    // read back), so without the run store's lock held across the check and
    // the write, both would claim the same item.
    writeBacklog({ items: [item('FAKE-1')], getItemDelayMs: 800 });
    const results = await Promise.all([claimAsync('sess-a'), claimAsync('sess-b')]);
    const codes = results.map((result) => result.code).sort();
    expect(codes).toEqual([EXIT.ok, EXIT.precondition]);
    const loser = results.find((result) => result.code === EXIT.precondition)!;
    expect(loser.stdout).toMatch(/already claimed/);
    const winner = results.find((result) => result.code === EXIT.ok)!;
    const winnerSession = (JSON.parse(winner.stdout) as { run: FlowRun }).run.sessionId;
    expect(runs()['id-FAKE-1'].sessionId).toBe(winnerSession);
  }, 30_000);
});
