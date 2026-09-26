/**
 * The DorkOS launcher (spec `flow-handoff-dispatch` §2.5, task 2.3): the shared
 * contract suite (§2.7) against an in-process `node:http` fake of DorkOS, once
 * over the messages route and once over the `session_start` MCP tool, plus the
 * DorkOS-only cases the contract does not cover.
 *
 * The fake implements `GET /api/health`, `POST /api/sessions/:id/messages`
 * (recording bodies), `GET /api/sessions/:id` (a scripted `account` and optional
 * `status`) and `POST /mcp` (stateless JSON-RPC answered as a server-sent event,
 * as the MCP SDK's Streamable HTTP transport does, with or without
 * `session_start`, and a 401 for a mutating call without the token).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DORKOS_AUTH_MESSAGE,
  createDorkosLauncher,
  type DorkosLauncherDeps,
} from '../../scripts/launchers/dorkos.ts';
import {
  LaunchError,
  type LaunchAccount,
  type RuntimeName,
  type SessionHandle,
} from '../../scripts/launchers/types.ts';
import {
  launcherContract,
  requestFor,
  type HarnessOptions,
  type HostSessionRecord,
  type HostSignal,
  type LauncherHarness,
  type SessionScript,
} from './contract.ts';

/** The token the fake accepts. Distinctive, so a leak is easy to search for. */
const TOKEN = 'dork_mcp_local_SECRET-7f3a9c';

/** How the fake's `/mcp` behaves. */
type McpMode =
  | 'with-tool' // lists session_start and runs it
  | 'without-tool' // lists other tools only
  | 'refuse' // lists session_start; every call is an isError refusal
  | 'absent'; // /mcp answers 404 (a DorkOS with no external MCP server)

/** How the fake mints a `session_start` session id. */
type MintMode = 'echo-flow-id' | 'fresh';

/** The fake's knobs, fixed when the harness is built. */
interface FakeOptions extends Omit<HarnessOptions, 'runtime'> {
  /** The runtime the harness's sessions run on. Default `claude-code`. */
  runtime?: RuntimeName;
  /**
   * The DORKOS_URL the launcher is given instead of the fake's loopback one
   * (e.g. a remote host); the fake's fetch routes it to the fake server anyway.
   */
  urlAs?: string;
  /** Report this runtime on every session instead of the one requested. */
  reportRuntime?: string;
  mcp?: McpMode;
  mint?: MintMode;
  /** Whether the token file exists under `<dorkHome>`. Default true. */
  tokenFile?: boolean;
  /** Route sessions are rebound to this id, as DorkOS may do. */
  rebindTo?: string;
  /** Report `status` on `GET /api/sessions/:id` (S4 D7). Default true. */
  reportsStatus?: boolean;
  /** Answer every `/api/*` call but health with this status. */
  apiStatus?: number;
  /** A body `/api/*` answers with, echoing the request's Authorization header. */
  echoAuth?: boolean;
  /** Refuse `PATCH /api/sessions/:id` model changes with 400. */
  refuseModel?: boolean;
}

/** One HTTP request the fake saw. */
interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  accept: string | undefined;
  body: unknown;
}

/** One session the fake holds. */
interface FakeSession {
  id: string;
  account: string | undefined;
  runtime: string;
  cwd: string | null;
  lifecycle: string;
  limit: { window: string; resetsAt: string | null } | null;
  visible: boolean;
}

/** The DorkOS harness plus the handles DorkOS-only cases need. */
interface DorkosHarness extends LauncherHarness {
  requests(): readonly SeenRequest[];
  toolCalls(): readonly { name: string; args: Record<string, unknown> }[];
  baseUrl: string;
  stdout: string[];
  stderr: string[];
}

/** Read a request body as JSON (`undefined` when empty or not JSON). */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The flow id in a seedContext line, as the fake's echo-minter reads it. */
function flowIdIn(seed: unknown): string | null {
  if (typeof seed !== 'string') return null;
  return /\(flow id ([^)]+)\)\.$/.exec(seed)?.[1] ?? null;
}

