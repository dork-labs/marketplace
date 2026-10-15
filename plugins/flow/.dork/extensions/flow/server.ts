/**
 * The Flow extension's server half (specs `claude-account-ui` §8, and
 * `flow-multiproject` §2, §5, §11): the Flow tab's routes under
 * `/api/ext/flow/`, and flow's account advisor.
 *
 * - `GET /fleet` answers every account DorkOS knows with flow's policy for it.
 *   `PUT /fleet/accounts/:key`, `PUT /fleet/handoff` and `PUT /fleet/cross-runtime`
 *   change `<dorkHome>/flow/fleet.json` under the contract's lock and answer the
 *   new `GET /fleet` body.
 * - `GET /model` answers the Flow tab's model over every flow project, and the
 *   model is pushed as the `model` event when it changes.
 * - `POST /pause` and `POST /resume` pause or resume one project or all of
 *   them, with an end time, and answer the new model. `POST /schedules/restored`
 *   forgets DorkOS schedules the Flow tab switched back on after a pause.
 * - `GET /capacity` answers "Capacity this week" on Flow home: each account's
 *   weekly use and each project's work from its journal. Read on demand, never pushed.
 * - flow asks in DorkOS's inbox (`ctx.inbox`) only when only a person can
 *   help, with the words on every ask saying what happens and why, and
 *   answers through one handler (`lib/decisions.ts`). Who answers each kind is
 *   the project's dial, read from core's person-only per-project settings
 *   (`ctx.projectSettings`); flow's server half never writes it. On a DorkOS
 *   without the inbox, `POST /decisions/:key` answers from flow's own pages.
 * - `POST /projects/:name/allow-adapter` lets flow run a project's own tracker
 *   adapter, as it is now.
 * - `GET /settings/:name` answers a project's settings by who a change
 *   reaches, and `PUT /settings/:name` changes them: the shared file, the
 *   local file and the pause default. The dial and the accounts a project may
 *   use are DorkOS's, written only from the person's browser, never here.
 * - `GET /fleet/migration` and `PUT /fleet/migration` keep the record of
 *   moving "Only for these repos" into DorkOS, which the browser does.
 * - Every route that changes something runs behind DorkOS's person bar
 *   (`lib/person.ts`): an agent calling flow's routes cannot pause a project
 *   or change an account's policy. A path flow does not serve answers a JSON 404.
 *
 * The routes are a Hono app, served by the fetch handler `register()` returns:
 * DorkOS hands it each request under `/api/ext/flow/` with the path below the
 * mount (`GET /api/ext/flow/fleet` arrives as `GET /fleet`), and the person
 * bar's verdict on the caller as Hono's `c.env`. DorkOS builds `hono` into the
 * bundle itself, so nothing needs installing. Every answer is JSON, so the
 * reply headers DorkOS drops or rewrites (cookies, a redirect) never come up.
 *
 * DorkOS bundles this file and its relative imports with esbuild, so it uses
 * only node builtins, `hono` and flow's zod-free modules
 * (`__tests__/bundle-safety.test.ts` guards that).
 *
 * @module @dorkos/flow/extension/server
 */

import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { updateFleetPolicy } from '../../../scripts/fleet/accounts.ts';
import { createAdvisor, type ExecFileLike, type FlowAdvisor } from './lib/advisor.ts';
import { buildCapacity, parseSince } from './lib/capacity.ts';
import { ContinuedWatcher } from './lib/continued-watcher.ts';
import { ModelService } from './lib/model-service.ts';
import { requirePerson, type FlowEnv } from './lib/person.ts';
import { readRepoMigration, writeRepoMigration } from './lib/repo-migration.ts';
import { getDrainBypass, GrantStore, setDrainBypass } from './lib/drain-bypass-tools.ts';
import { SharedStorage } from './lib/shared-storage.ts';
import { GIT_TIMEOUT_MS } from './lib/run-store.ts';
import {
  RouteError,
  buildFleetView,
  putAccountPolicy,
  putCrossRuntime,
  putHandoff,
  type FleetWriter,
} from './lib/fleet.ts';
import type {
  DataProviderContext,
  InboxApi,
  ProjectSettingsReader,
  ProjectsApi,
  ServerExtensionHandlers,
  SessionsApi,
} from './lib/host-types.ts';

