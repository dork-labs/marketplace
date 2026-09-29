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
 * - Every route that changes something runs behind DorkOS's person guard
 *   (`ctx.requirePerson`): an agent calling flow's routes cannot pause a
 *   project or change an account's policy. On a DorkOS without the guard the
 *   pause routes are not registered at all; the fleet writes keep working as
 *   they always have there, since that DorkOS has no other way to change them.
 * - On a DorkOS without `ctx.dorkHome` and the accounts API (before 0.88.0),
 *   no advisor is registered and every route answers `501 { reason: 'host-too-old' }`.
 *
 * DorkOS bundles this file and its relative imports with esbuild, so it uses
 * only flow's zod-free modules (`engine-tests/extension-zod-free.test.ts`
 * guards that).
 *
 * @module @dorkos/flow/extension/server
 */

import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { updateFleetPolicy } from '../../../scripts/fleet/accounts.ts';
import { createAdvisor, type ExecFileLike, type FlowAdvisor } from './lib/advisor.ts';
import { buildCapacity, parseSince } from './lib/capacity.ts';
import { ContinuedWatcher } from './lib/continued-watcher.ts';
import { ModelService } from './lib/model-service.ts';
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
  AccountsApi,
  DataProviderContext,
  ExtensionRouter,
  ProjectsApi,
  RouteHandler,
  RouteMiddleware,
  RouteResponse,
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
}

/** What {@link createFlowExtension} built. */
export interface FlowExtension {
  /** The advisor, or `null` on a host too old for one. */
  advisor: FlowAdvisor | null;
  /** The watcher, or `null` on a host too old for one. */
  watcher: ContinuedWatcher | null;
  /** The Flow tab's model service, or `null` on a host too old for one. */
  model: ModelService | null;
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
 * Send a route error, or a 500 for anything else. A refusal flow made on
 * purpose carries `refusedBy: 'flow'`, so the Flow tab shows its words and
 * never the host's own (such as a 404 for routes that are not mounted).
 */
function fail(res: RouteResponse, error: unknown): void {
  if (error instanceof RouteError) {
    res.status(error.status).json({ error: error.message, refusedBy: 'flow' });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

/** Wrap a handler so a thrown error becomes a JSON answer. */
function handle(fn: RouteHandler): RouteHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      fail(res, error);
    }
  };
}

/**
 * Whether the host gives this extension what it needs: `dorkHome` and the
 * accounts API with `list`, `registerAdvisor` and `markContinued`.
 *
 * @param ctx - The host's context.
 * @returns True on a host new enough.
 */
