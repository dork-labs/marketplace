/**
 * The launcher contract suite (spec `flow-handoff-dispatch` §2.7): one set of
 * cases every {@link Launcher} must pass, each asserted on what the fake host
 * recorded, not on the launcher's return value alone.
 *
 * A launcher's test file calls {@link launcherContract} with a
 * {@link MakeHarness} that wires the launcher to a fake host: the cli harness
 * fakes `spawn`/`execFile`; the cmux harness puts a fake `cmux` executable on a
 * temp PATH; the DorkOS harness runs an in-process `node:http` server. The suite
 * never knows which: everything host-specific sits behind
 * {@link LauncherHarness}, and the few real differences between hosts are
 * declared as harness capabilities (`accountBinding`, `states`, `stopBehavior`,
 * `scrubsCredentials`, `reportsApiKeySource`, `mintsSessionId`) rather than
 * branched on by name.
 *
 * Runtime-aware (RUNTIMES.md R5): a launcher's test file declares the runtimes
 * its host supports, the whole suite runs once per (host, runtime) pair, and
 * every runtime it does NOT declare is checked to be refused as `unsupported`
 * with its reason, starting nothing.
 *
 * Not a test file itself (no `.test.ts`), so vitest runs it only through the
 * launcher test files that import it.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { shellQuote } from '../../scripts/launchers/shell-quote.ts';
import {
  LaunchError,
  RUNTIME_NAMES,
  type LaunchAccount,
  type LaunchErrorCode,
  type LaunchRequest,
  type Launcher,
  type RuntimeName,
  type SessionHandle,
} from '../../scripts/launchers/types.ts';

/**
 * Per runtime, the credential variables no child may inherit (spec §2.1 "No
 * other credential rides along"; RUNTIMES.md R5). Written out here, not
 * imported, so the suite pins them. opencode has none: its account IS the
 * ambient provider credential.
 */
export const CREDENTIAL_VARS: Readonly<Record<RuntimeName, readonly string[]>> = {
  'claude-code': [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    // Not keys, but each routes the session to another biller than the login.
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_BASE_URL',
  ],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'],
  opencode: [],
};

/** Per runtime, the variable a `config-dir` host names the account's home in. */
const HOME_VAR: Readonly<Record<RuntimeName, string | null>> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  opencode: null,
};

/** How a harness is built for one case. */
export interface HarnessOptions {
  /** The runtime the harness's sessions run on. */
  runtime: RuntimeName;
  /** Variables added to the supervisor's environment the launcher is given. */
  supervisorEnv?: Record<string, string>;
  /**
   * Variables added to the supervisor's environment that depend on the
   * harness's own OS home (`config-dir` Claude Code hosts honor it).
   */
  supervisorEnvFor?: (osHome: string) => Record<string, string>;
  /** Build the host as absent: its probe must fail and nothing may start. */
  hostMissing?: boolean;
}

/**
 * How the next session the fake host starts or resumes behaves.
 *
 * - `confirmed`: it runs on the config dir or account the launcher asked for,
 *   and shows it the way the real host would (a transcript, a busy status, the
 *   session's `account` field).
 * - `silent`: it never confirms anything.
 * - `other-account`: it runs, but on a different account (its transcript lands
 *   under another config dir; DorkOS reports another `account`).
 */
export interface SessionScript {
  /** What the session shows. */
  confirm: 'confirmed' | 'silent' | 'other-account';
  /** Hosts with `reportsApiKeySource`: the `apiKeySource` its init reports. Default `none`. */
  apiKeySource?: string;
}

/** A state the fake host can be put in for a started session. */
export type HostSignal =
  | { kind: 'busy' }
  | { kind: 'idle' }
  | { kind: 'exited' }
  | { kind: 'limited'; window: string; resetsAt: string };

/** One session-level thing the fake host saw: a start, a resume, or a later message. */
export interface HostSessionRecord {
  /** What happened. A queued message counts as `message`, as the host holds it. */
  kind: 'start' | 'resume' | 'message';
  /** The session id the host saw. */
  sessionId: string;
  /** The folder the session runs in, when the host was told one. */
  cwd: string | null;
  /** `config-dir` hosts: the runtime home the child got (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). */
  configDir?: string;
  /** `provider` hosts: the provider the session bills. */
  provider?: string;
  /** `account-id` hosts: the `account` the request carried; `undefined` when omitted. */
  accountId?: string;
  /** The message text the session received (or has queued), exactly. */
  message: string | null;
  /** `config-dir` and `provider` hosts: the environment the runtime child sees. */
  childEnv?: Readonly<Record<string, string | undefined>>;
}

