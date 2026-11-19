/**
 * `flow limit-check --hook` (spec `flow-handoff-dispatch` §5.4, task 4.2),
 * driven by spawning the real script the way Claude Code's PostToolUse hook
 * does: the hook JSON on stdin, a temp project and a temp DorkOS home. Every
 * run goes through a loader that makes importing `zod` throw, so a case that
 * speaks also proves the hook's whole import graph is zod-free.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
function runs(account: string | null = 'claude3', overrides: Record<string, unknown> = {}): void {
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
      ...overrides,
    },
  });
}

/** claude3's ledger: its 5-hour window at `status`, resetting at `resetsAt`. */
function ledger(
  status: string,
  usedPct: number,
  resetsAt: string | null,
  options: {
    runtime?: string;
    accountId?: string;
    observedAt?: string;
    windows?: Record<string, unknown>;
    spend?: Record<string, unknown>;
  } = {}
): void {
  const {
    runtime = 'claude-code',
    accountId = 'claude3',
    observedAt = new Date().toISOString(),
  } = options;
  put(path.join(dorkHome, 'runtimes', runtime, 'usage', `${accountId}.json`), {
    v: 1,
    runtime,
    accountId,
    updatedAt: observedAt,
    ...(options.spend === undefined ? {} : { spend: options.spend }),
    windows: options.windows ?? {
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

function childArgs(args: readonly string[]): string[] {
  return ['--experimental-strip-types', '--no-warnings', '--import', loader, FLOW, ...args];
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
    HOME: dir,
    DORK_HOME: dorkHome,
    XDG_CONFIG_HOME: path.join(dir, 'xdg'),
    TMPDIR: dir,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

const CONTEXT_ARGS = ['limit-check', '--context-stdin'];
const marker = () => path.join(project, '.dork', 'flow', 'drain', 'limit-notified-s-1.json');
const contextPayload = (runtime = 'codex', accountId = 'codex-a') => ({
  v: 1,
  operation: 'evaluate',
  issueId: 'i-1',
  expectedSessionId: 's-1',
  runtime,
  accountId,
  cwd: project,
});

/** Run the hook with a payload; stdout, stderr and the exit code. */
function hook(payload: unknown, args: string[] = ['limit-check', '--hook'], cwd = project) {
  const result = spawnSync(process.execPath, childArgs(args), {
    cwd,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: childEnv(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const PAYLOAD = () => ({ session_id: 's-1', cwd: project, hook_event_name: 'PostToolUse' });
const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-limit-check-')));
  project = path.join(dir, 'project');
  dorkHome = path.join(dir, 'home');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q', project], { env: childEnv() });
  put(path.join(dorkHome, 'config.json'), {
    runtimes: {
      claudeCode: { accounts: [{ id: 'claude3', path: path.join(dir, 'c3'), label: 'Claude 3' }] },
      codex: { accounts: [{ id: 'codex-a', path: path.join(dir, 'cx'), label: 'Codex A' }] },
      opencode: { accounts: [{ id: 'oc-a', path: path.join(dir, 'oc'), label: 'OpenCode A' }] },
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

describe('canonical warning evaluator', () => {
  it('applies committed and local warning margins in manual, hook and context modes', () => {
    // Purpose: margin 25/80 warns and local 5/91 is healthy, the opposite of
    // either verdict under the old hardcoded 10. All three modes use the policy.
    put(path.join(project, '.agents', 'flow', 'config.json'), { drain: { warnMarginPct: 25 } });
    ledger('allowed', 80, soon(2));
    expect(hook('', ['limit-check', 'ACME-1']).stdout).toContain('warning');

    const nested = path.join(project, 'nested');
    mkdirSync(nested);
    const claude = hook({ ...PAYLOAD(), cwd: nested });
    expect(claude.code, claude.stderr).toBe(0);
    expect(claude.stdout).toContain('additionalContext');

    runs('codex-a', { runtime: 'codex' });
    ledger('allowed', 80, soon(2), { runtime: 'codex', accountId: 'codex-a' });
    rmSync(marker());
    const codex = hook(contextPayload(), CONTEXT_ARGS);
    expect(codex.code, codex.stderr).toBe(0);
    const output = JSON.parse(codex.stdout);
    expect(output).toMatchObject({ v: 1, kind: 'warning' });
    expect(output.hookStdout).toBe(claude.stdout.replaceAll('Claude 3', 'Codex A'));

    put(path.join(project, '.agents', 'flow', 'config.local.json'), {
      drain: { warnMarginPct: 5 },
      secrets: { trackerToken: 'fixture-only-never-emitted' },
    });
    ledger('allowed', 91, soon(3), { runtime: 'codex', accountId: 'codex-a' });
    expect(JSON.parse(hook(contextPayload(), CONTEXT_ARGS).stdout)).toEqual({
      v: 1,
      kind: 'silent',
      reason: 'healthy',
    });
    runs();
    ledger('allowed', 91, soon(3));
    expect(hook('', ['limit-check', 'ACME-1']).stdout).toContain(': ok');
    expect(hook(PAYLOAD())).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('matches exact active run facts and the canonical process checkout', () => {
    // Purpose: wrong identity, inactive run, malformed DTO, cross-project cwd
    // and wrong ledger owner must not consume a genuine warning.
    runs('codex-a', { runtime: 'codex' });
    const reset = soon(2);
    const ledgerFile = path.join(dorkHome, 'runtimes', 'codex', 'usage', 'codex-a.json');
    ledger('rejected', 100, reset, { runtime: 'codex', accountId: 'codex-a' });
    const p = contextPayload();
    const another = path.join(dir, 'other');
    execFileSync('git', ['init', '-q', another], { env: childEnv() });
    const otherWorktree = path.join(project, 'subdir');
    mkdirSync(otherWorktree);
    for (const invalid of [
      { ...p, issueId: 'wrong' },
      { ...p, expectedSessionId: 'wrong' },
      { ...p, runtime: 'opencode' },
      { ...p, accountId: 'claude3' },
      { ...p, cwd: otherWorktree },
      { ...p, executable: '/bin/false' },
      { ...p, accountId: 'é'.repeat(129) },
      JSON.stringify(p) + ' '.repeat(8192),
    ]) {
      const refused = hook(invalid, CONTEXT_ARGS);
      expect(refused).toMatchObject({ code: 0, stderr: '' });
      expect(JSON.parse(refused.stdout)).toMatchObject({ v: 1, kind: 'silent' });
    }
    expect(JSON.parse(hook(p, CONTEXT_ARGS, another).stdout)).toMatchObject({ kind: 'silent' });
    runs('codex-a', { runtime: 'codex', status: 'complete' });
    expect(JSON.parse(hook(p, CONTEXT_ARGS).stdout)).toMatchObject({
      kind: 'silent',
      reason: 'closed',
    });
    runs('codex-a', { runtime: 'codex' });
    const saved = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    put(ledgerFile, { ...saved, accountId: 'different' });
    expect(JSON.parse(hook(p, CONTEXT_ARGS).stdout)).toMatchObject({
      kind: 'silent',
      reason: 'unknown',
    });
    expect(existsSync(marker())).toBe(false);
    put(ledgerFile, saved);
    expect(JSON.parse(hook(p, CONTEXT_ARGS).stdout)).toMatchObject({ kind: 'warning' });
  });

  it('uses the named linked worktree and the main checkout store', () => {
    // Purpose: a managed launcher starts the evaluator at the main checkout,
    // while the context and the marker belong to the run's linked worktree.
    execFileSync(
      'git',
      [
        '-C',
        project,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'Fixture',
        '--allow-empty',
      ],
      { env: childEnv() }
    );
    const linked = path.join(dir, 'linked');
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '--detach', linked], {
      env: childEnv(),
    });
    runs('codex-a', { runtime: 'codex', worktreePath: linked });
    ledger('allowed', 92, soon(2), { runtime: 'codex', accountId: 'codex-a' });
    expect(
      JSON.parse(hook({ ...contextPayload(), cwd: linked }, CONTEXT_ARGS).stdout)
    ).toMatchObject({
      v: 1,
      kind: 'warning',
    });
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(path.join(linked, '.dork', 'flow', 'drain', 'limit-notified-s-1.json'))).toBe(
      true
    );
  });

  it('re-reads selected model readings and leaves stale, reset and cost-only paths silent', () => {
    // Purpose: only the selected model's attributable current reading may warn.
    const codex = { runtime: 'codex', accountId: 'codex-a' };
    runs('codex-a', { runtime: 'codex', drain: { worker: { model: 'target' } } });
    const check = (payload: unknown = contextPayload()) =>
      JSON.parse(hook(payload, CONTEXT_ARGS).stdout);
    expect(check()).toMatchObject({ kind: 'silent', reason: 'unknown' });
    ledger('rejected', 100, null, { ...codex, observedAt: new Date(0).toISOString() });
    expect(check()).toMatchObject({ kind: 'silent', reason: 'unknown' });
    ledger('rejected', 100, soon(-1), codex);
    expect(check()).toMatchObject({ kind: 'silent' });

    const reading = {
      usedPct: 100,
      status: 'rejected',
      resetsAt: soon(2),
      observedAt: new Date().toISOString(),
      source: 'rollout',
    };
    ledger('allowed', 10, soon(2), { ...codex, windows: { 'model:other': reading } });
    expect(check()).toMatchObject({ kind: 'silent', reason: 'unknown' });
    ledger('allowed', 10, soon(2), { ...codex, windows: { 'model:target': reading } });
    expect(check()).toMatchObject({ kind: 'warning' });

    runs('oc-a', { runtime: 'opencode' });
    ledger('allowed', 0, null, {
      runtime: 'opencode',
      accountId: 'oc-a',
      windows: {},
      spend: { costUsd: 100, limitUsd: null },
    });
    const openCode = contextPayload('opencode', 'oc-a');
    expect(check(openCode)).toMatchObject({ kind: 'silent', reason: 'unknown' });
    const reset = soon(3);
    ledger('allowed', 95, reset, { runtime: 'opencode', accountId: 'oc-a' });
    expect(check(openCode)).toMatchObject({ kind: 'warning' });
  });

  it('commits one warning across simultaneous subprocesses and suppresses a lost reply', async () => {
    // Purpose: the real filesystem lock serializes consumers; result loss
    // after commit does not retry a warning or introduce an acknowledgment.
    runs('codex-a', { runtime: 'codex' });
    const options = { runtime: 'codex', accountId: 'codex-a' };
    const initialReset = soon(2);
    ledger('allowed', 12, initialReset, options);
    expect(JSON.parse(hook(contextPayload(), CONTEXT_ARGS).stdout)).toMatchObject({
      kind: 'silent',
      reason: 'healthy',
    });
    ledger('rejected', 100, initialReset, options);
    const spawnContext = (discard: boolean) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, childArgs(CONTEXT_ARGS), {
          cwd: project,
          env: childEnv(),
          stdio: ['pipe', discard ? 'ignore' : 'pipe', 'pipe'],
        });
        let output = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8').on('data', (data: string) => {
          output += data;
        });
        child.stderr?.setEncoding('utf8').on('data', (data: string) => {
          stderr += data;
        });
        child.once('error', reject);
        child.once('close', (code) => {
          if (code !== 0 || stderr !== '') reject(new Error(`evaluator exited ${code}: ${stderr}`));
          else resolve(output);
        });
        child.stdin?.end(JSON.stringify(contextPayload()));
      });
    const replies = await Promise.all([spawnContext(false), spawnContext(false)]);
    expect(replies.map((reply) => JSON.parse(reply).kind).sort()).toEqual(['silent', 'warning']);
    const nextReset = soon(3);
    ledger('rejected', 100, nextReset, options);
    await spawnContext(true);
    expect(JSON.parse(readFileSync(marker(), 'utf8'))).toEqual({
      window: 'five_hour',
      resetsAt: nextReset,
    });
    expect(JSON.parse(hook(contextPayload(), CONTEXT_ARGS).stdout)).toMatchObject({
      kind: 'silent',
      reason: 'closed',
    });
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
