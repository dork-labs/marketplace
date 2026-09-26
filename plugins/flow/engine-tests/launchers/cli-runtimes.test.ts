/**
 * The plain CLI launcher's codex and opencode details (RUNTIMES.md R5) the
 * shared contract does not cover: the exact argv each runtime gets, how a
 * permission mode maps, which environment the child sees, the thread id and
 * plan codex reports, the provider an opencode account bills, and the rollout
 * reader behind codex's `limited` state. The contract itself runs for both in
 * cli.test.ts.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { codexModeArgs } from '../../scripts/launchers/cli.ts';
import {
  codexLimit,
  codexWindowKey,
  findCodexRollout,
  readCodexRateLimits,
} from '../../scripts/launchers/codex-rollout.ts';
import { requestFor } from './contract.ts';
import { makeCliRuntimeHarness, type CliRuntimeHarness } from './cli-runtime-harness.ts';
import type { HarnessOptions } from './contract.ts';

// Every case starts real (if tiny) processes on a shared, loaded machine.
vi.setConfig({ testTimeout: 120_000 });

/** Run a body with a harness, always cleaning up. */
async function withRuntime(
  options: HarnessOptions,
  body: (h: CliRuntimeHarness) => Promise<void>
): Promise<void> {
  const h = await makeCliRuntimeHarness(options);
  try {
    await body(h);
  } finally {
    await h.cleanup();
  }
}

