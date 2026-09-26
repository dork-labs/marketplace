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
 * `scrubsCredentials`, `reportsApiKeySource`) rather than branched on by name.
 *
 * Not a test file itself (no `.test.ts`), so vitest runs it only through the
 * launcher test files that import it.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { shellQuote } from '../../scripts/launchers/shell-quote.ts';
import {
  LaunchError,
  type LaunchAccount,
  type LaunchErrorCode,
  type LaunchRequest,
  type Launcher,
  type SessionHandle,
} from '../../scripts/launchers/types.ts';

/** The credential variables no child may inherit (spec §2.1 "No other credential rides along"). */
export const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** How a harness is built for one case. */
export interface HarnessOptions {
  /** Variables added to the supervisor's environment the launcher is given. */
  supervisorEnv?: Record<string, string>;
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
  /** `config-dir` hosts: the `CLAUDE_CONFIG_DIR` the child got. */
  configDir?: string;
  /** `account-id` hosts: the `account` the request carried; `undefined` when omitted. */
  accountId?: string;
  /** The message text the session received (or has queued), exactly. */
  message: string | null;
  /** `config-dir` hosts: the environment the `claude` child sees. */
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
  /** How the host names the account: a config dir in the child env, or an account id in a request. */
  accountBinding: 'config-dir' | 'account-id';
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
  /** What the supervisor's ambient account resolves to (its `CLAUDE_CONFIG_DIR`, else `~/.claude`). */
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
async function withHarness(
  make: MakeHarness,
  options: HarnessOptions,
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
 * The shared launcher contract (spec §2.7, cases 1-12). Call once per launcher.
 *
 * @param name - The launcher's name, for the describe block.
 * @param make - Builds a harness per case.
 */
export function launcherContract(name: string, make: MakeHarness): void {
  describe(`launcher contract: ${name}`, () => {
    // Case 1: the session runs where and as whom it was asked to, and the
    // handle names it. A launcher that forgot the cwd or the account fails here.
    it('1. starts the session in the requested cwd on the requested account', async () => {
      await withHarness(make, {}, async (h) => {
        const req = requestFor(h);
        const handle = await h.launcher.start(req);
        expect(handle.host).toBe(h.launcher.host);
        expect(handle.sessionId).toBe(req.sessionId);
        expect(handle.account).toBe(h.account.id);
        expect(handle.cwd).toBe(h.cwd);
        const record = startRecord(h, handle.sessionId);
        expect(record.cwd).toBe(h.cwd);
        if (h.accountBinding === 'config-dir') expect(record.configDir).toBe(h.account.path);
        else expect(record.accountId).toBe(h.account.id);
      });
    });

    // Case 2: the ambient account is named explicitly (cmux shells do not
    // inherit the supervisor's env), or omitted where the host picks it.
    it('2. the ambient account runs on the supervisor’s resolved config dir', async () => {
      await withHarness(make, {}, async (h) => {
        const handle = await h.launcher.start(requestFor(h, { account: null }));
        expect(handle.account).toBeNull();
        const record = startRecord(h, handle.sessionId);
        if (h.accountBinding === 'config-dir') {
          expect(record.configDir).toBe(h.ambientConfigDir);
          expect(record.childEnv?.CLAUDE_CONFIG_DIR).toBe(h.ambientConfigDir);
        } else {
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
        if (h.stopBehavior === 'pid') expect(h.stopped()).toContain(req.sessionId);
      });
    });

    // Case 5: a missing host is reported with its reason, and nothing is tried.
    it('5. a missing host: probe says why, start throws unavailable and starts nothing', async () => {
      await withHarness(make, { hostMissing: true }, async (h) => {
        const probe = await h.launcher.probe();
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
      const supervisorEnv = Object.fromEntries(CREDENTIAL_VARS.map((v) => [v, `secret-${v}`]));
      await withHarness(make, { supervisorEnv }, async (h) => {
        if (!h.scrubsCredentials) return;
        const handle = await h.launcher.start(requestFor(h));
        const record = startRecord(h, handle.sessionId);
        expect(record.childEnv).toBeDefined();
        for (const name of CREDENTIAL_VARS) expect(record.childEnv?.[name]).toBeUndefined();

        if (!h.reportsApiKeySource) return;
        h.script({ confirm: 'confirmed', apiKeySource: 'ANTHROPIC_API_KEY' });
        const req = requestFor(h);
        const err = await failure(h.launcher.start(req));
        expect(err.code).toBe('wrong-account');
        expect(h.stopped()).toContain(req.sessionId);
      });
    });
  });
}