let freshCounter = 0;

/**
 * Build the DorkOS harness: temp folders (a worktree, `<dorkHome>` with the
 * token file, a registered account's config dir, the ambient `~/.claude` and a
 * stranger's dir), a fake clock, and the fake DorkOS server.
 */
async function makeDorkosHarness(options: FakeOptions = {}): Promise<DorkosHarness> {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-dorkos-launcher-')));
  const cwd = path.join(root, 'work tree');
  const osHome = path.join(root, 'home');
  const dorkHome = path.join(root, 'dork home');
  const runtime = options.runtime ?? 'claude-code';
  const account: LaunchAccount =
    runtime === 'opencode'
      ? { runtime, id: 'openrouter', path: null, provider: 'openrouter' }
      : {
          runtime,
          id: runtime === 'codex' ? 'codex2' : 'claude3',
          path: path.join(root, 'accounts', runtime === 'codex' ? 'codex2' : 'claude3'),
        };
  const otherDir = path.join(root, 'accounts', 'someone-else');
  const ambientConfigDir = path.join(osHome, '.claude');
  for (const dir of [cwd, osHome, dorkHome, otherDir, ambientConfigDir]) {
    mkdirSync(dir, { recursive: true });
  }
  if (account.path !== null) mkdirSync(account.path, { recursive: true });
  /** What the fake reports as a matching session's `account`, as the launcher expects it. */
  const reportedAccount = account.path ?? account.provider ?? account.id;
  const promptFile = path.join(cwd, 'prompt.md');
  const messageFile = path.join(cwd, 'message.md');
  writeFileSync(promptFile, 'Do the work.\n');
  writeFileSync(messageFile, 'Address the review.\n');
  if (options.tokenFile !== false) writeFileSync(path.join(dorkHome, 'mcp-local-token'), TOKEN);

  const mcp = options.mcp ?? 'without-tool';
  const reportsStatus = options.reportsStatus ?? true;
  const seen: SeenRequest[] = [];
  const records: HostSessionRecord[] = [];
  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  const sessions = new Map<string, FakeSession>();
  const aliases = new Map<string, string>();
  let nextScript: SessionScript = { confirm: 'confirmed' };

  /** The account a newly started session reports, per the script. */
  function accountFor(accountId: unknown): string | undefined {
    if (nextScript.confirm === 'other-account') return otherDir;
    return accountId === account.id ? reportedAccount : ambientConfigDir;
  }

  /** Open a session the way DorkOS would, and record the start. */
  function openSession(id: string, body: Record<string, unknown>, message: unknown): void {
    sessions.set(id, {
      id,
      account: accountFor(body.account),
      runtime:
        options.reportRuntime ?? (typeof body.runtime === 'string' ? body.runtime : 'claude-code'),
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
      lifecycle: 'streaming',
      limit: null,
      visible: nextScript.confirm !== 'silent',
    });
    records.push({
      kind: 'start',
      sessionId: id,
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
      ...(typeof body.account === 'string' ? { accountId: body.account } : {}),
      message: typeof message === 'string' ? message : null,
    });
  }

  /** Answer one JSON-RPC message as the stateless Streamable HTTP transport does. */
  function rpcReply(id: unknown, payload: Record<string, unknown>): string {
    return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n\n`;
  }

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '/';
    seen.push({
      method: req.method ?? '',
      url,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body,
    });
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url === '/api/health' && req.method === 'GET') return json(200, { status: 'ok' });

    if (url === '/mcp' && req.method === 'POST') {
      if (mcp === 'absent') return json(404, { error: 'Not found' });
      const accept = req.headers.accept ?? '';
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        return json(406, { jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable' } });
      }
      const rpc = (body ?? {}) as { id?: unknown; method?: string; params?: unknown };
      const authed = req.headers.authorization === `Bearer ${TOKEN}`;
      // The login-off carve-out: discovery passes tokenless, a mutating call does not.
      if (rpc.method !== 'tools/list' && !authed) {
        return json(401, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <token>' },
          id: null,
        });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (rpc.method === 'tools/list') {
        const tools = [{ name: 'get_server_info' }, { name: 'relay_send' }];
        if (mcp !== 'without-tool') tools.push({ name: 'session_start' });
        return res.end(rpcReply(rpc.id, { result: { tools } }));
      }
      if (rpc.method === 'tools/call') {
        const params = (rpc.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const args = params.arguments ?? {};
        toolCalls.push({ name: params.name ?? '', args });
        if (mcp === 'refuse') {
          const echo = options.echoAuth ? ` (you sent ${req.headers.authorization})` : '';
          return res.end(
            rpcReply(rpc.id, {
              result: {
                content: [
                  { type: 'text', text: `The account claude3 is kept for another repo.${echo}` },
                ],
                isError: true,
              },
            })
          );
        }
        freshCounter += 1;
        const minted =
          options.mint === 'fresh'
            ? `11111111-1111-4111-8111-${String(freshCounter).padStart(12, '0')}`
            : (flowIdIn(args.seedContext) ?? 'no-flow-id');
        openSession(minted, args, args.prompt);
        const result = {
          sessionId: minted,
          runtime: args.runtime,
          account: null,
          status: 'started',
        };
        return res.end(
          rpcReply(rpc.id, {
            result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
          })
        );
      }
      return res.end(rpcReply(rpc.id, { error: { code: -32601, message: 'Method not found' } }));
    }

    if (options.apiStatus !== undefined && url.startsWith('/api/')) {
      const echo = options.echoAuth ? ` (you sent ${req.headers.authorization ?? 'nothing'})` : '';
      return json(options.apiStatus, { error: `Something broke${echo}`, code: 'BROKE' });
    }

    const messages = /^\/api\/sessions\/([^/?]+)\/messages$/.exec(url);
    if (messages && req.method === 'POST') {
      const id = decodeURIComponent(messages[1] ?? '');
      const payload = (body ?? {}) as Record<string, unknown>;
      const canonical = aliases.get(id) ?? id;
      if (!sessions.has(canonical)) {
        const target = options.rebindTo ?? id;
        if (target !== id) aliases.set(id, target);
        openSession(target, payload, payload.content);
        // The start record names the id flow asked for; the fake's own id is the rebind.
        const last = records.at(-1);
        if (last) last.sessionId = id;
      } else {
        const session = sessions.get(canonical);
        records.push({
          kind: 'message',
          sessionId: id,
          cwd: session?.cwd ?? null,
          message: typeof payload.content === 'string' ? payload.content : null,
        });
      }
      return json(202, { sessionId: aliases.get(id) ?? id, messageId: 'm1' });
    }

    const patch = /^\/api\/sessions\/([^/?]+)$/.exec(url);
    if (patch && req.method === 'PATCH') {
      if (options.refuseModel) {
        return json(400, { error: 'That model is not available here', code: 'MODEL_UNAVAILABLE' });
      }
      return json(200, { ok: true });
    }

    const get = /^\/api\/sessions\/([^/?]+)$/.exec(url);
    if (get && req.method === 'GET') {
      const id = decodeURIComponent(get[1] ?? '');
      const session = sessions.get(aliases.get(id) ?? id);
      if (!session?.visible)
        return json(404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return json(200, {
        id: session.id,
        title: 'Session',
        createdAt: '2026-09-26T18:00:00.000Z',
        updatedAt: '2026-09-26T18:00:00.000Z',
        runtime: session.runtime,
        ...(session.account === undefined ? {} : { account: session.account }),
        ...(reportsStatus
          ? {
              status: {
                lifecycle: session.lifecycle,
                limit:
                  session.limit === null
                    ? null
                    : { accountId: 'claude3', since: '2026-09-26T18:00:00.000Z', ...session.limit },
              },
            }
          : {}),
      });
    }

    return json(404, { error: 'Not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = options.hostMissing ? 'http://127.0.0.1:1' : `http://127.0.0.1:${port}`;

  let clock = Date.parse('2026-09-26T18:00:00.000Z');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: DorkosLauncherDeps = {
    fetch:
      options.urlAs === undefined
        ? globalThis.fetch
        : (input, init) =>
            globalThis.fetch(String(input).replace(options.urlAs as string, baseUrl), init),
    env: {
      DORKOS_URL: options.urlAs ?? baseUrl,
      DORK_HOME: dorkHome,
      ...options.supervisorEnv,
    },
    osHome,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    startTimeoutMs: 5_000,
    pollMs: 1_000,
  };
  const launcher = createDorkosLauncher(deps);

  const byHandle = (handle: SessionHandle): FakeSession => {
    const session = sessions.get(aliases.get(handle.sessionId) ?? handle.sessionId);
    if (session === undefined) throw new Error(`the fake has no session ${handle.sessionId}`);
    return session;
  };

  return {
    launcher,
    runtime,
    mintsSessionId: false,
    accountBinding: 'account-id',
    states: ['busy', 'idle', 'limited'],
    stopBehavior: 'left-idle',
    scrubsCredentials: false,
    reportsApiKeySource: false,
    account,
    ambientConfigDir,
    cwd,
    promptFile,
    messageFile,
    baseUrl,
    stdout,
    stderr,
    script(script) {
      nextScript = script;
    },
    async signal(handle: SessionHandle, signal: HostSignal) {
      const session = byHandle(handle);
      session.limit = null;
      if (signal.kind === 'busy') session.lifecycle = 'streaming';
      else if (signal.kind === 'idle') session.lifecycle = 'idle';
      else if (signal.kind === 'limited') {
        session.lifecycle = 'error';
        session.limit = { window: signal.window, resetsAt: signal.resetsAt };
      }
    },
    async makeForeign() {
      // DorkOS sessions have no pid.
    },
    async makeReused() {
      // DorkOS sessions have no pid.
    },
    sessions: () => records,
    calls: () => [],
    stopped: () => [],
    requests: () => seen,
    toolCalls: () => toolCalls,
    async cleanup() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const DORKOS_RUNTIMES: readonly RuntimeName[] = ['claude-code', 'codex', 'opencode'];
launcherContract(
  'dorkos (messages route)',
  (options) => makeDorkosHarness(options),
  DORKOS_RUNTIMES
);
launcherContract(
  'dorkos (session_start over MCP)',
  (options) => makeDorkosHarness({ ...options, mcp: 'with-tool' }),
  DORKOS_RUNTIMES
);

/** Await a call that must fail with a LaunchError. */
async function launchFailure(promise: Promise<unknown>): Promise<LaunchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LaunchError);
    return error as LaunchError;
  }
  throw new Error('expected a LaunchError');
}

