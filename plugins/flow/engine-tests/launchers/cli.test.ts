/**
 * The plain CLI launcher (spec `flow-handoff-dispatch` §2.3, task 2.1): the
 * shared contract suite (§2.7) once per runtime, plus the claude-code details
 * the contract does not cover.
 *
 * - claude-code: a fake `spawn`/`execFile` that records argv, env and cwd and
 *   writes a scripted stream log and transcript into temp config dirs.
 * - codex, opencode: real fake binaries (engine-tests/fixtures/cli-runtimes)
 *   that emit scripted JSON events, write a rollout or an exportable session,
 *   and run as real processes (see `cli-runtime-harness.ts`). Their details are
 *   in `cli-runtimes.test.ts`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ProcessRunner } from '../../scripts/cli/context.ts';
import {
  CLI_UNAVAILABLE_REASON,
  createCliLauncher,
  type CliLauncherDeps,
  type DetachedSpawn,
} from '../../scripts/launchers/cli.ts';
import {
  LaunchError,
  type LaunchAccount,
  type SessionHandle,
} from '../../scripts/launchers/types.ts';
import { makeCliRuntimeHarness } from './cli-runtime-harness.ts';
import {
  launcherContract,
  requestFor,
  type HarnessOptions,
  type HostCall,
  type HostSessionRecord,
  type LauncherHarness,
  type SessionScript,
} from './contract.ts';

/** One fake `claude` process. */
interface FakeProc {
  sessionId: string;
  alive: boolean;
  foreign: boolean;
  logFile: string;
  exit: (code: number | null) => void;
}

/** The cli harness plus the handles cli-only tests need. */
interface CliHarness extends LauncherHarness {
  /** The registered account; a Claude Code account always has a config dir. */
  account: LaunchAccount & { path: string };
  deps: CliLauncherDeps;
  procs: Map<number, FakeProc>;
  root: string;
}

/** Let `exit.then` callbacks (the launcher's exit-code writer) run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The project folder name Claude Code would use; any name works for the prover. */
const PROJECT_SLUG = '-fake-project';

/**
 * Build the cli harness: temp folders for the worktree, a registered account,
 * the ambient `~/.claude` and a stranger's config dir; a fake clock; and fake
 * process deps that play the scripted session.
 */