/** One command the launcher ran on the fake host. HTTP hosts record none. */
export interface HostCall {
  /** The program. */
  program: string;
  /** Its arguments exactly as passed (the suite checks it is an array). */
  args: unknown;
  /** Whether a shell was asked for. */
  shell: boolean;
}

/**
 * A launcher wired to a scriptable fake host, with the fake's record.
 *
 * Paths (`cwd`, `promptFile`, `messageFile`, `account.path`,
 * `ambientConfigDir`) are real absolute paths in a temp folder the harness owns;
 * `cleanup` removes them.
 */
export interface LauncherHarness {
  /** The launcher under test, built with the fake host's deps. */
  launcher: Launcher;
  /** The runtime this harness's sessions run on. */
  runtime: RuntimeName;
  /**
   * How the host names the account: a runtime home in the child env, an
   * account id in a request, or (opencode) the provider the session bills.
   */
  accountBinding: 'config-dir' | 'account-id' | 'provider';
  /** Whether the runtime mints its own session id, replacing the request's (codex, opencode). */
  mintsSessionId: boolean;
  /** The states the host can report, so case 8 checks exactly those. */
  states: readonly HostSignal['kind'][];
  /** `pid`: stop signals a recorded pid (after the ps check). `left-idle`: the host has no stop. */
  stopBehavior: 'pid' | 'left-idle';
  /** Whether the launcher builds the child's environment (and so must strip credentials). */
  scrubsCredentials: boolean;
  /** Whether the host reports `apiKeySource` on an init message the launcher must check. */
  reportsApiKeySource: boolean;
  /** A registered account whose config dir exists. */
  account: LaunchAccount;
  /**
   * What the supervisor's ambient account resolves to (its `CLAUDE_CONFIG_DIR`,
   * else `~/.claude`; its `CODEX_HOME`, else `~/.codex`). Unused by `provider` hosts.
   */
  ambientConfigDir: string;
  /** An existing absolute working folder. */
  cwd: string;
  /** An existing absolute prompt file. */
  promptFile: string;
  /** An existing absolute message file for `send`. */
  messageFile: string;
  /** Script the next session the host starts or resumes. Default `confirmed`. */
  script(script: SessionScript): void;
  /** Put a started session into a state. */
  signal(handle: SessionHandle, signal: HostSignal): Promise<void>;
  /** `pid` hosts: make the handle's pid run a command that is not `claude` (a reused pid). */
  makeForeign(handle: SessionHandle): Promise<void>;
  /**
   * `pid` hosts: make the handle's pid a REUSED one that runs a real-looking
   * process of the same runtime, started at another time, whose command line
   * names the handle's own session (`same`) or another one (`other`).
   */
  makeReused(handle: SessionHandle, session: 'same' | 'other'): Promise<void>;
  /** Every session-level record, in order. */
  sessions(): readonly HostSessionRecord[];
  /** Every command run, in order. */
  calls(): readonly HostCall[];
  /** Session ids whose process the host saw signalled to stop. */
  stopped(): readonly string[];
  /** Remove every temp file and stop any fake server. */
  cleanup(): Promise<void>;
}

/** Builds a fresh harness for one case. */
export type MakeHarness = (options: HarnessOptions) => Promise<LauncherHarness>;

let counter = 0;

/** A fresh session id per request, so cases never share one. */
function freshSessionId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

/** A valid request against the harness's folders. */
export function requestFor(
  h: LauncherHarness,
  overrides: Partial<LaunchRequest> = {}
): LaunchRequest {
  return {
    role: 'worker',
    runtime: h.runtime,
    identifier: 'ACME-12',
    account: h.account,
    cwd: h.cwd,
    promptFile: h.promptFile,
    sessionId: freshSessionId(),
    permissionMode: 'acceptEdits',
    title: 'ACME-12 worker',
    ...overrides,
  };
}

/** The one line every message must be. Written out here, not imported, so the suite pins it. */
function pointer(file: string): string {
  return `Read ${file} and do exactly what it says.`;
}