/** How often the watcher looks at the claimed runs' stores, in seconds (the host's minimum). */
const WATCH_INTERVAL_SECONDS = 5;

/** How often the projects are read again for changes, in seconds (the host's minimum). */
const MODEL_INTERVAL_SECONDS = 5;

/** What {@link createFlowExtension} can be given in place of the real machine. */
export interface FlowExtensionOverrides {
  /** The fleet writer (default: flow's `updateFleetPolicy`). */
  writer?: FleetWriter;
  /** The clock. */
  now?: () => Date;
  /** Runs a command with no shell (default: `child_process.execFile`). */
  execFile?: ExecFileLike;
  /** The `origin` URL of a checkout (default: `git remote get-url origin`). */
  originOf?: (cwd: string) => string | null;
  /** Where to log (default: `console.warn`). */
  log?: (message: string) => void;
  /** A monotonic clock in ms, for `move`'s deadline. */
  clockMs?: () => number;
  /** Whether a process is alive. */
  pidAlive?: (pid: number) => boolean;
  /** How long an inbox answer waits before "Sending…". */
  answerWaitMs?: number;
}

/** What {@link createFlowExtension} built. */
export interface FlowExtension {
  /** The routes, as the Hono app whose `fetch` DorkOS serves under `/api/ext/flow/`. */
  app: Hono<FlowEnv>;
  /** The advisor. */
  advisor: FlowAdvisor;
  /** The watcher. */
  watcher: ContinuedWatcher;
  /** The Flow tab's model service. */
  model: ModelService;
  /** Stop the watcher and remove the advisor. */
  dispose(): void;
}