async function makeCliHarness(options: Omit<HarnessOptions, 'runtime'> = {}): Promise<CliHarness> {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-cli-launcher-')));
  const cwd = path.join(root, 'work tree');
  const osHome = path.join(root, 'home');
  const account = {
    runtime: 'claude-code' as const,
    id: 'claude3',
    path: path.join(root, 'accounts', 'claude3'),
  };
  const otherDir = path.join(root, 'accounts', 'someone-else');
  for (const dir of [cwd, osHome, account.path, otherDir]) mkdirSync(dir, { recursive: true });
  const promptFile = path.join(cwd, 'prompt.md');
  const messageFile = path.join(cwd, 'message.md');
  writeFileSync(promptFile, 'Do the work.\n');
  writeFileSync(messageFile, 'Address the review.\n');

  let clock = Date.parse('2026-09-26T18:00:00.000Z');
  let nextPid = 70_001;
  let nextScript: SessionScript = { confirm: 'confirmed' };
  const procs = new Map<number, FakeProc>();
  const spawned: HostSessionRecord[] = [];
  const calls: HostCall[] = [];
  const stopped: string[] = [];

  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ program: cmd, args, shell: false });
    void opts;
    if (args[0] === '--version') {
      if (options.hostMissing) {
        throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
      }
      return { code: 0, stdout: '2.1.282 (Claude Code)\n', stderr: '' };
    }
    if (cmd === 'ps') {
      const proc = procs.get(Number(args.at(-1)));
      if (proc === undefined || !proc.alive) return { code: 1, stdout: '', stderr: '' };
      const command = proc.foreign
        ? '/usr/bin/vim notes.txt'
        : `claude -p Read ... --session-id ${proc.sessionId}`;
      return { code: 0, stdout: `${command}\n`, stderr: '' };
    }
    return { code: 127, stdout: '', stderr: `unexpected command ${cmd}` };
  };

  const spawn: DetachedSpawn = (cmd, args, opts) => {
    calls.push({ program: cmd, args, shell: false });
    const flag = (name: string) => {
      const at = args.indexOf(name);
      return at < 0 ? undefined : args[at + 1];
    };
    const resumeId = flag('--resume');
    const sessionId = resumeId ?? flag('--session-id') ?? 'missing';
    spawned.push({
      kind: resumeId === undefined ? 'start' : 'resume',
      sessionId,
      cwd: opts.cwd,
      configDir: opts.env.CLAUDE_CONFIG_DIR,
      message: flag('-p') ?? null,
      childEnv: { ...opts.env },
    });
    const script = nextScript;
    nextScript = { confirm: 'confirmed' };
    const pid = nextPid++;
    if (script.confirm !== 'silent') {
      appendFileSync(
        opts.stdoutFile,
        `${JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, apiKeySource: script.apiKeySource ?? 'none' })}\n`
      );
      const configDir = script.confirm === 'other-account' ? otherDir : opts.env.CLAUDE_CONFIG_DIR;
      const dir = path.join(configDir, 'projects', PROJECT_SLUG);
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        path.join(dir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: 'user', sessionId })}\n`
      );
    }
    let resolveExit: (code: number | null) => void = () => undefined;
    const exit = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    procs.set(pid, {
      sessionId,
      alive: true,
      foreign: false,
      logFile: opts.stdoutFile,
      exit: resolveExit,
    });
    return { pid, exit };
  };

  const deps: CliLauncherDeps = {
    run,
    spawn,
    isAlive: (pid) => procs.get(pid)?.alive === true,
    kill: (pid) => {
      const proc = procs.get(pid);
      if (proc === undefined || !proc.alive)
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      proc.alive = false;
      stopped.push(proc.sessionId);
      proc.exit(null);
    },
    env: { PATH: '/usr/bin:/bin', ...options.supervisorEnv },
    osHome,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };

  /** Queued messages, as the host holds them: the inbox files. */
  function inboxRecords(): HostSessionRecord[] {
    const inbox = path.join(cwd, '.dork', 'flow', 'drain', 'inbox');
    if (!existsSync(inbox)) return [];
    const out: HostSessionRecord[] = [];
    for (const sessionId of readdirSync(inbox).sort()) {
      for (const file of readdirSync(path.join(inbox, sessionId)).sort()) {
        out.push({
          kind: 'message',
          sessionId,
          cwd,
          message: readFileSync(path.join(inbox, sessionId, file), 'utf8').replace(/\n$/, ''),
        });
      }
    }
    return out;
  }

  function procOf(handle: SessionHandle): FakeProc {
    const proc = handle.pid === undefined ? undefined : procs.get(handle.pid);
    if (proc === undefined) throw new Error(`no fake process for ${handle.sessionId}`);
    return proc;
  }

  return {
    launcher: createCliLauncher(deps),
    runtime: 'claude-code',
    mintsSessionId: false,
    accountBinding: 'config-dir',
    states: ['busy', 'exited', 'limited'],
    stopBehavior: 'pid',
    scrubsCredentials: true,
    reportsApiKeySource: true,
    account,
    ambientConfigDir: path.join(osHome, '.claude'),
    cwd,
    promptFile,
    messageFile,
    script: (script) => {
      nextScript = script;
    },
    signal: async (handle, signal) => {
      const proc = procOf(handle);
      if (signal.kind === 'busy') {
        proc.alive = true;
      } else if (signal.kind === 'exited') {
        proc.alive = false;
        proc.exit(0);
      } else if (signal.kind === 'limited') {
        const info = {
          status: 'rejected',
          rateLimitType: signal.window,
          resetsAt: Date.parse(signal.resetsAt) / 1000,
          utilization: 1,
        };
        appendFileSync(
          proc.logFile,
          `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429 })}\n`
        );
        proc.alive = false;
        proc.exit(1);
      } else {
        throw new Error('the cli host has no idle state');
      }
      await tick();
    },
    makeForeign: async (handle) => {
      procOf(handle).foreign = true;
    },
    sessions: () => [...spawned, ...inboxRecords()],
    calls: () => calls,
    stopped: () => stopped,
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
    deps,
    procs,
    root,
  };
}

// Real processes on a shared, loaded machine for codex and opencode.
vi.setConfig({ testTimeout: 120_000 });

launcherContract(
  'cli',
  (options) =>
    options.runtime === 'claude-code' ? makeCliHarness(options) : makeCliRuntimeHarness(options),
  ['claude-code', 'codex', 'opencode']
);

describe('cli launcher details', () => {
  // The probe reads the exit code, so a claude that answers non-zero is as
  // missing as one that is not on PATH.
  it('probe fails with the PATH reason when claude --version exits non-zero', async () => {
    const h = await makeCliHarness();
    try {
      const launcher = createCliLauncher({
        ...h.deps,
        run: async () => ({ code: 1, stdout: '', stderr: 'broken' }),
      });
      expect(await launcher.probe()).toEqual({ ok: false, reason: CLI_UNAVAILABLE_REASON });
    } finally {
      await h.cleanup();
    }
  });

  // The argv is exactly the spec's command line, and the log lands under the
  // worktree's drain folder.
  it('spawns claude -p with stream-json, the session id, the mode and the model', async () => {
    const h = await makeCliHarness();
    try {
      const req = requestFor(h, { model: 'claude-opus-4-7' });
      const handle = await h.launcher.start(req);
      const call = h.calls().find((c) => (c.args as string[]).includes('-p'));
      expect(call?.program).toBe('claude');
      expect(call?.args).toEqual([
        '-p',
        `Read ${h.promptFile} and do exactly what it says.`,
        '--session-id',
        req.sessionId,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--model',
        'claude-opus-4-7',
      ]);
      expect(handle.logFile).toBe(
        path.join(h.cwd, '.dork', 'flow', 'drain', 'logs', `${req.sessionId}.jsonl`)
      );
      expect(handle).toMatchObject({
        logOffset: 0,
        configDir: h.account.path,
        model: 'claude-opus-4-7',
      });
    } finally {
      await h.cleanup();
    }
  });

  // A resume passes the permission mode and model again (neither is restored
  // on resume) and appends to the same log.
  it('resumes with --resume, the same mode and model, and the same log', async () => {
    const h = await makeCliHarness();
    try {
      const handle = await h.launcher.start(requestFor(h, { model: 'sonnet' }));
      await h.signal(handle, { kind: 'exited' });
      const { handle: next } = await h.launcher.send(handle, h.messageFile);
      const resume = h
        .calls()
        .filter((c) => (c.args as string[]).includes('--resume'))
        .at(-1);
      expect(resume?.args).toEqual([
        '-p',
        `Read ${h.messageFile} and do exactly what it says.`,
        '--resume',
        handle.sessionId,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'acceptEdits',
        '--model',
        'sonnet',
      ]);
      expect(next.logFile).toBe(handle.logFile);
    } finally {
      await h.cleanup();
    }
  });

  // Exited carries the exit code the launcher recorded when the child exited.
  it('state reports the recorded exit code', async () => {
    const h = await makeCliHarness();
    try {
      const handle = await h.launcher.start(requestFor(h));
      await h.signal(handle, { kind: 'exited' });
      expect(await h.launcher.state(handle)).toEqual({ kind: 'exited', code: 0 });
    } finally {
      await h.cleanup();
    }
  });

  // A stream from a Claude Code without rate_limit_event: the transcript's
  // structured rate_limit entry still makes the session limited.
  it('state falls back to the transcript when the stream names no limit window', async () => {
    const h = await makeCliHarness();
    try {
      const handle = await h.launcher.start(requestFor(h));
      const transcript = path.join(
        h.account.path,
        'projects',
        PROJECT_SLUG,
        `${handle.sessionId}.jsonl`
      );
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          isApiErrorMessage: true,
          error: 'rate_limit',
          timestamp: '2026-09-26T18:05:00.000Z',
          quotaLimits: { rateLimitType: 'seven_day', resetsAt: 1790000000 },
          message: { content: [{ type: 'text', text: "You've hit your weekly limit" }] },
        })}\n`
      );
      await h.signal(handle, { kind: 'exited' });
      expect(await h.launcher.state(handle)).toEqual({
        kind: 'limited',
        window: 'seven_day',
        resetsAt: new Date(1790000000 * 1000).toISOString(),
      });
    } finally {
      await h.cleanup();
    }
  });

  // A child that dies before confirming fails fast with its stderr, rather
  // than waiting out the whole timeout.
  it('not-started quotes stderr when claude exits before confirming', async () => {
    const h = await makeCliHarness();
    try {
      h.script({ confirm: 'silent' });
      const spawnOriginal = h.deps.spawn;
      const launcher = createCliLauncher({
        ...h.deps,
        spawn: (cmd, args, opts) => {
          const child = spawnOriginal(cmd, args, opts);
          writeFileSync(opts.stderrFile, 'Error: Invalid API key\n');
          const proc = h.procs.get(child.pid);
          if (proc) proc.alive = false;
          return child;
        },
      });
      const started = Date.now();
      await expect(launcher.start(requestFor(h))).rejects.toMatchObject({
        code: 'not-started',
        message: expect.stringContaining('Invalid API key'),
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await h.cleanup();
    }
  });

  // send refuses a relative or missing message file before touching anything.
  it('send refuses a relative message file', async () => {
    const h = await makeCliHarness();
    try {
      const handle = await h.launcher.start(requestFor(h));
      await expect(h.launcher.send(handle, 'message.md')).rejects.toBeInstanceOf(LaunchError);
    } finally {
      await h.cleanup();
    }
  });
});