/** Await a launcher call that must fail, and return its error code and message. */
async function failure(
  promise: Promise<unknown>
): Promise<{ code: LaunchErrorCode; message: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchError);
    return { code: (error as LaunchError).code, message: (error as LaunchError).message };
  }
  throw new Error('expected the call to throw a LaunchError');
}

/** Run a case with a harness, always cleaning up. */
async function withHarness<O>(
  make: (options: O) => Promise<LauncherHarness>,
  options: O,
  body: (h: LauncherHarness) => Promise<void>
): Promise<void> {
  const h = await make(options);
  try {
    await body(h);
  } finally {
    await h.cleanup();
  }
}

/** The record of the session's start. */
function startRecord(h: LauncherHarness, sessionId: string): HostSessionRecord {
  const found = h.sessions().find((r) => r.kind === 'start' && r.sessionId === sessionId);
  expect(found, `the host recorded no start for ${sessionId}`).toBeDefined();
  return found as HostSessionRecord;
}

/**
 * The shared launcher contract (spec §2.7, cases 1-12), once per runtime the
 * host supports, plus the unsupported-pair cases for every runtime it does not.
 * Call once per launcher.
 *
 * @param name - The launcher's name, for the describe block.
 * @param make - Builds a harness per case, for the runtime in its options.
 * @param runtimes - The runtimes this host supports (the rest must be refused).
 */
export function launcherContract(
  name: string,
  make: MakeHarness,
  runtimes: readonly RuntimeName[]
): void {
  for (const runtime of runtimes) {
    runtimeContract(`${name} × ${runtime}`, (options) => make({ ...options, runtime }));
  }
  const unsupported = RUNTIME_NAMES.filter((r) => !runtimes.includes(r));
  describe(`launcher contract: ${name} refuses what it cannot run`, () => {
    // Case 13: supports() says yes for exactly the declared runtimes.
    it('13. supports() agrees with the runtimes the host declares', async () => {
      await withHarness(make, { runtime: runtimes[0] as RuntimeName }, async (h) => {
        for (const runtime of RUNTIME_NAMES) {
          expect(h.launcher.supports(runtime).ok, runtime).toBe(runtimes.includes(runtime));
        }
      });
    });

    // Case 14: an unsupported (host, runtime) pair is reported with its reason,
    // never guessed around: start throws `unsupported`, runs nothing, starts nothing.
    for (const runtime of unsupported) {
      it(`14. ${runtime}: start throws unsupported with the reason and starts nothing`, async () => {
        await withHarness(make, { runtime: runtimes[0] as RuntimeName }, async (h) => {
          const support = h.launcher.supports(runtime);
          expect(support.ok).toBe(false);
          const reason = support.ok ? '' : support.reason;
          expect(reason.length).toBeGreaterThan(0);
          const err = await failure(
            h.launcher.start(
              requestFor(h, { runtime, account: { runtime, id: 'default', path: null } })
            )
          );
          expect(err.code).toBe('unsupported');
          expect(err.message).toContain(reason);
          expect(h.sessions()).toEqual([]);
          expect(h.calls()).toEqual([]);
        });
      });
    }
  });
}

