/**
 * Opt-in proof against delivered DorkOS source. The client, HTTP chain, bearer
 * verifier, identity resolver, gated MCP registration, start handler, and
 * fresh-create route are real. Only the final turn dispatcher is a recording
 * sink: there is no provider process or inference here.
 */
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDorkosLauncher } from '../../../scripts/launchers/dorkos.ts';
import { LaunchError } from '../../../scripts/launchers/types.ts';
import { requestFor } from '../contract.ts';

const source = process.env.DORKOS_SOURCE_ROOT!;
const serverSource = path.join(source, 'apps/server/src');
const modulePath = (relative: string) => path.join(serverSource, relative);
const load = (relative: string) => import(modulePath(relative));
const requireServer = createRequire(path.join(source, 'apps/server/package.json'));
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-current-server-')));
const dorkHome = path.join(root, 'data');
const agentHome = path.join(root, 'agent');
const otherAgentHome = path.join(root, 'other-agent');
const accountHome = path.join(root, 'account');
for (const folder of [dorkHome, agentHome, otherAgentHome, accountHome])
  mkdirSync(folder, { recursive: true });
const promptFile = path.join(agentHome, 'prompt.md');
const messageFile = path.join(agentHome, 'message.md');
writeFileSync(promptFile, 'Owned nonpaid fixture.');
writeFileSync(messageFile, 'Owned follow-up fixture.');

// Installed keys, logins and profiles are never inputs to this proof. All
// source is imported only after the fixture environment has been installed.
for (const name of Object.keys(process.env)) {
  if (
    /^(ANTHROPIC_|OPENAI_|OPENROUTER_|CODEX_|CLAUDE_|DORKOS_|DORK_HOME$|COMMUNITY_|MCP_API_KEY$|BETTER_AUTH_SECRET$)/.test(
      name
    )
  ) {
    vi.stubEnv(name, undefined);
  }
}
vi.stubEnv('HOME', root);
vi.stubEnv('USERPROFILE', root);
vi.stubEnv('DORK_HOME', dorkHome);
vi.stubEnv('DORKOS_DEFAULT_CWD', agentHome);
vi.stubEnv('DORKOS_BOUNDARY', root);
vi.stubEnv('DORKOS_TELEMETRY_DISABLED', '1');
vi.stubEnv('NODE_ENV', 'test');