/** Run a body with a harness, always cleaning up. */
async function withFake(
  options: FakeOptions,
  body: (h: DorkosHarness) => Promise<void>
): Promise<void> {
  const h = await makeDorkosHarness(options);
  try {
    await body(h);
  } finally {
    await h.cleanup();
  }
}

describe('dorkos launcher: which path it takes', () => {
  // The MCP tool is preferred when DorkOS lists it: the session starts through
  // session_start with every field the spec names, the route is never touched,
  // and the handle takes the id the tool minted and says which path it used.
  it('uses session_start when it is listed, and takes the id the tool minted', async () => {
    await withFake({ mcp: 'with-tool', mint: 'fresh' }, async (h) => {
      const req = requestFor(h, { model: 'claude-opus-4-1' });
      const handle = await h.launcher.start(req);
      expect(h.toolCalls()).toHaveLength(1);
      const call = h.toolCalls()[0];
      expect(call?.name).toBe('session_start');
      expect(call?.args).toEqual({
        prompt: `Read ${h.promptFile} and do exactly what it says.`,
        cwd: h.cwd,
        account: 'claude3',
        runtime: 'claude-code',
        model: 'claude-opus-4-1',
        permissionMode: 'acceptEdits',
        seedContext: `flow started this session as the worker for ACME-12 (flow id ${req.sessionId}).`,
      });
      expect(h.requests().some((r) => r.url.endsWith('/messages'))).toBe(false);
      expect(handle.sessionId).not.toBe(req.sessionId);
      expect(handle.sessionId).toMatch(/^11111111-/);
      expect(handle.launchPath).toBe('mcp');
      // The MCP request carries the token and accepts both JSON and SSE.
      const mcpRequest = h.requests().find((r) => r.url === '/mcp');
      expect(mcpRequest?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(mcpRequest?.accept).toContain('application/json');
      expect(mcpRequest?.accept).toContain('text/event-stream');
    });
  });

  // A tool refusal is DorkOS policy: it becomes `refused` with the tool's own
  // words, and flow never retries the launch through the HTTP route.
  it('a session_start refusal is refused with DorkOS’s words and never retried via the route', async () => {
    await withFake({ mcp: 'refuse' }, async (h) => {
      const err = await launchFailure(h.launcher.start(requestFor(h)));
      expect(err.code).toBe('refused');
      expect(err.message).toContain('The account claude3 is kept for another repo.');
      expect(h.requests().some((r) => r.url.includes('/api/sessions/'))).toBe(false);
      expect(h.sessions()).toEqual([]);
    });
  });

  // Without session_start (an older DorkOS), without /mcp, or without a token,
  // the launch goes through the messages route with the full body.
  for (const [label, options] of [
    ['the tool is not listed', { mcp: 'without-tool' }],
    ['/mcp is not there', { mcp: 'absent' }],
    ['there is no token', { mcp: 'with-tool', tokenFile: false }],
  ] as const) {
    it(`uses the messages route when ${label}`, async () => {
      await withFake(options, async (h) => {
        const req = requestFor(h);
        const handle = await h.launcher.start(req);
        expect(h.toolCalls()).toEqual([]);
        const post = h.requests().find((r) => r.url === `/api/sessions/${req.sessionId}/messages`);
        expect(post?.body).toEqual({
          content: `Read ${h.promptFile} and do exactly what it says.`,
          cwd: h.cwd,
          runtime: 'claude-code',
          account: 'claude3',
          seedContext: `flow started this session as the worker for ACME-12 (flow id ${req.sessionId}).`,
        });
        expect(post?.authorization).toBeUndefined();
        expect(handle.launchPath).toBe('route');
      });
    });
  }

  // A stale token: the mutating call answers 401, which is not a guard's no,
  // so the launch goes through the route instead.
  it('a 401 on the tool call falls back to the route', async () => {
    await withFake(
      { mcp: 'with-tool', supervisorEnv: { DORKOS_MCP_TOKEN: 'stale-token' } },
      async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        expect(handle.launchPath).toBe('route');
        expect(h.requests().find((r) => r.url === '/mcp')?.authorization).toBe(
          'Bearer stale-token'
        );
      }
    );
  });
});

