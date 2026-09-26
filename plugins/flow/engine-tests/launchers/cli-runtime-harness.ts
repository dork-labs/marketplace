/**
 * The cli launcher's codex and opencode harness for the contract suite
 * (RUNTIMES.md R5): real fake binaries (engine-tests/fixtures/cli-runtimes) on a
 * temp PATH, started by the launcher's real detached spawn, so their pid, `ps`
 * line, signals and exit code are real. Only the clock is fake.
 *
 * A fake touches `FAKE_DIR/ready-<pid>` once it has written everything it
 * writes at start, and the harness's spawn blocks (real time) until it has, so
 * a loaded machine can never make the launcher's start timeout, or a test's
 * read of what the host recorded, race a slow process start.
 *
 * Not a test file itself; imported by cli.test.ts and cli-runtimes.test.ts.
 */

import { execFile } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';

import type { ProcessRunner } from '../../scripts/cli/context.ts';
import {
  createCliLauncher,
  realDetachedSpawn,
  type CliLauncherDeps,
  type DetachedSpawn,
} from '../../scripts/launchers/cli.ts';
import { pidExists } from '../../scripts/fleet/sessions.ts';
import type { LaunchAccount, SessionHandle } from '../../scripts/launchers/types.ts';
import type { HarnessOptions, HostCall, HostSessionRecord, LauncherHarness } from './contract.ts';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'cli-runtimes'
);

/** One run a fake binary recorded. */
export interface FakeRun {
  kind: 'start' | 'resume';
  sessionId: string;
  cwd: string | null;
  spawnCwd?: string;
  configDir?: string;
  provider?: string;
  message: string;
  argv: string[];
  env: Record<string, string>;
  pid: number;
}

/** The codex/opencode harness plus the handles runtime-only tests need. */
export interface CliRuntimeHarness extends LauncherHarness {
  deps: CliLauncherDeps;
  root: string;
  fakeDir: string;
  /** Every run the fake binary recorded, in order. */
  runs(): FakeRun[];
}

/** Real-time wait. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait (real time) until `check` holds, or give up after `ms`. */
async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(10);
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

/**
 * Build the harness for a codex or opencode cli session: a temp root with the
 * fake binary in `bin/`, the worktree, the account (a `CODEX_HOME`, or an
 * `openrouter` provider account), the ambient home, and the fake's state folder.
 *
 * @param options - The contract's options; `runtime` must be codex or opencode.
 * @returns The harness.
 */
