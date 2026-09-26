/**
 * The DorkOS launcher (spec `flow-handoff-dispatch` §2.5): each session is a
 * DorkOS session, started over DorkOS's own API.
 *
 * - **probe:** `GET /api/health` answers 2xx within 3 s.
 * - **start:** the `session_start` MCP tool when `/mcp` lists it and flow has a
 *   token (DorkOS mints the id and applies its guards, launch cap and permission
 *   clamp; a refusal is final, never retried another way); otherwise
 *   `POST /api/sessions/<id>/messages`. Either way, `GET /api/sessions/<id>`
 *   then proves the session exists, names its canonical id, runs on the
 *   requested runtime (else `wrong-runtime`), and shows the account it bills.
 * - **runtimes:** all three. `runtime` rides to `session_start` and the route
 *   body. DorkOS supports accounts for claude-code only today, so for codex and
 *   opencode an account is sent only when it is a registered, non-default one;
 *   the implicit default account is omitted and DorkOS runs its ambient login.
 *   A non-default codex or opencode account must still be reported back on the
 *   session (`account`), and fails closed as `wrong-account` until DorkOS does.
 * - **send:** `POST /api/sessions/<id>/messages` (DorkOS queues while a turn runs).
 * - **state:** the session's `status` (DorkOS with account-fleet support), else `unknown`.
 * - **stop:** nothing; the session stays in DorkOS for the person (`left-idle`).
 *
 * The `/mcp` endpoint is DorkOS's stateless Streamable HTTP transport: one
 * JSON-RPC request per POST, no `initialize` and no session header, an `Accept`
 * naming both `application/json` and `text/event-stream`, and the reply as
 * either a JSON body or a server-sent `message` event.
 *
 * The token (`DORKOS_MCP_TOKEN`, else `<dorkHome>/mcp-local-token`) rides only
 * on `/mcp` requests to the configured base URL. It is never printed, logged,
 * stored on the handle, or left in an error message, even one quoting the
 * server's own words.
 *
 * Every outside effect comes in through {@link DorkosLauncherDeps}, so the
 * contract suite runs it against an in-process fake server.
 *
 * Dependency-free (node builtins and local zero-dependency modules only).
 *
 * @module @dorkos/flow/launchers/dorkos
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveDorkHome } from '../fleet/accounts.ts';
import {
  DEFAULT_START_TIMEOUT_MS,
  isAmbientAccount,
  pointerLine,
  validateLaunchRequest,
  validateMessageFile,
} from './common.ts';
import { requireSupported, supportFor } from './support.ts';
import {
  DEFAULT_ACCOUNT_ID,
  LaunchError,
  type LaunchAccount,
  type LaunchRequest,
  type Launcher,
  type ProbeResult,
  type SendResult,
  type SessionHandle,
  type SessionState,
  type StopResult,
} from './types.ts';

/** What a 401 or 403 on the HTTP API means, and what to do about it. */
export const DORKOS_AUTH_MESSAGE =
  'DorkOS refused the request because sign-in is on. Set DORKOS_MCP_TOKEN to an API key.';

/** The file DorkOS writes its per-instance MCP token to, under `<dorkHome>`. */
export const MCP_TOKEN_FILE = 'mcp-local-token';

/** The `state` reason for a DorkOS whose sessions carry no `status`. */
const NO_STATUS_REASON = 'this DorkOS does not report session status';

/** How long the probe waits for `/api/health`. */
const PROBE_TIMEOUT_MS = 3_000;

/** How long any other single request may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/** DorkOS routes a session only by UUID. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lifecycle values that mean a turn is still running (`blocked`: waiting on the operator mid-turn). */
const BUSY_LIFECYCLES = new Set(['streaming', 'blocked', 'running']);

/** Everything the DorkOS launcher touches outside its own memory. */
export interface DorkosLauncherDeps {
  /** The HTTP client (the global `fetch`). */
  fetch: typeof fetch;
  /** The supervisor's environment (`DORKOS_URL`, `DORKOS_PORT`, `DORKOS_MCP_TOKEN`, `DORK_HOME`). */
  env: Readonly<Record<string, string | undefined>>;
  /** The OS home folder, for the default `<dorkHome>`. */
  osHome: string;
  /** The clock, in epoch milliseconds. */
  now: () => number;
  /** Waits. */
  sleep: (ms: number) => Promise<void>;
  /** How long `start` waits for the session to show up. Default 90 s. */
  startTimeoutMs?: number;
  /** How often `start` looks. Default 1 s. */
  pollMs?: number;
}

/**
 * The real dependencies: the global `fetch`, the process environment and clock.
 *
 * @returns Deps for {@link createDorkosLauncher}.
 */