describe('dorkos launcher: the session it records', () => {
  // DorkOS may rebind a route-started session; the handle takes the id
  // GET /api/sessions/<id> returns, never the one flow minted.
  it('records the canonical id when DorkOS rebinds the session', async () => {
    const canonical = '22222222-2222-4222-8222-222222222222';
    await withFake({ rebindTo: canonical }, async (h) => {
      const req = requestFor(h);
      const handle = await h.launcher.start(req);
      expect(handle.sessionId).toBe(canonical);
      expect(handle.launchPath).toBe('route');
    });
  });

  // An unknown account id on the route is ignored with only a server warning,
  // so the launcher compares the session's account dir itself.
  it('a route session on another account throws wrong-account', async () => {
    await withFake({ mcp: 'without-tool' }, async (h) => {
      h.script({ confirm: 'other-account' });
      const err = await launchFailure(h.launcher.start(requestFor(h)));
      expect(err.code).toBe('wrong-account');
      expect(err.message).toContain(h.account.path);
    });
  });

  // The ambient account names no account, and the comparison is skipped.
  it('the ambient account omits account and skips the comparison', async () => {
    await withFake({}, async (h) => {
      h.script({ confirm: 'other-account' });
      const handle = await h.launcher.start(requestFor(h, { account: null }));
      expect(handle.account).toBeNull();
      const post = h.requests().find((r) => r.url.endsWith('/messages'));
      expect(post?.body).not.toHaveProperty('account');
    });
  });

  // The runtime rides to both start paths exactly as requested, never a
  // hardcoded claude-code.
  it('passes the runtime to the route body and to session_start', async () => {
    await withFake({ runtime: 'codex' }, async (h) => {
      await h.launcher.start(requestFor(h));
      const post = h.requests().find((r) => r.url.endsWith('/messages'));
      expect(post?.body).toMatchObject({ runtime: 'codex', account: 'codex2' });
    });
    await withFake({ runtime: 'opencode', mcp: 'with-tool' }, async (h) => {
      await h.launcher.start(requestFor(h));
      expect(h.toolCalls()[0]?.args).toMatchObject({ runtime: 'opencode', account: 'openrouter' });
    });
  });

  // DorkOS has accounts for claude-code only, so a codex or opencode request on
  // the implicit default account sends no account and DorkOS runs its ambient login.
  it('omits the implicit default account for codex and opencode', async () => {
    for (const runtime of ['codex', 'opencode'] as const) {
      await withFake({ runtime }, async (h) => {
        const handle = await h.launcher.start(
          requestFor(h, { account: { runtime, id: 'default', path: null } })
        );
        expect(handle).toMatchObject({ runtime, account: 'default' });
        const post = h.requests().find((r) => r.url.endsWith('/messages'));
        expect(post?.body).toMatchObject({ runtime });
        expect(post?.body).not.toHaveProperty('account');
      });
    }
  });

  // A session DorkOS reports on another runtime is refused as wrong-runtime,
  // not adopted: flow asked for codex and must not drive a Claude session.
  it('a session on another runtime throws wrong-runtime', async () => {
    await withFake({ runtime: 'codex', reportRuntime: 'claude-code' }, async (h) => {
      const err = await launchFailure(h.launcher.start(requestFor(h)));
      expect(err.code).toBe('wrong-runtime');
      expect(err.message).toMatch(/on claude-code instead of codex/);
    });
  });

  // The token file is this machine's own credential: it goes only to a DorkOS
  // on loopback. A remote DORKOS_URL with no explicit token skips MCP and takes
  // the route, sending no Authorization header at all.
  it('never sends the token file to a DorkOS that is not on this machine', async () => {
    await withFake({ mcp: 'with-tool', urlAs: 'http://dorkos.example:4242' }, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      expect(handle.launchPath).toBe('route');
      expect(h.requests().some((r) => r.url.startsWith('/mcp'))).toBe(false);
      for (const r of h.requests()) expect(r.authorization).toBeUndefined();
    });
  });

  // An explicit DORKOS_MCP_TOKEN is the person's own choice, so it may go to
  // any DorkOS they name; the token file on loopback still works as before.
  it('an explicit token may go to a remote DorkOS; the file token goes to loopback', async () => {
    await withFake(
      {
        mcp: 'with-tool',
        urlAs: 'http://dorkos.example:4242',
        supervisorEnv: { DORKOS_MCP_TOKEN: TOKEN },
      },
      async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        expect(handle.launchPath).toBe('mcp');
      }
    );
    for (const host of ['127.0.0.1', 'localhost']) {
      await withFake({ mcp: 'with-tool', urlAs: `http://${host}:4242` }, async (h) => {
        expect((await h.launcher.start(requestFor(h))).launchPath, host).toBe('mcp');
      });
    }
  });

  // A DorkOS whose sessions carry no status says so rather than guessing idle.
  it('state is unknown when DorkOS reports no session status', async () => {
    await withFake({ reportsStatus: false }, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      expect(await h.launcher.state(handle)).toEqual({
        kind: 'unknown',
        reason: 'this DorkOS does not report session status',
      });
    });
  });

  // A session id DorkOS cannot route is refused before anything is sent.
  it('a session id that is not a UUID is a bad request', async () => {
    await withFake({}, async (h) => {
      const err = await launchFailure(h.launcher.start(requestFor(h, { sessionId: 'not-a-uuid' })));
      expect(err.code).toBe('bad-request');
      expect(h.requests().filter((r) => r.url !== '/api/health')).toEqual([]);
    });
  });
});