/** The `origin` URL of the checkout at `cwd`, or `null`. */
function gitOrigin(cwd: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Answer a route error, or a 500 for anything else. A refusal flow made on
 * purpose carries `refusedBy: 'flow'`, so the Flow tab shows its words and
 * never the host's own.
 *
 * @param c - The request's context.
 * @param error - What the route threw.
 * @returns The JSON answer.
 */
function fail(c: Context<FlowEnv>, error: unknown): Response {
  if (error instanceof RouteError) {
    return c.json(
      { error: error.message, refusedBy: 'flow' },
      error.status as ContentfulStatusCode
    );
  }
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

/**
 * The request's JSON body, as the old router's `req.body` held it: DorkOS
 * parses only an `application/json` body, so any other body, and no body at
 * all, reads as `undefined`.
 *
 * @param c - The request's context.
 * @returns The parsed body, or `undefined`.
 */
async function jsonBody(c: Context<FlowEnv>): Promise<unknown> {
  const type = c.req.header('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return undefined;
  const text = await c.req.text();
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * A query parameter as the old router's `req.query` held it: missing, one
 * string, or every value when it is repeated.
 *
 * @param c - The request's context.
 * @param name - The parameter.
 * @returns Its value or values, or `undefined`.
 */
function queryValue(c: Context<FlowEnv>, name: string): string | string[] | undefined {
  const values = c.req.queries(name);
  if (values === undefined || values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

/**
 * Whether the host has core's project registry (`ctx.projects`).
 *
 * @param ctx - The host's context.
 * @returns True when it does.
 */
export function hostSupportsProjects(
  ctx: DataProviderContext
): ctx is DataProviderContext & { projects: ProjectsApi } {
  return (
    typeof ctx.projects?.list === 'function' &&
    typeof ctx.projects.resolve === 'function' &&
    typeof ctx.projects.report === 'function' &&
    typeof ctx.projects.onChange === 'function'
  );
}

/**
 * Whether the host has core's inbox (`ctx.inbox`).
 *
 * @param ctx - The host's context.
 * @returns True when it does.
 */
export function hostSupportsInbox(
  ctx: DataProviderContext
): ctx is DataProviderContext & { inbox: InboxApi } {
  const inbox = ctx.inbox;
  return (
    typeof inbox?.raise === 'function' &&
    typeof inbox.resolve === 'function' &&
    typeof inbox.record === 'function' &&
    typeof inbox.list === 'function' &&
    typeof inbox.onAction === 'function'
  );
}

/**
 * Whether the host keeps flow's per-project settings (`ctx.projectSettings`).
 *
 * @param ctx - The host's context.
 * @returns True when it does.
 */
export function hostSupportsProjectSettings(
  ctx: DataProviderContext
): ctx is DataProviderContext & { projectSettings: ProjectSettingsReader } {
  return (
    typeof ctx.projectSettings?.get === 'function' &&
    typeof ctx.projectSettings.onChange === 'function'
  );
}

/**
 * Whether the host can start work in a new chat (`ctx.sessions.start`,
 * contract 1.3.0).
 *
 * @param ctx - The host's context.
 * @returns True when it can.
 */
export function hostSupportsStartWork(
  ctx: DataProviderContext
): ctx is DataProviderContext & { sessions: SessionsApi } {
  return typeof ctx.sessions?.start === 'function';
}

/** What the answer route says on a DorkOS with the inbox (§7.6). */
export const ANSWER_IN_INBOX = 'Answer this in the Inbox.';

/**
 * Build the routes and the advisor.
 *
 * @param ctx - The host's context.
 * @param overrides - Replacements for the real machine (tests).
 * @returns What was built.
 */
export function createFlowExtension(
  ctx: DataProviderContext,
  overrides: FlowExtensionOverrides = {}
): FlowExtension {
  const { dorkHome, accounts } = ctx;
  const writer = overrides.writer ?? updateFleetPolicy;
  const now = overrides.now ?? (() => new Date());
  const log = overrides.log ?? ((message: string) => console.warn(message));
  const view = async () => buildFleetView(dorkHome, await accounts.list(), now());

  // `strict: false` keeps the router's leniency about a trailing slash.
  const app = new Hono<FlowEnv>({ strict: false });
  app.onError((error, c) => fail(c, error));
  app.notFound((c) => c.json({ error: `Flow has no ${c.req.method} ${c.req.path} route.` }, 404));
  // Every route that changes something runs behind the person bar.
  const person = requirePerson();

  app.get('/fleet', async (c) => c.json(await view()));
  app.put('/fleet/accounts/:key', person, async (c) => {
    await putAccountPolicy({
      dorkHome,
      summaries: await accounts.list(),
      key: c.req.param('key'),
      body: await jsonBody(c),
      writer,
    });
    return c.json(await view());
  });
  app.put('/fleet/handoff', person, async (c) => {
    await putHandoff({ dorkHome, body: await jsonBody(c), writer });
    return c.json(await view());
  });
  app.put('/fleet/cross-runtime', person, async (c) => {
    await putCrossRuntime({ dorkHome, body: await jsonBody(c), writer });
    return c.json(await view());
  });

  // extensionDir is <flow plugin>/.dork/extensions/flow.
  const flowRoot = path.resolve(ctx.extensionDir, '../../..');
  const exec = overrides.execFile ?? (execFile as unknown as ExecFileLike);
  const storage = new SharedStorage(ctx.storage);
  // A person's grant for unattended bypass (DOR-3062). DorkOS runs
  // set_drain_bypass only after a person grants its approval card (it is
  // destructive in extension.json); hosts before 0.98.0 have no tools.
  // The grants live in the extension's own files folder, which no DorkOS route
  // writes; never in ctx.storage, whose blob a person-less HTTP route can write.
  const filesDir =
    ctx.filesDir ??
    (ctx.dorkHome !== undefined
      ? path.join(ctx.dorkHome, 'extension-data', ctx.extensionId, 'files')
      : undefined);
  if (ctx.tools !== undefined && filesDir !== undefined) {
    const grants = new GrantStore(filesDir);
    ctx.tools.handle('set_drain_bypass', (input) => setDrainBypass(grants, input, new Date(now())));
    ctx.tools.handle('get_drain_bypass', (input) => getDrainBypass(grants, input, new Date(now())));
  }
  const projects = hostSupportsProjects(ctx) ? ctx.projects : undefined;
  const model = new ModelService({
    dorkHome,
    flowRoot,
    accounts,
    projects,
    storage,
    emit: (event, data) => ctx.emit(event, data),
    execFile: exec,
    now,
    // Every route that changes something is served, behind the person bar.
    canChange: true,
    log,
    pidAlive: overrides.pidAlive,
    inbox: hostSupportsInbox(ctx) ? ctx.inbox : undefined,
    settings: hostSupportsProjectSettings(ctx) ? ctx.projectSettings : undefined,
    sessions: hostSupportsStartWork(ctx) ? ctx.sessions : undefined,
    answerWaitMs: overrides.answerWaitMs,
  });
  // The first pass runs now, and answers are taken only once it is done.
  void model.decisions.start();
  void model.poll();
  const stopSettings = hostSupportsProjectSettings(ctx)
    ? ctx.projectSettings.onChange(() => void model.poll())
    : () => {};
  app.get('/model', async (c) => {
    const cwd = queryValue(c, 'cwd');
    const one = typeof cwd === 'string' ? cwd : undefined;
    model.noteCwd(one);
    return c.json(await model.model(one));
  });
  app.get('/settings/:name', async (c) => c.json(await model.settings(c.req.param('name'))));
  app.get('/fleet/migration', async (c) => c.json(await readRepoMigration(storage)));
  app.get('/capacity', async (c) => {
    const at = now();
    const usage = await accounts.usage().catch(() => []);
    return c.json(
      await buildCapacity({
        dorkHome,
        summaries: await accounts.list(),
        usage,
        projects: await model.projects(),
        since: parseSince(queryValue(c, 'since'), at),
        now: at,
      })
    );
  });
  app.post('/pause', person, async (c) => c.json(await model.pause(await jsonBody(c))));
  app.post('/resume', person, async (c) => c.json(await model.resume(await jsonBody(c))));
  app.post('/decisions/:key', person, async (c) => {
    // With the inbox, core's person bar and history are the path (§7.4).
    if (hostSupportsInbox(ctx)) {
      return c.json({ error: ANSWER_IN_INBOX, refusedBy: 'flow' }, 410);
    }
    return c.json(await model.answerLocal(c.req.param('key'), await jsonBody(c)));
  });
  app.post('/projects/:name/allow-adapter', person, async (c) =>
    c.json(await model.allowAdapter(c.req.param('name')))
  );
  app.put('/settings/:name', person, async (c) =>
    c.json(await model.saveSettings(c.req.param('name'), await jsonBody(c)))
  );
  app.put('/fleet/migration', person, async (c) =>
    c.json(await writeRepoMigration(storage, await jsonBody(c)))
  );
  app.post('/schedules/restored', person, async (c) => {
    const body = ((await jsonBody(c)) ?? {}) as { project?: unknown; ids?: unknown };
    return c.json(await model.schedulesRestored(body.project, body.ids));
  });
  const stopProjects =
    projects !== undefined ? projects.onChange(() => model.projectsChanged()) : () => {};
  const stopModelPoll = ctx.schedule(MODEL_INTERVAL_SECONDS, async () => model.poll());

  let advisor: FlowAdvisor | null = null;
  const watcher = new ContinuedWatcher({
    storage: storage.view(),
    accounts,
    moving: () => new Set(advisor?.inFlight.keys() ?? []),
    log,
  });
  advisor = createAdvisor({
    dorkHome,
    flowRoot,
    accounts,
    now,
    execFile: exec,
    originOf: overrides.originOf ?? gitOrigin,
    watcher,
    log,
    clockMs: overrides.clockMs,
    pidAlive: overrides.pidAlive,
  });
  const unregister = accounts.registerAdvisor(advisor);
  const stopWatching = ctx.schedule(WATCH_INTERVAL_SECONDS, () => watcher.check());
  return {
    app,
    advisor,
    watcher,
    model,
    dispose() {
      stopWatching();
      stopModelPoll();
      stopProjects();
      stopSettings();
      model.dispose();
      unregister();
    },
  };
}

/**
 * The server entry point DorkOS calls. Flow serves its routes with the fetch
 * handler it returns, so it adds nothing to the router DorkOS passes.
 *
 * @param _router - The router DorkOS passes; flow does not use it.
 * @param ctx - The host's context.
 * @returns The fetch handler DorkOS serves under `/api/ext/flow/`, and the
 *   cleanup it runs on shutdown or reload.
 */
export default function register(
  _router: unknown,
  ctx: DataProviderContext
): Required<ServerExtensionHandlers> {
  const flow = createFlowExtension(ctx);
  return { fetch: flow.app.fetch, cleanup: flow.dispose };
}
