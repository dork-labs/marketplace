/**
 * The cmux launcher (spec `flow-handoff-dispatch` §2.4, task 2.2): the shared
 * contract suite (§2.7) against a fake `cmux` executable on a temp PATH, plus
 * the cmux-only details the contract does not cover.
 *
 * The fake (engine-tests/fixtures/cmux/fake-cmux.cjs) records every argv and
 * runs the `--command` line through a real `/bin/sh`, so the quoting and the
 * `env -u` prefix are tested by a real shell, and the fake `claude` it starts
 * (fake-claude.cjs) is a real process: its pid, `ps` line and SIGTERM are real.
 * Only the clock is fake, and every file the launcher polls is written before
 * the fake cmux returns, so a fake clock never races a real process.
 */

import { execFile } from 'node:child_process';
import {
  appendFileSync,
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
import { describe, expect, it, vi } from 'vitest';

import type { ProcessRunner } from '../../scripts/cli/context.ts';
import {
  createCmuxLauncher,
  surfaceForPid,
  type CmuxLauncherDeps,
} from '../../scripts/launchers/cmux.ts';
import { pidExists } from '../../scripts/cli/host-io.ts';
import type { LaunchAccount, RuntimeName, SessionHandle } from '../../scripts/launchers/types.ts';
import {
  launcherContract,
  requestFor,
  type HarnessOptions,
  type HostCall,
  type HostSessionRecord,
  type LauncherHarness,
} from './contract.ts';

// Every case starts real (if tiny) processes on a shared, loaded machine.
vi.setConfig({ testTimeout: 120_000 });

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cmux');

/** How a cmux harness is built, beyond the contract's options. */
interface CmuxHarnessOptions extends Omit<HarnessOptions, 'runtime'> {
  /** Ignored beyond the contract's bookkeeping: cmux runs claude-code only. */
  runtime?: RuntimeName;
  /** The account's config dir name (lets a case put a space, quote and `$` in it). */
  accountDirName?: string;
}

/** One fake claude registration. */
interface ClaudeRecord {
  pid: number;
  ppid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

/** One `cmux send` the fake played. */
interface Delivery {
  surface: string;
  pid: number;
  message: string;
  submitted: boolean;
}

/** The cmux harness plus the handles cmux-only tests need. */
interface CmuxHarness extends LauncherHarness {
  /** The registered account; cmux accounts always have a config dir. */
  account: LaunchAccount & { path: string };
  deps: CmuxLauncherDeps;
  root: string;
  /** Every argv the fake cmux received, with the path it was run as. */
  cmuxArgv(): { bin: string; argv: string[] }[];
  /** Every fake claude that started. */
  claudes(): ClaudeRecord[];
  /** Every message the fake cmux delivered. */
  deliveries(): Delivery[];
  /** The fake cmux's state (surfaces and workspace titles). */
  fakeState(): {
    surfaces: Record<string, { workspace: string; claudePid: number | null }>;
    workspaces: Record<string, { title: string }>;
  };
  /** Script the fake cmux's reply to one command. */
  control(value: Record<string, unknown>): void;
  /** Simulate a cmux restart: every surface gets a new number. */
  renumberSurfaces(): void;
}

/** Read a JSON-lines file (missing: none). */
function lines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

/** Install a fixture as an executable under `bin`. */
function install(fixture: string, target: string, fakeDir: string): void {
  const body = readFileSync(path.join(FIXTURES, fixture), 'utf8');
  writeFileSync(
    target,
    `#!${process.execPath}\nconst FAKE_DIR = ${JSON.stringify(fakeDir)};\n${body}`,
    { mode: 0o755 }
  );
}

/** Wait (real time) until a pid is gone. */
async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 250 && pidExists(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Build the cmux harness: a temp root with `bin/cmux` and `bin/claude`, the
 * worktree, a registered account, the ambient `~/.claude`, and the fake's
 * state folder; a fake clock; real process checks.
 */
async function makeCmuxHarness(options: CmuxHarnessOptions = {}): Promise<CmuxHarness> {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-cmux-launcher-')));
  const bin = path.join(root, 'bin');
  const fakeDir = path.join(root, 'fake');
  const cwd = path.join(root, 'work tree');
  const osHome = path.join(root, 'home');
  const account: LaunchAccount & { path: string } = {
    runtime: 'claude-code',
    id: 'claude3',
    path: path.join(root, 'accounts', options.accountDirName ?? 'claude3'),
  };
  for (const dir of [bin, fakeDir, cwd, osHome, account.path]) mkdirSync(dir, { recursive: true });
  if (!options.hostMissing) {
    install('fake-cmux.cjs', path.join(bin, 'cmux'), fakeDir);
    install('fake-cmux.cjs', path.join(bin, 'cmux-bundled'), fakeDir);
  }
  install('fake-claude.cjs', path.join(bin, 'claude'), fakeDir);
  const promptFile = path.join(cwd, 'prompt.md');
  const messageFile = path.join(cwd, 'message.md');
  writeFileSync(promptFile, 'Do the work.\n');
  writeFileSync(messageFile, 'Address the review.\n');

  let clock = Date.parse('2026-09-26T18:00:00.000Z');
  const calls: HostCall[] = [];
  const stopped: string[] = [];
  const foreign = new Set<number>();
  // The real cmux is on the developer's PATH; the harness's PATH must not find it.
  const childPath = `${bin}:/usr/bin:/bin`;

  const claudes = () => lines<ClaudeRecord>(path.join(fakeDir, 'claudes.jsonl'));
  const deliveries = () => lines<Delivery>(path.join(fakeDir, 'deliveries.jsonl'));
  const sessionIdOf = (record: ClaudeRecord) => {
    const at = record.argv.findIndex((a) => a === '--resume' || a === '--session-id');
    return record.argv[at + 1] ?? 'missing';
  };
  const sessionOfPid = (pid: number) => {
    const record = claudes().find((c) => c.pid === pid);
    return record === undefined ? undefined : sessionIdOf(record);
  };

  const run: ProcessRunner = (cmd, args, opts = {}) => {
    calls.push({ program: cmd, args, shell: false });
    if (cmd === 'ps' && foreign.has(Number(args.at(-1)))) {
      return Promise.resolve({ code: 0, stdout: '/usr/bin/vim notes.txt\n', stderr: '' });
    }
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        [...args],
        {
          env: { PATH: childPath, HOME: osHome },
          timeout: opts.timeoutMs ?? 60_000,
          encoding: 'utf8',
          shell: false,
        },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') {
            reject(error);
            return;
          }
          resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
        }
      );
    });
  };

  const deps: CmuxLauncherDeps = {
    run,
    isAlive: pidExists,
    kill: (pid, signal) => {
      const sessionId = sessionOfPid(pid);
      process.kill(pid, signal);
      if (sessionId !== undefined) stopped.push(sessionId);
    },
    env: { PATH: '/usr/bin:/bin', ...options.supervisorEnv },
    osHome,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };

  function sessions(): HostSessionRecord[] {
    const delivered = deliveries();
    const firstTo = new Map<number, Delivery>();
    for (const d of delivered) if (!firstTo.has(d.pid)) firstTo.set(d.pid, d);
    const out: HostSessionRecord[] = claudes().map((c) => ({
      kind: c.argv.includes('--resume') ? 'resume' : 'start',
      sessionId: sessionIdOf(c),
      cwd: c.cwd,
      configDir: c.env.CLAUDE_CONFIG_DIR,
      message: firstTo.get(c.pid)?.message ?? null,
      childEnv: c.env,
    }));
    for (const d of delivered) {
      if (firstTo.get(d.pid) === d) continue;
      out.push({
        kind: 'message',
        sessionId: sessionOfPid(d.pid) ?? 'missing',
        cwd: claudes().find((c) => c.pid === d.pid)?.cwd ?? null,
        message: d.message,
      });
    }
    return out;
  }

  function sessionFile(handle: SessionHandle): string {
    if (handle.pid === undefined || handle.configDir === undefined) {
      throw new Error(`the handle for ${handle.sessionId} has no pid or config dir`);
    }
    return path.join(handle.configDir, 'sessions', `${handle.pid}.json`);
  }

  function setStatus(handle: SessionHandle, status: string): void {
    const file = sessionFile(handle);
    const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...current, status }));
  }

  const statePath = path.join(fakeDir, 'state.json');

  return {
    launcher: createCmuxLauncher(deps),
    runtime: 'claude-code',
    mintsSessionId: false,
    accountBinding: 'config-dir',
    states: ['busy', 'idle', 'exited', 'limited'],
    stopBehavior: 'pid',
    scrubsCredentials: true,
    reportsApiKeySource: false,
    account,
    ambientConfigDir: path.join(osHome, '.claude'),
    cwd,
    promptFile,
    messageFile,
    script: (script) =>
      writeFileSync(path.join(fakeDir, 'next-script.json'), JSON.stringify(script)),
    signal: async (handle, signal) => {
      if (signal.kind === 'busy' || signal.kind === 'idle') {
        setStatus(handle, signal.kind);
      } else if (signal.kind === 'exited') {
        if (handle.pid !== undefined) {
          process.kill(handle.pid, 'SIGTERM');
          await waitGone(handle.pid);
        }
      } else {
        setStatus(handle, 'idle');
        const transcript = path.join(
          handle.configDir ?? '',
          'projects',
          '-fake-project',
          `${handle.sessionId}.jsonl`
        );
        appendFileSync(
          transcript,
          `${JSON.stringify({
            type: 'assistant',
            isApiErrorMessage: true,
            error: 'rate_limit',
            timestamp: '2026-09-26T18:05:00.000Z',
            quotaLimits: {
              rateLimitType: signal.window,
              resetsAt: Date.parse(signal.resetsAt) / 1000,
            },
            message: { content: [{ type: 'text', text: "You've hit your session limit" }] },
          })}\n`
        );
      }
    },
    makeForeign: async (handle) => {
      if (handle.pid !== undefined) foreign.add(handle.pid);
    },
    sessions,
    calls: () => calls,
    stopped: () => stopped,
    cleanup: async () => {
      for (const c of claudes()) {
        if (pidExists(c.pid)) {
          try {
            process.kill(c.pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
    deps,
    root,
    cmuxArgv: () => lines(path.join(fakeDir, 'argv.jsonl')),
    claudes,
    deliveries,
    fakeState: () => JSON.parse(readFileSync(statePath, 'utf8')),
    control: (value) => writeFileSync(path.join(fakeDir, 'control.json'), JSON.stringify(value)),
    renumberSurfaces: () => {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
        surfaces: Record<string, unknown>;
      };
      state.surfaces = Object.fromEntries(
        Object.entries(state.surfaces).map(([ref, entry]) => [
          `surface:${Number(ref.split(':')[1]) + 100}`,
          entry,
        ])
      );
      writeFileSync(statePath, JSON.stringify(state));
    },
  };
}

/** Run a cmux-only case with a harness, always cleaning up. */
async function withCmux(
  options: CmuxHarnessOptions,
  body: (h: CmuxHarness) => Promise<void>
): Promise<void> {
  const h = await makeCmuxHarness(options);
  try {
    await body(h);
  } finally {
    await h.cleanup();
  }
}

/** The fake cmux's argv for one subcommand. */
function argvOf(h: CmuxHarness, ...sub: string[]): string[][] {
  return h
    .cmuxArgv()
    .map((c) => c.argv)
    .filter((argv) => sub.every((s, i) => argv[i] === s));
}

const STRIP = 'env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN';

launcherContract('cmux', makeCmuxHarness, ['claude-code']);

describe('cmux launcher details', () => {
  // A cmux whose socket is down answers identify non-zero; the probe quotes
  // the first stderr line so the operator sees cmux's own words.
  it('probe quotes the first stderr line of a failed identify', async () => {
    await withCmux({}, async (h) => {
      h.control({ identify: { code: 1, stderr: 'Error: Socket not found\nmore detail\n' } });
      expect(await h.launcher.probe()).toEqual({
        ok: false,
        reason: 'cmux is not running (Error: Socket not found)',
      });
    });
  });

  // CMUX_BUNDLED_CLI_PATH names the binary when set (cmux sets it inside its
  // own terminals); `cmux` on PATH is only the fallback.
  it('runs CMUX_BUNDLED_CLI_PATH when set', async () => {
    const bundled = { value: '' };
    const h = await makeCmuxHarness();
    try {
      bundled.value = path.join(h.root, 'bin', 'cmux-bundled');
      const launcher = createCmuxLauncher({
        ...h.deps,
        env: { ...h.deps.env, CMUX_BUNDLED_CLI_PATH: bundled.value },
      });
      expect(await launcher.probe()).toEqual({ ok: true });
      expect(h.calls().at(-1)?.program).toBe(bundled.value);
      expect(h.cmuxArgv().at(-1)?.bin).toBe(bundled.value);
    } finally {
      await h.cleanup();
    }
  });

  // The workspace is created with exactly the spec's argv, and the --command
  // line names a config dir holding a space, a quote and `$` so that a real
  // shell hands claude that exact path.
  it('passes a --command line a real shell turns back into the exact config dir', async () => {
    await withCmux({ accountDirName: `it's $HOME "x"` }, async (h) => {
      const req = requestFor(h, { model: 'opus[1m]' });
      const handle = await h.launcher.start(req);
      const [create] = argvOf(h, 'workspace', 'create');
      const quotedDir = `'${h.account.path.replace(/'/g, `'\\''`)}'`;
      expect(create).toEqual([
        'workspace',
        'create',
        '--name',
        'ACME-12 worker',
        '--cwd',
        h.cwd,
        '--focus',
        'false',
        '--json',
        '--command',
        `${STRIP} CLAUDE_CONFIG_DIR=${quotedDir} claude --session-id ${req.sessionId} --permission-mode acceptEdits --model 'opus[1m]'`,
      ]);
      const claude = h.claudes()[0];
      expect(claude?.env.CLAUDE_CONFIG_DIR).toBe(h.account.path);
      expect(claude?.argv).toEqual([
        '--session-id',
        req.sessionId,
        '--permission-mode',
        'acceptEdits',
        '--model',
        'opus[1m]',
      ]);
      expect(handle).toMatchObject({
        host: 'cmux',
        pid: claude?.pid,
        workspace: 'workspace:1',
        surface: 'surface:1',
        configDir: h.account.path,
        permissionMode: 'acceptEdits',
        model: 'opus[1m]',
        title: 'ACME-12 worker',
      });
    });
  });

  // Messages go to the surface, never the workspace (which hits whatever
  // surface is selected), and end with cmux's literal \n so they submit.
  it('sends with --surface and a trailing \\n, never --workspace', async () => {
    await withCmux({}, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      await h.launcher.send(handle, h.messageFile);
      const sends = argvOf(h, 'send');
      expect(sends).toEqual([
        [
          'send',
          '--surface',
          'surface:1',
          '--',
          `Read ${h.promptFile} and do exactly what it says.\\n`,
        ],
        [
          'send',
          '--surface',
          'surface:1',
          '--',
          `Read ${h.messageFile} and do exactly what it says.\\n`,
        ],
      ]);
      expect(h.deliveries().every((d) => d.submitted)).toBe(true);
    });
  });

  // Surface numbers change across a cmux restart: send finds the session's
  // surface again from its pid instead of trusting the handle's.
  it('re-resolves the surface from the pid after a restart renumbers it', async () => {
    await withCmux({}, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      expect(handle.surface).toBe('surface:1');
      h.renumberSurfaces();
      const sent = await h.launcher.send(handle, h.messageFile);
      expect(sent.result).toBe('delivered');
      expect(sent.handle.surface).toBe('surface:101');
      expect(argvOf(h, 'send').at(-1)?.slice(0, 3)).toEqual(['send', '--surface', 'surface:101']);
      expect(h.deliveries().at(-1)).toMatchObject({
        pid: handle.pid,
        message: `Read ${h.messageFile} and do exactly what it says.`,
      });
    });
  });

  // A resume is a new workspace running `claude --resume` with the permission
  // mode and model passed again (neither is restored) on the same account.
  it('resumes an exited session in a new workspace with --resume, the mode and the model', async () => {
    await withCmux({}, async (h) => {
      const handle = await h.launcher.start(requestFor(h, { model: 'sonnet' }));
      await h.signal(handle, { kind: 'exited' });
      const { handle: next } = await h.launcher.send(handle, h.messageFile);
      const create = argvOf(h, 'workspace', 'create').at(-1);
      expect(create?.at(-1)).toBe(
        `${STRIP} CLAUDE_CONFIG_DIR='${h.account.path}' claude --resume ${handle.sessionId} --permission-mode acceptEdits --model 'sonnet'`
      );
      expect(next.workspace).toBe('workspace:2');
      expect(next.surface).toBe('surface:2');
      expect(next.pid).toBe(h.claudes().at(-1)?.pid);
    });
  });

  // stop leaves the workspace open for the operator to read, renamed so it is
  // plainly finished.
  it('stop renames the workspace "<title> (stopped)" and leaves it open', async () => {
    await withCmux({}, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      expect(await h.launcher.stop(handle)).toBe('stopped');
      expect(argvOf(h, 'workspace', 'rename')).toEqual([
        ['workspace', 'rename', 'workspace:1', '--title', 'ACME-12 worker (stopped)'],
      ]);
      expect(h.fakeState().workspaces['workspace:1']?.title).toBe('ACME-12 worker (stopped)');
      expect(argvOf(h, 'workspace', 'close')).toEqual([]);
    });
  });

  // A limit that a later message cleared does not outlive the turn: a busy
  // session is busy even when an older limit sits in its transcript.
  it('state: busy wins over an older limit in the transcript', async () => {
    await withCmux({}, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      await h.signal(handle, {
        kind: 'limited',
        window: 'five_hour',
        resetsAt: '2026-09-26T20:00:00.000Z',
      });
      await h.signal(handle, { kind: 'busy' });
      expect(await h.launcher.state(handle)).toEqual({ kind: 'busy' });
    });
  });

  // cmux reads a backslash in `send` text as an escape (\t is Tab), so a file
  // path holding one is refused before anything starts.
  it('refuses a prompt file whose path holds a backslash', async () => {
    await withCmux({}, async (h) => {
      const promptFile = path.join(h.cwd, 'a\\tb.md');
      writeFileSync(promptFile, 'x\n');
      await expect(h.launcher.start(requestFor(h, { promptFile }))).rejects.toMatchObject({
        code: 'bad-request',
      });
      expect(h.claudes()).toEqual([]);
    });
  });
});

describe('surfaceForPid', () => {
  const tsv = [
    '0.0\t0\t3\tworkspace\tworkspace:4\twindow:1\tACME',
    '0.0\t0\t2\ttag\tworkspace:ABC:tag:claude_code\tworkspace:4\tRunning',
    '0.0\t0\t1\tprocess\t501\tworkspace:ABC:tag:claude_code\tclaude',
    '0.0\t0\t1\tsurface\tsurface:9\tpane:9\t',
    '0.0\t0\t2\tprocess\t400\tsurface:9\tzsh',
    '0.0\t0\t1\tprocess\t501\t400\tclaude',
    '0.0\t0\t1\tprocess\t777\tsurface:3\tclaude',
  ].join('\n');

  // A claude under a login shell is found through its parent chain, and the
  // status-tag row that also lists it is not mistaken for its surface.
  it('walks the process chain to its surface and ignores tag rows', () => {
    expect(surfaceForPid(tsv, 501)).toBe('surface:9');
    expect(surfaceForPid(tsv, 777)).toBe('surface:3');
    expect(surfaceForPid(tsv, 999)).toBeNull();
  });
});