export async function makeCliRuntimeHarness(options: HarnessOptions): Promise<CliRuntimeHarness> {
  const runtime = options.runtime;
  if (runtime === 'claude-code') throw new Error('claude-code uses the in-process cli harness');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `flow-cli-${runtime}-`)));
  const bin = path.join(root, 'bin');
  const fakeDir = path.join(root, 'fake');
  const cwd = path.join(root, 'work tree');
  const osHome = path.join(root, 'home');
  for (const dir of [bin, fakeDir, cwd, osHome]) mkdirSync(dir, { recursive: true });
  const binary = path.join(bin, runtime);
  if (!options.hostMissing) install(`fake-${runtime}.cjs`, binary, fakeDir);

  const account: LaunchAccount =
    runtime === 'codex'
      ? { runtime, id: 'codex2', path: path.join(root, 'accounts', 'codex2') }
      : { runtime, id: 'openrouter', path: null, provider: 'openrouter' };
  if (account.path !== null) mkdirSync(account.path, { recursive: true });
  if (account.provider !== undefined) {
    writeFileSync(path.join(fakeDir, 'default-provider'), account.provider);
  }
  const promptFile = path.join(cwd, 'prompt.md');
  const messageFile = path.join(cwd, 'message.md');
  writeFileSync(promptFile, 'Do the work.\n');
  writeFileSync(messageFile, 'Address the review.\n');

  let clock = Date.parse('2026-09-26T18:00:00.000Z');
  const calls: HostCall[] = [];
  const stopped: string[] = [];
  const foreign = new Set<number>();
  const spawned: number[] = [];
  const childPath = `${bin}:/usr/bin:/bin`;

  const runs = (): FakeRun[] => {
    const file = path.join(fakeDir, 'runs.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as FakeRun);
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

  const spawn: DetachedSpawn = (cmd, args, opts) => {
    calls.push({ program: cmd, args, shell: false });
    const child = realDetachedSpawn(cmd, args, opts);
    spawned.push(child.pid);
    // Block (real time) until the fake has written everything it writes at
    // start, so what the host recorded is on disk when the launcher returns,
    // as it would be for the cmux fake. Bounded; a fake that died is not waited on.
    const ready = path.join(fakeDir, `ready-${child.pid}`);
    const end = Date.now() + 30_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(ready) && pidExists(child.pid) && Date.now() < end) {
      Atomics.wait(pause, 0, 0, 10);
    }
    return child;
  };

  const deps: CliLauncherDeps = {
    run,
    spawn,
    isAlive: pidExists,
    kill: (pid, signal) => {
      const sessionId = runs().find((r) => r.pid === pid)?.sessionId;
      process.kill(pid, signal);
      if (sessionId !== undefined) stopped.push(sessionId);
    },
    env: { PATH: childPath, ...options.supervisorEnv },
    osHome,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await delay(2);
    },
    codexBin: path.join(bin, 'codex'),
    opencodeBin: path.join(bin, 'opencode'),
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

  /** Signal the handle's fake, wait until it is gone and its exit code is recorded. */
  async function exit(handle: SessionHandle, signal: NodeJS.Signals): Promise<void> {
    const pid = handle.pid as number;
    process.kill(pid, signal);
    await until(() => !pidExists(pid));
    const exitFile = (handle.logFile as string).replace(/\.jsonl$/, '') + '.exit.json';
    await until(() => existsSync(exitFile) && readFileSync(exitFile, 'utf8').includes(`${pid}`));
  }

  return {
    launcher: createCliLauncher(deps),
    runtime,
    mintsSessionId: true,
    accountBinding: runtime === 'codex' ? 'config-dir' : 'provider',
    states: runtime === 'codex' ? ['busy', 'exited', 'limited'] : ['busy', 'exited'],
    stopBehavior: 'pid',
    scrubsCredentials: runtime === 'codex',
    reportsApiKeySource: false,
    account,
    ambientConfigDir: path.join(osHome, '.codex'),
    cwd,
    promptFile,
    messageFile,
    script: (script) =>
      writeFileSync(path.join(fakeDir, 'next-script.json'), JSON.stringify(script)),
    signal: async (handle, signal) => {
      if (signal.kind === 'busy') return;
      if (signal.kind === 'exited') return exit(handle, 'SIGUSR2');
      if (signal.kind === 'limited' && runtime === 'codex') {
        const rollout = readdirSync(
          path.join(handle.configDir as string, 'sessions', '2026', '09', '26')
        )
          .map((name) =>
            path.join(handle.configDir as string, 'sessions', '2026', '09', '26', name)
          )
          .find((file) => file.includes(handle.sessionId));
        if (rollout === undefined) throw new Error(`no rollout for ${handle.sessionId}`);
        appendFileSync(
          rollout,
          `${JSON.stringify({
            timestamp: '2026-09-26T18:05:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              rate_limits: {
                primary: {
                  used_percent: 100,
                  window_minutes: 300,
                  resets_at: Date.parse(signal.resetsAt) / 1000,
                },
                secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1790500000 },
                plan_type: 'pro',
                rate_limit_reached_type: 'primary',
              },
            },
          })}\n`
        );
        return exit(handle, 'SIGUSR1');
      }
      throw new Error(`the cli ${runtime} host has no ${signal.kind} state`);
    },
    makeForeign: async (handle) => {
      foreign.add(handle.pid as number);
    },
    sessions: () => [
      ...runs().map((r): HostSessionRecord => ({
        kind: r.kind,
        sessionId: r.sessionId,
        cwd: r.cwd,
        ...(r.configDir === undefined ? {} : { configDir: r.configDir }),
        ...(r.provider === undefined ? {} : { provider: r.provider }),
        message: r.message,
        childEnv: r.env,
      })),
      ...inboxRecords(),
    ],
    calls: () => calls,
    stopped: () => stopped,
    cleanup: async () => {
      for (const pid of spawned) {
        if (pidExists(pid)) process.kill(pid, 'SIGKILL');
      }
      await until(() => spawned.every((pid) => !pidExists(pid)), 5_000);
      rmSync(root, { recursive: true, force: true });
    },
    deps,
    root,
    fakeDir,
    runs,
  };
}
