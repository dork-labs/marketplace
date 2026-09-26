/**
 * `flow limit-check --hook` (spec `flow-handoff-dispatch` §5.4, task 4.2),
 * driven by spawning the real script the way Claude Code's PostToolUse hook
 * does: the hook JSON on stdin, a temp project and a temp DorkOS home. Every
 * run goes through a loader that makes importing `zod` throw, so a case that
 * speaks also proves the hook's whole import graph is zod-free.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every case spawns node; a loaded machine needs the room.
vi.setConfig({ testTimeout: 60_000 });

const FLOW_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const FLOW = path.join(FLOW_ROOT, 'scripts', 'flow.ts');

let dir: string;
let project: string;
let dorkHome: string;
let loader: string;

/** Write JSON, making folders. */
function put(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

/** The run store with one running drain run for session s-1; `null` is the ambient account. */
function runs(account: string | null = 'claude3'): void {
  put(path.join(project, '.dork', 'flow', 'flow-state.json'), {
    'i-1': {
      issueId: 'i-1',
      identifier: 'ACME-1',
      sessionId: 's-1',
      worktreePath: project,
      branch: 'ACME-1-x',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: -1,
      startedAt: '2026-09-26T12:00:00.000Z',
      ...(account === null ? {} : { account }),
      host: 'cli',
      runtime: 'claude-code',
    },
  });
}

/** claude3's ledger: its 5-hour window at `status`, resetting at `resetsAt`. */
function ledger(status: string, usedPct: number, resetsAt: string): void {
  const observedAt = new Date().toISOString();
  put(path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'claude3.json'), {
    v: 1,
    runtime: 'claude-code',
    accountId: 'claude3',
    updatedAt: observedAt,
    windows: {
      five_hour: { usedPct, status, resetsAt, observedAt, source: 'statusline' },
      seven_day: {
        usedPct: 10,
        status: 'allowed',
        resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        observedAt,
        source: 'statusline',
      },
    },
  });
}

/** Run the hook with a payload; stdout, stderr and the exit code. */
function hook(payload: unknown, args: string[] = ['limit-check', '--hook']) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', loader, FLOW, ...args],
    {
      cwd: project,
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...process.env, DORK_HOME: dorkHome, FLOW_SESSION_ID: '' },
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const PAYLOAD = () => ({ session_id: 's-1', cwd: project, hook_event_name: 'PostToolUse' });
const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-limit-check-')));
  project = path.join(dir, 'project');
  dorkHome = path.join(dir, 'home');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  put(path.join(dorkHome, 'config.json'), {
    runtimes: {
      claudeCode: { accounts: [{ id: 'claude3', path: path.join(dir, 'c3'), label: 'Claude 3' }] },
    },
  });
  put(path.join(dorkHome, 'flow', 'fleet.json'), {
    v: 1,
    accounts: { 'claude-code:claude3': { role: 'rotation' } },
  });
  loader = path.join(dir, 'no-zod.mjs');
  const hookSource = `export async function resolve(s, c, n) { if (s === 'zod' || s.startsWith('zod/')) throw new Error('the hook imported zod'); return n(s, c); }`;
  writeFileSync(
    loader,
    `import { register } from 'node:module';\nregister('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hookSource)}));\n`
  );
  runs();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('flow limit-check --hook', () => {
  it('speaks once per episode at a warning, with the wind-down words, and again for a new episode', () => {
    // Purpose: DOR-2371; the worker is told between tool calls, once, and the
    // zod-blocking loader proves the import graph stays zod-free.
    const reset = soon(2);
    ledger('allowed_warning', 91, reset);
    const first = hook(PAYLOAD());
    expect(first.code, first.stderr).toBe(0);
    const out = JSON.parse(first.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain(
      'Claude 3 is close to its 5-hour limit'
    );
    expect(out.hookSpecificOutput.additionalContext).toContain(
      `${FLOW} checkpoint ACME-1 --trigger limit-warning`
    );
    const marker = path.join(project, '.dork', 'flow', 'drain', 'limit-notified-s-1.json');
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      window: 'five_hour',
      resetsAt: reset,
    });

    const second = hook(PAYLOAD());
    expect(second).toMatchObject({ code: 0, stdout: '' });

    ledger('allowed_warning', 92, soon(3));
    const third = hook(PAYLOAD());
    expect(third.code).toBe(0);
    expect(third.stdout).toContain('additionalContext');
  });

  it('speaks when the account is exhausted too', () => {
    // Purpose: an exhausted account needs the same wind-down.
    ledger('rejected', 100, soon(1));
    const result = hook(PAYLOAD());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"hookEventName":"PostToolUse"');
  });

  it('stays silent and exits 0 with room left, outside flow, on the ambient account, and on any broken input', () => {
    // Purpose: a hook that fails or speaks out of turn would disturb every
    // session; each of these must print nothing and never block.
    ledger('allowed', 20, soon(2));
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '' });

    ledger('rejected', 100, soon(1));
    expect(hook({ ...PAYLOAD(), session_id: 'someone-else' })).toMatchObject({
      code: 0,
      stdout: '',
    });
    expect(hook('not json')).toMatchObject({ code: 0, stdout: '' });
    expect(hook('')).toMatchObject({ code: 0, stdout: '' });
    expect(hook({ ...PAYLOAD(), cwd: path.join(dir, 'nowhere') })).toMatchObject({
      code: 0,
      stdout: '',
    });

    runs(null);
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '' });
    runs();

    rmSync(path.join(dorkHome, 'runtimes'), { recursive: true });
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '' });

    put(path.join(dorkHome, 'runtimes', 'claude-code', 'usage', 'claude3.json'), '{ not json');
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '' });

    ledger('rejected', 100, soon(1));
    rmSync(path.join(project, '.dork', 'flow', 'flow-state.json'));
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '' });
    put(path.join(project, '.dork', 'flow', 'flow-state.json'), '{ broken');
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '' });
  });

  it('the no-zod loader really bites: a verb that loads config fails under it', () => {
    // Purpose: without this, the loader could be a no-op and the zod-free claim unproven.
    const result = hook('', ['next']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/zod/);
  });

  it("by hand, prints the run's signal", () => {
    // Purpose: the manual form for a person checking an account.
    ledger('allowed_warning', 91, soon(2));
    const result = hook('', ['limit-check', 'ACME-1']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('ACME-1 on Claude 3: warning (5-hour');
  });
});

describe('hooks.json', () => {
  it('registers the PostToolUse limit-check beside the Stop hook', () => {
    // Purpose: the hook ships only when wired, and it must parse.
    const hooks = JSON.parse(readFileSync(path.join(FLOW_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(hooks.hooks.Stop).toHaveLength(1);
    const post = hooks.hooks.PostToolUse?.[0]?.hooks[0];
    expect(post).toMatchObject({
      type: 'command',
      command:
        'node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" limit-check --hook',
    });
  });
});