export function hostSupportsFlow(
  ctx: DataProviderContext
): ctx is DataProviderContext & { dorkHome: string; accounts: AccountsApi } {
  return (
    typeof ctx.dorkHome === 'string' &&
    typeof ctx.accounts?.list === 'function' &&
    typeof ctx.accounts.registerAdvisor === 'function' &&
    typeof ctx.accounts.markContinued === 'function'
  );
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
 * Whether the host can tell a person from an agent (`ctx.requirePerson`).
 * Without it, no route that pauses or resumes a project is registered.
 *
 * @param ctx - The host's context.
 * @returns True when it can.
 */
export function hostSupportsPersonGuard(
  ctx: DataProviderContext
): ctx is DataProviderContext & { requirePerson: RouteMiddleware } {
  return typeof ctx.requirePerson === 'function';
}

/**
 * Register the routes and the advisor.
 *
 * @param router - The router DorkOS mounts at `/api/ext/flow/`.
 * @param ctx - The host's context.
 * @param overrides - Replacements for the real machine (tests).
 * @returns What was built.
 */
export function createFlowExtension(
  router: ExtensionRouter,
  ctx: DataProviderContext,
  overrides: FlowExtensionOverrides = {}
): FlowExtension {
  if (!hostSupportsFlow(ctx)) {
    const tooOld: RouteHandler = (_req, res) => {
      res.status(501).json({ reason: 'host-too-old' });
    };
    router.get('/fleet', tooOld);
    router.put('/fleet/accounts/:key', tooOld);
    router.put('/fleet/handoff', tooOld);
    router.put('/fleet/cross-runtime', tooOld);
    router.get('/model', tooOld);
    router.post('/pause', tooOld);
    router.post('/resume', tooOld);
    router.post('/schedules/restored', tooOld);
    router.get('/capacity', tooOld);
    return { advisor: null, watcher: null, model: null, dispose: () => {} };
  }

  const { dorkHome, accounts } = ctx;
  const guard: RouteMiddleware | undefined = hostSupportsPersonGuard(ctx)
    ? ctx.requirePerson
    : undefined;
  // A route that changes something runs behind the person guard when the host has one.
  const guarded = (handler: RouteHandler) => (guard === undefined ? [handler] : [guard, handler]);
  const writer = overrides.writer ?? updateFleetPolicy;
  const now = overrides.now ?? (() => new Date());
  const log = overrides.log ?? ((message: string) => console.warn(message));
  const view = async () => buildFleetView(dorkHome, await accounts.list(), now());

  router.get(
    '/fleet',
    handle(async (_req, res) => {
      res.status(200).json(await view());
    })
  );
  router.put(
    '/fleet/accounts/:key',
    ...guarded(
      handle(async (req, res) => {
        await putAccountPolicy({
          dorkHome,
          summaries: await accounts.list(),
          key: req.params.key,
          body: req.body,
          writer,
        });
        res.status(200).json(await view());
      })
    )
  );
  router.put(
    '/fleet/handoff',
    ...guarded(
      handle(async (req, res) => {
        await putHandoff({ dorkHome, body: req.body, writer });
        res.status(200).json(await view());
      })
    )
  );
  router.put(
    '/fleet/cross-runtime',
    ...guarded(
      handle(async (req, res) => {
        await putCrossRuntime({ dorkHome, body: req.body, writer });
        res.status(200).json(await view());
      })
    )
  );

  // extensionDir is <flow plugin>/.dork/extensions/flow.
  const flowRoot = path.resolve(ctx.extensionDir, '../../..');
  const exec = overrides.execFile ?? (execFile as unknown as ExecFileLike);
  const storage = new SharedStorage(ctx.storage);
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
    canChange: guard !== undefined,
    log,
    pidAlive: overrides.pidAlive,
  });
  router.get(
    '/model',
    handle(async (req, res) => {
      const cwd = typeof req.query?.cwd === 'string' ? req.query.cwd : undefined;
      model.noteCwd(cwd);
      res.status(200).json(await model.model(cwd));
    })
  );
  router.get(
    '/capacity',
    handle(async (req, res) => {
      const at = now();
      const usage =
        typeof accounts.usage === 'function' ? await accounts.usage().catch(() => []) : [];
      res.status(200).json(
        await buildCapacity({
          dorkHome,
          summaries: await accounts.list(),
          usage,
          projects: await model.projects(),
          since: parseSince(req.query?.since, at),
          now: at,
        })
      );
    })
  );
  if (guard !== undefined) {
    router.post(
      '/pause',
      ...guarded(
        handle(async (req, res) => {
          res.status(200).json(await model.pause(req.body));
        })
      )
    );
    router.post(
      '/resume',
      ...guarded(
        handle(async (req, res) => {
          res.status(200).json(await model.resume(req.body));
        })
      )
    );
    router.post(
      '/schedules/restored',
      ...guarded(
        handle(async (req, res) => {
          const body = (req.body ?? {}) as { project?: unknown; ids?: unknown };
          res.status(200).json(await model.schedulesRestored(body.project, body.ids));
        })
      )
    );
  }
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
    advisor,
    watcher,
    model,
    dispose() {
      stopWatching();
      stopModelPoll();
      stopProjects();
      model.dispose();
      unregister();
    },
  };
}

/**
 * The server entry point DorkOS calls.
 *
 * @param router - The router DorkOS mounts at `/api/ext/flow/`.
 * @param ctx - The host's context.
 * @returns The cleanup DorkOS runs on shutdown or reload.
 */
export default function register(router: ExtensionRouter, ctx: DataProviderContext): () => void {
  return createFlowExtension(router, ctx).dispose;
}