describe('cli launcher: codex', () => {
  // The argv is exactly `codex exec --json -C <cwd> <mode flags> -m <model>
  // <pointer>`, the child runs in cwd on the account's CODEX_HOME, and the
  // handle carries the thread id Codex minted and the plan its rollout reported.
  it('starts codex exec --json with the mode flags and model, and keeps the thread id and plan', async () => {
    await withRuntime({ runtime: 'codex' }, async (h) => {
      const req = requestFor(h, { model: 'gpt-5.5' });
      const handle = await h.launcher.start(req);
      const [run] = h.runs();
      expect(run?.argv).toEqual([
        'exec',
        '--json',
        '-C',
        h.cwd,
        '-s',
        'workspace-write',
        '-c',
        'approval_policy="never"',
        '-m',
        'gpt-5.5',
        `Read ${h.promptFile} and do exactly what it says.`,
      ]);
      expect(run?.spawnCwd).toBe(h.cwd);
      expect(run?.env.CODEX_HOME).toBe(h.account.path);
      expect(handle).toMatchObject({
        host: 'cli',
        runtime: 'codex',
        sessionId: run?.sessionId,
        configDir: h.account.path,
        plan: 'pro',
        model: 'gpt-5.5',
      });
      expect(handle.sessionId).not.toBe(req.sessionId);
      expect(handle.logFile).toBe(
        path.join(h.cwd, '.dork', 'flow', 'drain', 'logs', `${req.sessionId}.jsonl`)
      );
    });
  });

  // A resume puts the shared flags before `resume <id>` (the Codex SDK's own
  // order) and passes the mode and model again; bypassPermissions is the one
  // flag that turns off both approvals and the sandbox.
  it('resumes with the shared flags before resume <thread id>', async () => {
    await withRuntime({ runtime: 'codex' }, async (h) => {
      const handle = await h.launcher.start(requestFor(h, { permissionMode: 'bypassPermissions' }));
      await h.signal(handle, { kind: 'exited' });
      await h.launcher.send(handle, h.messageFile);
      const resume = h.runs().at(-1);
      expect(resume?.kind).toBe('resume');
      expect(resume?.argv).toEqual([
        'exec',
        '--json',
        '-C',
        h.cwd,
        '--dangerously-bypass-approvals-and-sandbox',
        'resume',
        handle.sessionId,
        `Read ${h.messageFile} and do exactly what it says.`,
      ]);
    });
  });

  // The mapping DorkOS's codex runtime uses, one sandbox level per mode, with
  // approvals never asked (codex exec has no approval channel).
  it('maps each permission mode to a sandbox', () => {
    expect(codexModeArgs('default')).toEqual(['-s', 'read-only', '-c', 'approval_policy="never"']);
    expect(codexModeArgs('acceptEdits')).toEqual([
      '-s',
      'workspace-write',
      '-c',
      'approval_policy="never"',
    ]);
    expect(codexModeArgs('bypassPermissions')).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  // The ambient account is the supervisor's own CODEX_HOME when it has one,
  // set explicitly on the child; API keys never ride along.
  it('the ambient account runs on the supervisor’s CODEX_HOME, without API keys', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'flow-codex-home-'));
    try {
      await withRuntime(
        {
          runtime: 'codex',
          supervisorEnv: { CODEX_HOME: tmp, OPENAI_API_KEY: 'sk-x', CODEX_API_KEY: 'ck-x' },
        },
        async (h) => {
          const handle = await h.launcher.start(requestFor(h, { account: null }));
          const [run] = h.runs();
          expect(run?.env.CODEX_HOME).toBe(tmp);
          expect(run?.env.OPENAI_API_KEY).toBeUndefined();
          expect(run?.env.CODEX_API_KEY).toBeUndefined();
          expect(handle).toMatchObject({ account: null, configDir: tmp });
        }
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('cli launcher: opencode', () => {
  // The argv is exactly `opencode run --format json -m <provider/model> --title
  // <title> <pointer>`: no --auto outside bypassPermissions (OpenCode then
  // auto-rejects any permission ask), and the handle keeps the ses_ id.
  it('starts opencode run --format json with the model and title, and keeps the session id', async () => {
    await withRuntime({ runtime: 'opencode' }, async (h) => {
      const handle = await h.launcher.start(requestFor(h, { model: 'openrouter/qwen3-coder' }));
      const [run] = h.runs();
      expect(run?.argv).toEqual([
        'run',
        '--format',
        'json',
        '-m',
        'openrouter/qwen3-coder',
        '--title',
        'ACME-12 worker',
        `Read ${h.promptFile} and do exactly what it says.`,
      ]);
      expect(handle).toMatchObject({ runtime: 'opencode', sessionId: run?.sessionId });
      expect(handle.sessionId).toMatch(/^ses_/);
      expect(handle.configDir).toBeUndefined();
    });
  });

  // bypassPermissions is --auto; a resume names the session with --session.
  it('resumes with --session <id>, and bypassPermissions passes --auto', async () => {
    await withRuntime({ runtime: 'opencode' }, async (h) => {
      const handle = await h.launcher.start(requestFor(h, { permissionMode: 'bypassPermissions' }));
      expect(h.runs()[0]?.argv).toContain('--auto');
      await h.signal(handle, { kind: 'exited' });
      await h.launcher.send(handle, h.messageFile);
      expect(h.runs().at(-1)?.argv).toEqual([
        'run',
        '--format',
        'json',
        '--auto',
        '--session',
        handle.sessionId,
        `Read ${h.messageFile} and do exactly what it says.`,
      ]);
    });
  });

  // An OpenCode account is the ambient provider credential: its API key must
  // reach the child, and flow sets no runtime home for it.
  it('keeps the provider credential in the child environment', async () => {
    await withRuntime(
      { runtime: 'opencode', supervisorEnv: { OPENROUTER_API_KEY: 'or-key' } },
      async (h) => {
        await h.launcher.start(requestFor(h));
        const env = h.runs()[0]?.env ?? {};
        expect(env.OPENROUTER_API_KEY).toBe('or-key');
        expect(env.CODEX_HOME).toBeUndefined();
        expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      }
    );
  });

  // A model from another provider than the account bills, or an account with a
  // folder, is refused before anything starts.
  it('refuses a model of another provider and an account with a path', async () => {
    await withRuntime({ runtime: 'opencode' }, async (h) => {
      await expect(
        h.launcher.start(requestFor(h, { model: 'anthropic/claude-sonnet' }))
      ).rejects.toMatchObject({
        code: 'bad-request',
        message: expect.stringContaining('bills openrouter'),
      });
      await expect(
        h.launcher.start(requestFor(h, { account: { ...h.account, path: h.cwd } }))
      ).rejects.toMatchObject({ code: 'bad-request' });
      expect(h.runs()).toEqual([]);
    });
  });

  // The implicit default account needs no provider check: the session id is
  // enough, and no `opencode export` is run.
  it('the default account is confirmed by the session id alone', async () => {
    await withRuntime({ runtime: 'opencode' }, async (h) => {
      const handle = await h.launcher.start(
        requestFor(h, { account: { runtime: 'opencode', id: 'default', path: null } })
      );
      expect(handle.account).toBe('default');
      const exported = h.calls().filter((c) => (c.args as string[])[0] === 'export');
      expect(exported).toEqual([]);
    });
  });
});

describe('codex rollout reader', () => {
  /** A temp CODEX_HOME with one rollout holding `lines`. */
  function rolloutWith(lines: unknown[]): { home: string; file: string; cleanup: () => void } {
    const home = mkdtempSync(path.join(os.tmpdir(), 'flow-rollout-'));
    const dir = path.join(home, 'sessions', '2026', '09', '26');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'rollout-2026-09-26T18-00-00-thread-1.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return { home, file, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  /** A token_count event with the given primary use. */
  const tokenCount = (used: number, reached: string | null) => ({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: used, window_minutes: 300, resets_at: 1790000000 },
        secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1790500000 },
        plan_type: 'plus',
        rate_limit_reached_type: reached,
      },
    },
  });

  // Window lengths normalize to the ledger's keys (RUNTIMES.md R2).
  it('names windows by length', () => {
    expect(codexWindowKey(300)).toBe('five_hour');
    expect(codexWindowKey(10_080)).toBe('seven_day');
    expect(codexWindowKey(60)).toBe('window:60');
  });

  // The rollout is found by thread id under sessions/, and only there.
  it('finds a rollout by thread id', () => {
    const r = rolloutWith([]);
    try {
      expect(findCodexRollout(r.home, 'thread-1')).toBe(r.file);
      expect(findCodexRollout(r.home, 'thread-2')).toBeNull();
      expect(findCodexRollout(path.join(r.home, 'nowhere'), 'thread-1')).toBeNull();
    } finally {
      r.cleanup();
    }
  });

  // The latest reading wins, and one under its limit is no limit at all.
  it('reads the latest reading, and a reading under the limit is not limited', () => {
    const r = rolloutWith([tokenCount(100, 'primary'), tokenCount(40, null)]);
    try {
      const reading = readCodexRateLimits(r.file);
      expect(reading).toMatchObject({ planType: 'plus', reachedType: null });
      expect(reading?.windows[0]).toEqual({
        key: 'five_hour',
        usedPercent: 40,
        resetsAt: new Date(1790000000 * 1000).toISOString(),
      });
      expect(codexLimit(reading)).toBeNull();
    } finally {
      r.cleanup();
    }
  });

  // A full window is the hit's window; a reached type with no full window is a
  // hit of unknown window.
  it('reads a full window as the limit, and a bare reached type as window null', () => {
    const r = rolloutWith([tokenCount(40, null)]);
    try {
      appendFileSync(r.file, `${JSON.stringify(tokenCount(100, 'primary'))}\n`);
      expect(codexLimit(readCodexRateLimits(r.file))).toEqual({
        window: 'five_hour',
        resetsAt: new Date(1790000000 * 1000).toISOString(),
      });
      appendFileSync(r.file, `${JSON.stringify(tokenCount(90, 'secondary'))}\n`);
      expect(codexLimit(readCodexRateLimits(r.file))).toEqual({ window: null, resetsAt: null });
    } finally {
      r.cleanup();
    }
  });
});