/** The cases 1-12 for one (host, runtime) pair. */
function runtimeContract(
  name: string,
  make: (options: Omit<HarnessOptions, 'runtime'>) => Promise<LauncherHarness>
): void {
  describe(`launcher contract: ${name}`, () => {
    // Case 1: the session runs where and as whom it was asked to, and the
    // handle names it. A launcher that forgot the cwd or the account fails here.
    it('1. starts the session in the requested cwd on the requested account', async () => {
      await withHarness(make, {}, async (h) => {
        const req = requestFor(h);
        const handle = await h.launcher.start(req);
        expect(handle.host).toBe(h.launcher.host);
        expect(handle.runtime).toBe(h.runtime);
        if (!h.mintsSessionId) expect(handle.sessionId).toBe(req.sessionId);
        expect(handle.account).toBe(h.account.id);
        expect(handle.cwd).toBe(h.cwd);
        const record = startRecord(h, handle.sessionId);
        expect(record.cwd).toBe(h.cwd);
        if (h.accountBinding === 'config-dir') expect(record.configDir).toBe(h.account.path);
        else if (h.accountBinding === 'provider') expect(record.provider).toBe(h.account.provider);
        else expect(record.accountId).toBe(h.account.id);
      });
    });

    // Case 2: the ambient account runs on the supervisor's resolved home, or
    // omits the account where the host picks it. A Claude Code child on
    // `~/.claude` from a supervisor that set no CLAUDE_CONFIG_DIR gets the
    // variable UNSET: Claude Code reads the unsuffixed Keychain login only then.
    it('2. the ambient account runs on the supervisor’s resolved config dir', async () => {
      await withHarness(make, {}, async (h) => {
        const handle = await h.launcher.start(requestFor(h, { account: null }));
        expect(handle.account).toBeNull();
        const record = startRecord(h, handle.sessionId);
        if (h.accountBinding === 'config-dir') {
          expect(record.configDir).toBe(h.ambientConfigDir);
          const homeVar = HOME_VAR[h.runtime] as string;
          if (h.runtime === 'claude-code') expect(record.childEnv?.[homeVar]).toBeUndefined();
          else expect(record.childEnv?.[homeVar]).toBe(h.ambientConfigDir);
        } else if (h.accountBinding === 'account-id') {
          expect(record.accountId).toBeUndefined();
        }
      });
    });

    // Case 3: the first message is a one-line pointer, never the prompt text
    // (cmux turns each newline into Enter).
    it('3. the first message is one line pointing at the prompt file', async () => {
      await withHarness(make, {}, async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        const record = startRecord(h, handle.sessionId);
        expect(record.message).toBe(pointer(h.promptFile));
        expect(record.message).not.toMatch(/\n/);
      });
    });

    // Case 4: a session billing another account is refused, not adopted.
    it('4. a session on another account throws wrong-account', async () => {
      await withHarness(make, {}, async (h) => {
        h.script({ confirm: 'other-account' });
        const req = requestFor(h);
        const err = await failure(h.launcher.start(req));
        expect(err.code).toBe('wrong-account');
        if (h.stopBehavior !== 'pid') return;
        if (h.mintsSessionId) expect(h.stopped()).toHaveLength(1);
        else expect(h.stopped()).toContain(req.sessionId);
      });
    });

    // Case 5: a missing host is reported with its reason, and nothing is tried.
    it('5. a missing host: probe says why, start throws unavailable and starts nothing', async () => {
      await withHarness(make, { hostMissing: true }, async (h) => {
        const probe = await h.launcher.probe(h.runtime);
        expect(probe.ok).toBe(false);
        const reason = probe.ok ? '' : probe.reason;
        expect(reason.length).toBeGreaterThan(0);
        const err = await failure(h.launcher.start(requestFor(h)));
        expect(err.code).toBe('unavailable');
        expect(err.message).toContain(reason);
        expect(h.sessions()).toEqual([]);
      });
    });

    // Case 6: start does not return until the session is confirmed; a silent
    // one is not-started once the (fake) clock passes the timeout.
    it('6. a session that never confirms throws not-started', async () => {
      await withHarness(make, {}, async (h) => {
        h.script({ confirm: 'silent' });
        const err = await failure(h.launcher.start(requestFor(h)));
        expect(err.code).toBe('not-started');
      });
    });

    // Case 7: a later message is the same one-line pointer; an exited session
    // is resumed on the same account and cwd rather than started afresh.
    it('7. send delivers a pointer to a live session and resumes an exited one', async () => {
      await withHarness(make, {}, async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        const live = await h.launcher.send(handle, h.messageFile);
        expect(['delivered', 'queued']).toContain(live.result);
        const messages = h
          .sessions()
          .filter((r) => r.kind === 'message' && r.sessionId === handle.sessionId);
        expect(messages.at(-1)?.message).toBe(pointer(h.messageFile));

        if (!h.states.includes('exited')) return;
        await h.signal(live.handle, { kind: 'exited' });
        const resumed = await h.launcher.send(live.handle, h.messageFile);
        expect(resumed.result).toBe('delivered');
        const record = h
          .sessions()
          .filter((r) => r.kind === 'resume')
          .at(-1);
        expect(record, 'the host recorded no resume').toBeDefined();
        expect(record?.sessionId).toBe(handle.sessionId);
        expect(record?.cwd).toBe(h.cwd);
        expect(record?.message).toBe(pointer(h.messageFile));
        if (h.accountBinding === 'config-dir') expect(record?.configDir).toBe(h.account.path);
        if (handle.pid !== undefined) expect(resumed.handle.pid).not.toBe(handle.pid);
      });
    });

    // Case 8: every state the host can report maps to the matching SessionState.
    it('8. state maps the host’s busy, idle, exited and limited signals', async () => {
      await withHarness(make, {}, async (h) => {
        for (const kind of h.states) {
          const handle = await h.launcher.start(requestFor(h));
          const signal: HostSignal =
            kind === 'limited'
              ? { kind, window: 'five_hour', resetsAt: '2026-09-26T20:00:00.000Z' }
              : { kind };
          await h.signal(handle, signal);
          const state = await h.launcher.state(handle);
          expect(state.kind, `signal ${kind}`).toBe(kind);
          if (state.kind === 'limited') {
            expect(state.window).toBe('five_hour');
            expect(state.resetsAt).toBe('2026-09-26T20:00:00.000Z');
          }
        }
      });
    });

    // Case 9: stop only ever signals a pid still running claude; a reused pid
    // is left alone. A host with no stop leaves the session idle.
    it('9. stop stops only a pid flow started, and a host with no stop leaves it idle', async () => {
      await withHarness(make, {}, async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        if (h.stopBehavior === 'left-idle') {
          expect(await h.launcher.stop(handle)).toBe('left-idle');
          return;
        }
        expect(await h.launcher.stop(handle)).toBe('stopped');
        expect(h.stopped()).toContain(handle.sessionId);

        const other = await h.launcher.start(requestFor(h));
        await h.makeForeign(other);
        expect(await h.launcher.stop(other)).not.toBe('stopped');
        expect(h.stopped()).not.toContain(other.sessionId);
      });
    });

    // Case 10: nothing runs through a shell, and the one shell word flow builds
    // survives a real shell byte for byte.
    it('10. every call is an argv array with no shell, and shellQuote round-trips', async () => {
      await withHarness(make, {}, async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        await h.launcher.send(handle, h.messageFile);
        await h.launcher.state(handle);
        await h.launcher.stop(handle);
        for (const call of h.calls()) {
          expect(Array.isArray(call.args), `${call.program} args`).toBe(true);
          expect(call.shell, `${call.program} shell`).toBe(false);
        }
        const tricky = `/tmp/it's a $HOME "dir"/\`x\``;
        const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(tricky)}`], {
          encoding: 'utf8',
        });
        expect(echoed).toBe(tricky);
      });
    });

    // Case 11: a bad request starts nothing.
    it('11. bad-request for a relative cwd, a missing prompt file or a line break', async () => {
      await withHarness(make, {}, async (h) => {
        const bad: Partial<LaunchRequest>[] = [
          { cwd: 'relative/dir' },
          { promptFile: `${h.cwd}/no-such-prompt.md` },
          { title: 'ACME-12\nworker' },
          { identifier: 'ACME\u000012' },
          // An account of another runtime is never run on this one.
          {
            account: {
              ...h.account,
              runtime: RUNTIME_NAMES.find((r) => r !== h.runtime) as RuntimeName,
            },
          },
        ];
        for (const overrides of bad) {
          const err = await failure(h.launcher.start(requestFor(h, overrides)));
          expect(err.code, JSON.stringify(overrides)).toBe('bad-request');
        }
        expect(h.sessions()).toEqual([]);
      });
    });

    // Case 12: a credential in the supervisor's environment never reaches the
    // child, and a session that still reports a key is refused.
    it('12. credential variables never reach the child; an apiKeySource other than none is refused', async () => {
      const every = Object.values(CREDENTIAL_VARS).flat();
      const supervisorEnv = Object.fromEntries(every.map((v) => [v, `secret-${v}`]));
      await withHarness(make, { supervisorEnv }, async (h) => {
        if (!h.scrubsCredentials) return;
        const handle = await h.launcher.start(requestFor(h));
        const record = startRecord(h, handle.sessionId);
        expect(record.childEnv).toBeDefined();
        const own = CREDENTIAL_VARS[h.runtime];
        expect(own.length).toBeGreaterThan(0);
        for (const name of own) expect(record.childEnv?.[name]).toBeUndefined();

        if (!h.reportsApiKeySource) return;
        h.script({ confirm: 'confirmed', apiKeySource: 'ANTHROPIC_API_KEY' });
        const req = requestFor(h);
        const err = await failure(h.launcher.start(req));
        expect(err.code).toBe('wrong-account');
        expect(h.stopped()).toContain(req.sessionId);
      });
    });

    // Case 15: a recorded pid the OS gave to another process of the same
    // runtime (the operator's own claude, say) is never signalled, even when
    // its command line names our session: the start time recorded at spawn
    // (`pidStart`) is the identity, not the program name.
    it('15. a reused pid running the same runtime at another start time is left alone', async () => {
      await withHarness(make, {}, async (h) => {
        if (h.stopBehavior !== 'pid') return;
        const handle = await h.launcher.start(requestFor(h));
        expect(handle.pidStart, 'the start time recorded at spawn').toBeTruthy();
        await h.makeReused(handle, 'same');
        expect(await h.launcher.stop(handle)).not.toBe('stopped');
        expect(h.stopped()).not.toContain(handle.sessionId);
      });
    });

    // Case 16: a handle written before `pidStart` existed is stopped only when
    // the pid's command line names its session; a pid running the same
    // runtime for another session is left alone.
    it('16. a handle without pidStart is stopped only when the command names its session', async () => {
      await withHarness(make, {}, async (h) => {
        if (h.stopBehavior !== 'pid') return;
        const reused = await h.launcher.start(requestFor(h));
        await h.makeReused(reused, 'other');
        expect(await h.launcher.stop({ ...reused, pidStart: undefined })).not.toBe('stopped');
        expect(h.stopped()).not.toContain(reused.sessionId);

        // A codex or opencode start line carries no id (the runtime mints it),
        // so only a host whose start line names the session can prove this half.
        if (h.mintsSessionId) return;
        const ours = await h.launcher.start(requestFor(h));
        expect(await h.launcher.stop({ ...ours, pidStart: undefined })).toBe('stopped');
        expect(h.stopped()).toContain(ours.sessionId);
      });
    });

    // Case 17: the Keychain login follows CLAUDE_CONFIG_DIR, so a Claude Code
    // account on `~/.claude` gets the variable unset unless the supervisor
    // itself exported that same dir (then its suffixed login is the real one).
    it('17. a ~/.claude account unsets CLAUDE_CONFIG_DIR unless the supervisor named ~/.claude', async () => {
      if (!(await isClaudeConfigDirHost(make))) return;
      const home = (h: LauncherHarness): LaunchAccount => ({
        runtime: 'claude-code',
        id: 'main',
        path: h.ambientConfigDir,
      });
      const cases: Array<[string, (osHome: string) => Record<string, string>, 'unset' | 'set']> = [
        ['no variable', () => ({}), 'unset'],
        [
          'the supervisor exported ~/.claude',
          (osHome) => ({ CLAUDE_CONFIG_DIR: `${osHome}/.claude` }),
          'set',
        ],
        [
          'the supervisor runs on ~/.claude3',
          (osHome) => ({ CLAUDE_CONFIG_DIR: `${osHome}/.claude3` }),
          'unset',
        ],
      ];
      for (const [label, envFor, expected] of cases) {
        await withHarness(make, { supervisorEnvFor: envFor }, async (h) => {
          const handle = await h.launcher.start(requestFor(h, { account: home(h) }));
          const record = startRecord(h, handle.sessionId);
          expect(handle.configDir, label).toBe(h.ambientConfigDir);
          expect(record.configDir, label).toBe(h.ambientConfigDir);
          if (expected === 'unset')
            expect(record.childEnv?.CLAUDE_CONFIG_DIR, label).toBeUndefined();
          else expect(record.childEnv?.CLAUDE_CONFIG_DIR, label).toBe(h.ambientConfigDir);
        });
      }
    });
  });
}

/** Whether the harness's host binds a Claude Code account by CLAUDE_CONFIG_DIR. */
async function isClaudeConfigDirHost(
  make: (options: Omit<HarnessOptions, 'runtime'>) => Promise<LauncherHarness>
): Promise<boolean> {
  const h = await make({});
  const yes = h.runtime === 'claude-code' && h.accountBinding === 'config-dir';
  await h.cleanup();
  return yes;
}