export function realDorkosLauncherDeps(): DorkosLauncherDeps {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    osHome: os.homedir(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * DorkOS's base URL: `DORKOS_URL`, else `http://127.0.0.1:<DORKOS_PORT or 4242>`.
 *
 * @param env - The supervisor's environment.
 * @returns The base URL, without a trailing slash.
 */
export function dorkosBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.DORKOS_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = env.DORKOS_PORT?.trim() || '4242';
  return `http://127.0.0.1:${port}`;
}

/**
 * The one line of context DorkOS keeps with a session flow started. It carries
 * the id flow minted, so a person (or a restarted supervisor) can find a session
 * whose id DorkOS minted instead (spec §4.3 "Adopt before releasing").
 *
 * @param req - The launch request.
 * @returns The seed-context line.
 */
export function seedContextLine(
  req: Pick<LaunchRequest, 'role' | 'identifier' | 'sessionId'>
): string {
  return `flow started this session as the ${req.role} for ${req.identifier} (flow id ${req.sessionId}).`;
}

/** A parsed HTTP reply: its status and body (JSON when it parsed, else the text). */
interface Reply {
  status: number;
  body: unknown;
}

/** Whether a value is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The server's own words from an error body: `error`, `message`, a JSON-RPC error, or the text. */
function serverMessage(body: unknown): string {
  if (typeof body === 'string') return body.trim().slice(0, 300);
  if (isObject(body)) {
    if (typeof body.error === 'string') return body.error;
    if (isObject(body.error) && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.message === 'string') return body.message;
  }
  return 'no message';
}

/**
 * Pull the JSON-RPC message with `id` out of a Streamable HTTP reply: a JSON
 * body, or a server-sent event stream of `message` events.
 */
function rpcMessage(text: string, contentType: string, id: number): unknown {
  if (!contentType.includes('text/event-stream')) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      const message: unknown = JSON.parse(data);
      if (isObject(message) && message.id === id) return message;
    } catch {
      // Not a JSON event; keep looking.
    }
  }
  return undefined;
}