describe('dorkos launcher: switching the model (spec §5.2a)', () => {
  // The session's model is written before the message, so the turn runs on it.
  it('PATCHes the model before sending, and records it on the handle', async () => {
    await withFake({ mcp: 'without-tool' }, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      const sent = await h.launcher.send(handle, h.messageFile, { model: 'sonnet' });
      const seen = h
        .requests()
        .filter((r) => r.url.startsWith(`/api/sessions/${handle.sessionId}`));
      const patchAt = seen.findIndex((r) => r.method === 'PATCH');
      expect(patchAt).toBeGreaterThan(-1);
      expect(seen[patchAt]?.body).toEqual({ model: 'sonnet' });
      expect(seen.slice(patchAt).some((r) => r.method === 'POST')).toBe(true);
      expect(sent.handle.model).toBe('sonnet');
    });
  });

  // A DorkOS that will not switch this session reports unsupported and sends nothing.
  it('a refused model change is unsupported, and no message goes out', async () => {
    await withFake({ mcp: 'without-tool', refuseModel: true }, async (h) => {
      const handle = await h.launcher.start(requestFor(h));
      const before = h.requests().length;
      await expect(
        h.launcher.send(handle, h.messageFile, { model: 'sonnet' })
      ).rejects.toMatchObject({
        code: 'unsupported',
      });
      expect(
        h
          .requests()
          .slice(before)
          .some((r) => r.method === 'POST')
      ).toBe(false);
    });
  });
});