// This is the only replacement for a production execution module. The launch
// service above it still performs all caller, place, account and runtime checks.
const turns: Record<string, any>[] = [];
const sessions = new Map<string, Record<string, any>>();
let runtimeRegistry: any;
const registeredAccounts = new Map<string, string>();
vi.doMock(modulePath('services/session/message-dispatcher.ts'), async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    modulePath('services/session/message-dispatcher.ts')
  );
  return {
    ...actual,
    dispatchMessage: async (opts: Record<string, any>) => {
      // The binding written by the REAL launch service is the authority here.
      // Never infer the selected runtime from the test request or default.
      const binding = await runtimeRegistry.resolveSessionRuntime(opts.sessionId);
      if (opts.runtime.type !== binding.type)
        throw new Error('Real launch runtime disagrees with its persisted binding.');
      const { currentDispatch } = await load('lib/dispatch-context.ts');
      turns.push({
        ...opts,
        acceptedBinding: binding,
        acceptedRuntime: opts.runtime.type,
        dispatchScope: currentDispatch(),
        acceptedAgent: await runtimeRegistry.getSessionAgentPath(opts.sessionId),
      });
      const billedFolder = opts.accountHint
        ? registeredAccounts.get(opts.accountHint)
        : sessions.get(opts.sessionId)?.account;
      sessions.set(opts.sessionId, {
        id: opts.sessionId,
        title: 'Owned fixture',
        cwd: opts.cwd ?? agentHome,
        runtime: binding.type,
        ...(billedFolder ? { account: billedFolder } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      opts.onSettled?.('ok');
      return {
        accepted: true,
        canonicalId: opts.sessionId,
        outcome: { kind: 'started', messageId: opts.messageId ?? 'fixture-message' },
        queued: false,
        queuePosition: 0,
      };
    },
  };
});

let server: Server;
let base: string;
let token: string;
let agentToken: string;
let revokedToken: string;
let otherAgentToken: string;
let db: any;
let identityService: any;
let config: any;
let runtime: any;
let omitSessionTool = false;
const requests: { url: string; method: string; headers: Record<string, string> }[] = [];

beforeAll(async () => {
  const { initConfigManager } = await load('services/core/config-manager.ts');
  config = initConfigManager(dorkHome);
  const { createTestDb } = await import(path.join(source, 'packages/test-utils/src/db.ts'));
  db = createTestDb();
  const { AccountIds } = await load('services/audit/account-ids.ts');
  const { AuditLog } = await load('services/audit/audit-log.ts');
  const { initAuditTrail } = await load('services/audit/audit-trail.ts');
  const accounts = new AccountIds({
    db,
    installId: 'owned-flow-contract',
    readOwnerAccount: () => null,
  });
  initAuditTrail({ accounts, log: new AuditLog(db) });
  const { wireSessionVisibility } = await load('services/audit/wire-session-visibility.ts');
  wireSessionVisibility({ db, accounts });
  const { initAuth } = await load('services/core/auth/index.ts');
  initAuth(db, dorkHome);
  const { initAgentIdentityService } = await load(
    'services/core/agent-identity/agent-identity-service.ts'
  );
  identityService = initAgentIdentityService(db);
  agentToken = await identityService.mint({ agentPath: agentHome, displayName: 'Owned fixture' });
  otherAgentToken = await identityService.mint({
    agentPath: otherAgentHome,
    displayName: 'Other owned fixture',
  });
  const revokedHome = path.join(root, 'revoked');
  revokedToken = await identityService.mint({
    agentPath: revokedHome,
    displayName: 'Revoked fixture',
  });
  await identityService.revoke(revokedHome);
  const { setAgentHomeRegistry } = await load('services/core/agent-identity/agent-home.ts');
  setAgentHomeRegistry({
    isRegisteredHome: (dir: string) => dir === agentHome || dir === otherAgentHome,
    listRegisteredHomes: () => [agentHome, otherAgentHome],
    managedWorkspaceOwner: () => null,
    roomsDir: path.join(dorkHome, 'rooms'),
  });
  const { initBoundary } = await load('lib/boundary.ts');
  await initBoundary(root);
  const { getMcpLocalToken } = await load('services/core/auth/mcp-local-token.ts');
  token = getMcpLocalToken();
  ({ runtimeRegistry } = await load('services/core/runtime-registry.ts'));
  runtimeRegistry.setDb(db);
  const { FakeAgentRuntime } = await import(
    path.join(source, 'packages/test-utils/src/fake-agent-runtime.ts')
  );
  runtime = new FakeAgentRuntime('claude-code');
  const { CLAUDE_CODE_CAPABILITIES } = await load(
    'services/runtimes/claude-code/runtime-constants.ts'
  );
  runtime.getCapabilities.mockReturnValue({ ...CLAUDE_CODE_CAPABILITIES, supportsAccounts: true });
  runtime.getSessionCwd = (id: string) => sessions.get(id)?.cwd;
  runtime.getSession.mockImplementation(async (_cwd: string, id: string) => {
    const session = sessions.get(id);
    return session?.runtime === runtime.type ? session : null;
  });
  runtime.getSessionAccount = (id: string) => sessions.get(id)?.account;
  runtime.accountRootForSession = async (id: string) => sessions.get(id)?.account ?? null;
  runtimeRegistry.register(runtime);
  const codex = new FakeAgentRuntime('codex');
  const { CODEX_CAPABILITIES } = await load('services/runtimes/codex/runtime-constants.ts');
  codex.getCapabilities.mockReturnValue(CODEX_CAPABILITIES);
  codex.getSessionCwd = (id: string) => sessions.get(id)?.cwd;
  codex.getSession.mockImplementation(async (_cwd: string, id: string) => {
    const session = sessions.get(id);
    return session?.runtime === codex.type ? session : null;
  });
  runtimeRegistry.register(codex);
  runtimeRegistry.setDefault('claude-code');
  const { setAccountUsageStore } = await load('services/core/usage/current-usage-store.ts');
  const account = {
    runtime: 'claude-code',
    id: 'owned-account',
    path: accountHome,
    label: 'Owned fixture',
    canonicalPath: accountHome,
    color: '#123456',
    storedColor: null,
    routable: true,
    implicit: false,
    isDefault: false,
    ledgerId: 'owned-account',
  };
  registeredAccounts.set(account.id, account.path);
  const usage = {
    ...account,
    accountId: account.id,
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [],
    state: 'unknown',
    limit: null,
    updatedAt: null,
  };
  setAccountUsageStore({
    listAccounts: (type?: string) =>
      type === undefined || type === account.runtime ? [account] : [],
    usageOfAccount: () => usage,
    usageFor: () => usage,
    peekByRoot: () => usage,
    peek: () => [],
  });
  // Named accounts need the actual registered account-policy surface to say
  // yes; no handler-level checkAccount injection bypasses that requirement.
  const { registerAccountAdvisor } = await load('services/core/usage/account-advisor.ts');
  registerAccountAdvisor('owned-flow-contract', {
    rank: (candidates: { id: string }[]) => ({
      accounts: candidates.map((candidate) => ({
        id: candidate.id,
        eligible: candidate.id === account.id,
        reason: 'Owned fixture account',
      })),
      recommendedId: null,
    }),
  });
  const { initPermissionGate } = await load('services/core/capabilities/permission-enforcement.ts');
  initPermissionGate({ readConfig: () => config.get('permissions') });
  const meshCore = {
    listWithPaths: () => [
      { id: 'owned-agent', name: 'owned', projectPath: agentHome },
      { id: 'other-owned-agent', name: 'other-owned', projectPath: otherAgentHome },
    ],
  };
  const { createApiApp } = await load('http/api-chain.ts');
  const { MainRequestAdmission } = await load('services/core/lifecycle/main-request-admission.ts');
  const app = createApiApp({ admission: new MainRequestAdmission() });
  const { createMcpRoutes } = await load('routes/mcp.ts');
  const { gatedToolRegistrar } = await load('services/core/mcp-tool-gate.ts');
  const { registerSessionTools } = await load('services/core/external-mcp/session-tools.ts');
  const { McpServer } = await import(
    requireServer.resolve('@modelcontextprotocol/sdk/server/mcp.js')
  );
  app.route(
    '/mcp',
    createMcpRoutes((caller: any) => {
      const mcp = new McpServer({ name: 'owned-flow-contract', version: '1.0.0' });
      mcp.registerTool(
        'fixture_ping',
        {
          description: 'Owned read-only fixture',
          inputSchema: {},
          annotations: { readOnlyHint: true },
        },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
      if (!omitSessionTool)
        registerSessionTools(
          gatedToolRegistrar(mcp, caller.identity),
          { meshCore, dorkHome },
          caller.identity
        );
      return mcp;
    })
  );
  const { createSessionRoutes } = await load('routes/sessions.ts');
  app.route('/api/sessions', createSessionRoutes({ meshCore }));
  app.get('/api/health', (c: any) => c.json({ status: 'ok' }));
  const { frontDoorListener } = await load('http/front-door.ts');
  const listener = frontDoorListener(app);
  server = createServer((req, res) => {
    requests.push({
      url: req.url ?? '',
      method: req.method ?? '',
      headers: { ...req.headers } as Record<string, string>,
    });
    listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  db?.$client.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function harness(
  identity: string | undefined = agentToken,
  mcpToken = token,
  refuseOriginAt?: 'tools/list' | 'tools/call',
  runtimeType: 'claude-code' | 'codex' = 'claude-code'
) {
  const launcher = createDorkosLauncher({
    fetch: (input, init) => {
      const rpc = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (String(input).endsWith('/mcp') && rpc?.method === refuseOriginAt) {
        const headers = new Headers(init?.headers);
        headers.set('origin', 'https://untrusted-fixture.invalid');
        return fetch(input, { ...init, headers });
      }
      return fetch(input, init);
    },
    env: {
      DORKOS_URL: base,
      DORK_HOME: dorkHome,
      DORKOS_MCP_TOKEN: mcpToken,
      ...(identity === undefined ? {} : { DORKOS_AGENT_TOKEN: identity }),
    },
    osHome: root,
    now: Date.now,
    sleep: async () => {},
    startTimeoutMs: 100,
  });
  const h = {
    cwd: agentHome,
    promptFile,
    messageFile,
    account:
      runtimeType === 'claude-code'
        ? { runtime: runtimeType, id: 'owned-account', path: accountHome }
        : { runtime: runtimeType, id: 'default', path: null },
    runtime: runtimeType,
    defaultPermissionMode: 'acceptEdits',
  };
  return { launcher, request: requestFor(h as any) };
}

async function failure(promise: Promise<unknown>) {
  const result = await promise.then(
    () => null,
    (error: unknown) => error
  );
  expect(result).toBeInstanceOf(LaunchError);
  return result as LaunchError;
}

function routeAttempts(since: number) {
  return requests.slice(since).filter((r) => r.url.includes('/api/sessions/'));
}

describe('Flow client against pinned delivered DorkOS admission and start', () => {
  it('starts the requested runtime and account as the registered caller', async () => {
    const { launcher, request } = harness();
    const handle = await launcher.start(request);
    expect(handle.runtime).toBe('claude-code');
    expect(handle.account).toBe('owned-account');
    expect(handle.sessionId).not.toBe(request.sessionId);
    expect(turns.at(-1)).toMatchObject({
      forAgent: agentHome,
      accountHint: 'owned-account',
      turnStarter: 'agent',
      acceptedBinding: { type: 'claude-code', bound: true },
      acceptedRuntime: 'claude-code',
      dispatchScope: { origin: 'session', dispatchId: expect.any(String) },
      acceptedAgent: agentHome,
    });
    expect(JSON.stringify(handle)).not.toContain(agentToken);
    expect(JSON.stringify(handle)).not.toContain(token);
    const since = turns.length;
    await launcher.send(handle, messageFile);
    expect(turns).toHaveLength(since + 1);
    expect(await launcher.stop(handle)).toBe('left-idle');
  });

  it('honors a non-default native runtime instead of silently choosing Claude', async () => {
    expect(runtimeRegistry.getDefault().type).toBe('claude-code');
    const { launcher, request } = harness(agentToken, token, undefined, 'codex');
    const handle = await launcher.start(request);
    expect(handle.runtime).toBe('codex');
    expect(handle.account).toBe('default');
    expect(handle.sessionId).not.toBe(request.sessionId);
    expect(turns.at(-1)).toMatchObject({
      sessionId: handle.sessionId,
      acceptedBinding: { type: 'codex', bound: true },
      acceptedRuntime: 'codex',
      dispatchScope: { origin: 'session', dispatchId: expect.any(String) },
      acceptedAgent: agentHome,
      forAgent: agentHome,
      turnStarter: 'agent',
    });
    expect(turns.at(-1)).not.toHaveProperty('accountHint');
    expect(sessions.get(handle.sessionId)?.runtime).toBe(handle.runtime);
    expect(await launcher.stop(handle)).toBe('left-idle');
  });

  it('preserves the delivered refusal of a named native account', async () => {
    const since = requests.length;
    const inputs = turns.length;
    const { launcher, request } = harness(agentToken, token, undefined, 'codex');
    request.account = { runtime: 'codex', id: 'unsupported-native-account', path: accountHome };
    const error = await failure(launcher.start(request));
    expect(error.code).toBe('refused');
    expect(error.message).toContain('ACCOUNT_NOT_SUPPORTED');
    expect(routeAttempts(since)).toEqual([]);
    expect(turns).toHaveLength(inputs);
  });

  for (const identity of ['missing', 'revoked', 'wrong'] as const) {
    it(`refuses ${identity} identity without route fallback or input`, async () => {
      const since = requests.length;
      const inputs = turns.length;
      const caller =
        identity === 'missing'
          ? ''
          : identity === 'revoked'
            ? revokedToken
            : 'not-a-registered-token';
      const { launcher, request } = harness(caller);
      await failure(launcher.start(request));
      expect(routeAttempts(since)).toEqual([]);
      expect(turns).toHaveLength(inputs);
    });
  }

  it('refuses another registered agent starting in the first agent’s home', async () => {
    const since = requests.length;
    const inputs = turns.length;
    const { launcher, request } = harness(otherAgentToken);
    const error = await failure(launcher.start(request));
    expect(error.code).toBe('refused');
    expect(error.message).toContain('OTHER_AGENTS_FOLDER');
    expect(routeAttempts(since)).toEqual([]);
    expect(turns).toHaveLength(inputs);
  });

  it('refuses unsupported MCP credentials before input and never tries an API route', async () => {
    const since = requests.length;
    const inputs = turns.length;
    const { launcher, request } = harness(agentToken, 'wrong-mcp-credential');
    await failure(launcher.start(request));
    expect(routeAttempts(since)).toEqual([]);
    expect(turns).toHaveLength(inputs);
  });

  for (const method of ['tools/list', 'tools/call'] as const) {
    it(`never falls back after a real origin-policy refusal during ${method}`, async () => {
      const since = requests.length;
      const inputs = turns.length;
      const { launcher, request } = harness(agentToken, token, method);
      await failure(launcher.start(request));
      expect(routeAttempts(since)).toEqual([]);
      expect(turns).toHaveLength(inputs);
    });
  }

  it('never falls back after the real sign-in gate refuses discovery', async () => {
    const auth = config.get('auth');
    config.set('auth', { ...auth, enabled: true });
    try {
      const since = requests.length;
      const inputs = turns.length;
      const { launcher, request } = harness();
      await failure(launcher.start(request));
      expect(routeAttempts(since)).toEqual([]);
      expect(turns).toHaveLength(inputs);
    } finally {
      config.set('auth', auth);
    }
  });

  it('explicitly creates an authorized fallback and resumes without creating again', async () => {
    omitSessionTool = true;
    try {
      const { launcher, request } = harness();
      const handle = await launcher.start(request);
      expect(handle.launchPath).toBe('route');
      expect(handle.sessionId).toBe(request.sessionId);
      await launcher.send(handle, messageFile);
      expect(await launcher.stop(handle)).toBe('left-idle');
    } finally {
      omitSessionTool = false;
    }
  });
});