/** The text of an MCP tool result's content blocks. */
function contentText(result: Record<string, unknown>): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .map((block) => (isObject(block) && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join(' ')
    .trim();
}

/** The `sessionId` a successful `session_start` result carries, if any. */
function mintedSessionId(result: Record<string, unknown>): string | null {
  if (
    isObject(result.structuredContent) &&
    typeof result.structuredContent.sessionId === 'string'
  ) {
    return result.structuredContent.sessionId;
  }
  try {
    const parsed: unknown = JSON.parse(contentText(result));
    if (isObject(parsed) && typeof parsed.sessionId === 'string') return parsed.sessionId;
  } catch {
    // Not JSON.
  }
  return null;
}

/**
 * The account id DorkOS is sent, or `undefined` to omit it: claude-code sends
 * any account that is not the ambient one; codex and opencode send only a
 * registered, non-default account (DorkOS has accounts for claude-code only).
 */
function sentAccount(req: LaunchRequest): string | undefined {
  const account = req.account;
  if (account === null) return undefined;
  if (req.runtime === 'claude-code') return isAmbientAccount(account) ? undefined : account.id;
  return account.id === DEFAULT_ACCOUNT_ID ? undefined : account.id;
}

/**
 * What DorkOS must report as the session's `account` for a sent account: its
 * path (made absolute), else for a path-less opencode account its provider,
 * else its id.
 */
function expectedAccount(account: LaunchAccount): string {
  if (account.path !== null) return path.resolve(account.path);
  return account.provider ?? account.id;
}

/** Whether a reported `account` is the expected one (paths compared resolved). */
function sameAccount(reported: string, expected: string): boolean {
  return path.isAbsolute(reported) ? path.resolve(reported) === expected : reported === expected;
}

/** How the MCP path went: started, or not usable so the route is taken (a final no throws). */
type McpOutcome = { kind: 'started'; sessionId: string } | { kind: 'use-route' };

/**
 * Create the DorkOS launcher.
 *
 * @param deps - HTTP, clock and environment access (see {@link realDorkosLauncherDeps}).
 * @returns The launcher.
 */
export function createDorkosLauncher(deps: DorkosLauncherDeps): Launcher {
  const base = dorkosBaseUrl(deps.env);
  const timeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? 1_000;
  let rpcId = 0;

  /**
   * The MCP token, read fresh each start: `DORKOS_MCP_TOKEN`, else DorkOS's
   * token file. `null` when neither is there.
   */
  function readToken(): string | null {
    const fromEnv = deps.env.DORKOS_MCP_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const dorkHome = resolveDorkHome({ ...deps.env }, deps.osHome);
    try {
      const fromFile = readFileSync(path.join(dorkHome, MCP_TOKEN_FILE), 'utf8').trim();
      return fromFile === '' ? null : fromFile;
    } catch {
      return null;
    }
  }

  /** Remove every occurrence of the token from text bound for a person. */
  function redact(text: string, token: string | null): string {
    return token === null || token === '' ? text : text.split(token).join('[token]');
  }

  /** One HTTP request to DorkOS. Throws `unavailable` when DorkOS does not answer at all. */
  async function request(
    method: 'GET' | 'POST',
    route: string,
    init: { body?: unknown; headers?: Record<string, string>; timeout?: number } = {}
  ): Promise<Reply & { text: string; contentType: string }> {
    let response: Response;
    try {
      response = await deps.fetch(`${base}${route}`, {
        method,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(init.timeout ?? REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new LaunchError('unavailable', `DorkOS is not answering at ${base}.`);
    }
    const text = await response.text().catch(() => '');
    const contentType = response.headers.get('content-type') ?? '';
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON; keep the text.
    }
    return { status: response.status, body, text, contentType };
  }

  /** Throw the error the spec gives a failed HTTP API reply. */
  function apiFailure(reply: Reply, what: string): never {
    if (reply.status === 401 || reply.status === 403) {
      throw new LaunchError('auth', DORKOS_AUTH_MESSAGE);
    }
    throw new LaunchError(
      'unavailable',
      `DorkOS answered ${reply.status} to ${what}: ${serverMessage(reply.body)}`
    );
  }

  /** One JSON-RPC call on `/mcp` with the token. */
  async function rpc(
    token: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<{ status: number; message: unknown; body: unknown }> {
    rpcId += 1;
    const id = rpcId;
    const reply = await request('POST', '/mcp', {
      body: { jsonrpc: '2.0', id, method, params },
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
    });
    const message =
      reply.status >= 200 && reply.status < 300
        ? rpcMessage(reply.text, reply.contentType, id)
        : undefined;
    return { status: reply.status, message, body: reply.body };
  }

  /**
   * Start through `session_start` when DorkOS offers it. Anything short of the
   * tool being listed and callable (no token, a 401, no `/mcp`, no such tool)
   * means the route; a call the tool answers with an error is final.
   */
  async function startOverMcp(req: LaunchRequest, token: string | null): Promise<McpOutcome> {
    if (token === null) return { kind: 'use-route' };
    const listed = await rpc(token, 'tools/list', {});
    if (!isObject(listed.message) || !isObject(listed.message.result)) return { kind: 'use-route' };
    const tools = Array.isArray(listed.message.result.tools) ? listed.message.result.tools : [];
    if (!tools.some((tool) => isObject(tool) && tool.name === 'session_start')) {
      return { kind: 'use-route' };
    }

    const args: Record<string, unknown> = {
      prompt: pointerLine(req.promptFile),
      cwd: req.cwd,
      ...(sentAccount(req) === undefined ? {} : { account: sentAccount(req) }),
      runtime: req.runtime,
      ...(req.model === undefined ? {} : { model: req.model }),
      permissionMode: req.permissionMode,
      seedContext: seedContextLine(req),
    };
    const called = await rpc(token, 'tools/call', { name: 'session_start', arguments: args });
    // A 401 here is a credential flow holds that DorkOS no longer takes, not a
    // guard's no: nothing started, so the route may still try.
    if (called.status === 401) return { kind: 'use-route' };
    if (called.status < 200 || called.status >= 300) {
      throw new LaunchError(
        'unavailable',
        redact(
          `DorkOS answered ${called.status} to session_start: ${serverMessage(called.body)}`,
          token
        )
      );
    }
    const message = called.message;
    if (!isObject(message)) {
      throw new LaunchError('refused', 'DorkOS gave session_start no readable answer.');
    }
    if (isObject(message.error)) {
      throw new LaunchError(
        'refused',
        redact(`DorkOS refused to start the session: ${serverMessage(message)}`, token)
      );
    }
    const result = isObject(message.result) ? message.result : {};
    if (result.isError === true) {
      const words = contentText(result) || 'no reason given';
      throw new LaunchError(
        'refused',
        redact(`DorkOS refused to start the session: ${words}`, token)
      );
    }
    const sessionId = mintedSessionId(result);
    if (sessionId === null) {
      throw new LaunchError('not-started', 'session_start answered without a session id.');
    }
    return { kind: 'started', sessionId };
  }

  /** Start through the messages route with the id flow minted. */
  async function startOverRoute(req: LaunchRequest): Promise<string> {
    const reply = await request(
      'POST',
      `/api/sessions/${encodeURIComponent(req.sessionId)}/messages`,
      {
        body: {
          content: pointerLine(req.promptFile),
          cwd: req.cwd,
          runtime: req.runtime,
          ...(sentAccount(req) === undefined ? {} : { account: sentAccount(req) }),
          seedContext: seedContextLine(req),
        },
      }
    );
    if (reply.status < 200 || reply.status >= 300) apiFailure(reply, 'the first message');
    return req.sessionId;
  }

  /** `GET /api/sessions/<id>`: the session, or `null` while DorkOS does not know it yet. */
  async function getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const reply = await request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
    if (reply.status === 404) return null;
    if (reply.status < 200 || reply.status >= 300) apiFailure(reply, 'the session lookup');
    return isObject(reply.body) ? reply.body : null;
  }

  async function probe(): Promise<ProbeResult> {
    const reason = `DorkOS is not answering at ${base}`;
    try {
      const response = await deps.fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok ? { ok: true } : { ok: false, reason };
    } catch {
      return { ok: false, reason };
    }
  }

  async function start(req: LaunchRequest): Promise<SessionHandle> {
    requireSupported('dorkos', req.runtime);
    validateLaunchRequest(req);
    if (!UUID_PATTERN.test(req.sessionId)) {
      throw new LaunchError(
        'bad-request',
        `DorkOS needs a UUID session id, not "${req.sessionId}".`
      );
    }
    const probed = await probe();
    if (!probed.ok) throw new LaunchError('unavailable', probed.reason);

    const token = readToken();
    const viaMcp = await startOverMcp(req, token);
    const launchPath = viaMcp.kind === 'started' ? 'mcp' : 'route';
    const startedId = viaMcp.kind === 'started' ? viaMcp.sessionId : await startOverRoute(req);

    // Prove it: the session exists, its canonical id, its runtime, and the
    // account it bills. DorkOS derives `account` from where the transcript
    // lives, so it can lag the session itself; keep looking until the deadline.
    const sent = sentAccount(req);
    const expected =
      sent === undefined || req.account === null ? null : expectedAccount(req.account);
    const deadline = deps.now() + timeoutMs;
    let seen: Record<string, unknown> | null = null;
    for (;;) {
      const session = await getSession(startedId);
      if (session !== null) {
        seen = session;
        // A DorkOS old enough to omit `runtime` runs Claude Code only.
        const runtime = typeof session.runtime === 'string' ? session.runtime : 'claude-code';
        if (runtime !== req.runtime) {
          throw new LaunchError(
            'wrong-runtime',
            `DorkOS started session ${startedId} on ${runtime} instead of ${req.runtime}; flow left it idle in DorkOS.`
          );
        }
        const reported = typeof session.account === 'string' ? session.account : null;
        if (expected === null || reported !== null) {
          if (expected !== null && !sameAccount(reported ?? '', expected)) {
            throw new LaunchError(
              'wrong-account',
              `DorkOS started the session on ${reported} instead of ${expected}; flow left it idle in DorkOS.`
            );
          }
          return {
            host: 'dorkos',
            runtime: req.runtime,
            sessionId: typeof session.id === 'string' && session.id !== '' ? session.id : startedId,
            account: req.account?.id ?? null,
            cwd: req.cwd,
            launchPath,
          };
        }
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(pollMs);
    }
    if (seen !== null) {
      throw new LaunchError(
        'wrong-account',
        `DorkOS never said which account session ${startedId} bills, so flow cannot confirm it runs on ${expected}; flow left it idle in DorkOS.`
      );
    }
    throw new LaunchError(
      'not-started',
      `DorkOS did not show session ${startedId} within ${Math.round(timeoutMs / 1000)} s.`
    );
  }

  async function send(h: SessionHandle, messageFile: string): Promise<SendResult> {
    validateMessageFile(messageFile);
    const reply = await request(
      'POST',
      `/api/sessions/${encodeURIComponent(h.sessionId)}/messages`,
      {
        body: { content: pointerLine(messageFile) },
      }
    );
    if (reply.status < 200 || reply.status >= 300) apiFailure(reply, 'the message');
    return { result: 'delivered', handle: h };
  }

  async function state(h: SessionHandle): Promise<SessionState> {
    let session: Record<string, unknown> | null;
    try {
      session = await getSession(h.sessionId);
    } catch (error) {
      return { kind: 'unknown', reason: (error as Error).message };
    }
    if (session === null) return { kind: 'unknown', reason: 'DorkOS no longer knows this session' };
    const status = session.status;
    if (!isObject(status)) return { kind: 'unknown', reason: NO_STATUS_REASON };
    if (isObject(status.limit)) {
      return {
        kind: 'limited',
        window: typeof status.limit.window === 'string' ? status.limit.window : null,
        resetsAt: typeof status.limit.resetsAt === 'string' ? status.limit.resetsAt : null,
      };
    }
    if (typeof status.lifecycle === 'string' && BUSY_LIFECYCLES.has(status.lifecycle)) {
      return { kind: 'busy' };
    }
    return { kind: 'idle' };
  }

  async function stop(): Promise<StopResult> {
    return 'left-idle';
  }

  return {
    host: 'dorkos',
    supports: (runtime) => supportFor('dorkos', runtime),
    probe,
    start,
    send,
    state,
    stop,
  };
}