describe('dorkos launcher: errors and the token', () => {
  // Sign-in on: the HTTP route answers 401, and the person is told what to set.
  it('a 401 on the route is auth with the sign-in sentence', async () => {
    await withFake({ apiStatus: 401 }, async (h) => {
      const err = await launchFailure(h.launcher.start(requestFor(h)));
      expect(err.code).toBe('auth');
      expect(err.message).toBe(DORKOS_AUTH_MESSAGE);
    });
  });

  // Any other failure is unavailable with the status and the server's words.
  it('another non-2xx on the route is unavailable with the status and message', async () => {
    await withFake({ apiStatus: 500 }, async (h) => {
      const err = await launchFailure(h.launcher.start(requestFor(h)));
      expect(err.code).toBe('unavailable');
      expect(err.message).toContain('500');
      expect(err.message).toContain('Something broke');
    });
  });

  // The token goes only in the MCP Authorization header: never to the HTTP
  // API, never to stdout or stderr, and never inside a thrown message, even
  // when the server echoes it back.
  it('the token never appears in stdout, stderr or an error', async () => {
    const out: string[] = [];
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      out.push(String(chunk));
      return (writeOut as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      out.push(String(chunk));
      return (writeErr as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      // The tool's refusal quotes the Authorization header back.
      await withFake({ mcp: 'refuse', echoAuth: true }, async (h) => {
        const err = await launchFailure(h.launcher.start(requestFor(h)));
        expect(err.code).toBe('refused');
        expect(err.message).toContain('you sent Bearer');
        expect(err.message).not.toContain(TOKEN);
        expect(err.stack ?? '').not.toContain(TOKEN);
      });
      // A whole session's life: the token rides only on /mcp, never the HTTP API.
      await withFake({ mcp: 'with-tool' }, async (h) => {
        const handle = await h.launcher.start(requestFor(h));
        await h.launcher.send(handle, h.messageFile);
        await h.launcher.state(handle);
        expect(JSON.stringify(handle)).not.toContain(TOKEN);
        for (const r of h.requests()) {
          if (r.url !== '/mcp') expect(r.authorization).toBeUndefined();
        }
      });
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    }
    expect(out.join('')).not.toContain(TOKEN);
  });
});
