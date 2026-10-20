/**
 * The Roadmap extension's server half. It runs in its own process
 * (`runtime: "subprocess"`) that may reach api.github.com and nothing else, and
 * serves two read-only routes under `/api/ext/roadmap/` from a fetch handler:
 *
 * - `GET /board` answers the board (`?refresh=1` asks GitHub again, at most
 *   every ten seconds).
 * - `GET /config` answers the panel's names: who decides, and whose handle the
 *   "Ask in this room" message mentions.
 *
 * Nothing here writes anywhere but the extension's own storage, and no route
 * takes a path, repo or ref from the request: the repo comes from the
 * extension's settings and the file is always `roadmap/roadmap.json`.
 *
 * @module @dorkos/roadmap/extension/server
 */

import { BoardService } from './lib/board-service.ts';
import { cleanText } from './lib/roadmap.ts';

/** The part of DorkOS's `DataProviderContext` this extension uses. */
export interface RoadmapContext {
  readonly secrets: { get(key: string): Promise<string | null> };
  readonly settings: { get(key: string): Promise<string | number | boolean | null> };
  readonly storage: {
    loadData<T = unknown>(): Promise<T | null>;
    saveData<T = unknown>(data: T): Promise<void>;
  };
}

/** The `GET /config` answer. */
export interface PanelConfig {
  /** The name on the decisions lane ("Needs Sam"), or null for "Needs you". */
  deciderName: string | null;
  /** The handle "Ask in this room" mentions, without the @, or null. */
  keeperHandle: string | null;
}

/** What {@link createHandler} can be given in place of the real machine. */
export interface HandlerOverrides {
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Read the panel's names from the settings.
 *
 * @param ctx - The host's context.
 * @returns The names, cleaned.
 */
export async function readConfig(ctx: RoadmapContext): Promise<PanelConfig> {
  const decider = cleanText(await ctx.settings.get('decider_name'), 40);
  const keeperSetting = await ctx.settings.get('keeper_handle');
  const keeper = typeof keeperSetting === 'string' ? keeperSetting.trim().replace(/^@/, '') : '';
  return {
    deciderName: decider || null,
    keeperHandle: HANDLE.test(keeper) ? keeper : null,
  };
}

/**
 * Build the fetch handler.
 *
 * @param ctx - The host's context.
 * @param overrides - Replacements for the real machine (tests).
 * @returns The handler DorkOS calls for every request under `/api/ext/roadmap/`.
 */
export function createHandler(
  ctx: RoadmapContext,
  overrides: HandlerOverrides = {}
): (request: Request) => Promise<Response> {
  const service = new BoardService({
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    secrets: ctx.secrets,
    settings: ctx.settings,
    storage: ctx.storage,
    now: overrides.now,
    log: overrides.log,
  });
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/board' && path !== '/config') return json({ error: 'Not found' }, 404);
    if (request.method !== 'GET') return json({ error: 'Only GET' }, 405);
    try {
      if (path === '/config') return json(await readConfig(ctx));
      return json(await service.view({ refresh: url.searchParams.get('refresh') === '1' }));
    } catch {
      // Words of our own only: an error's message could carry anything.
      return json({ error: "The roadmap couldn't be read." }, 500);
    }
  };
}

/**
 * The server entry point DorkOS calls.
 *
 * @param _router - The Express router, unused: this extension serves with a fetch handler.
 * @param ctx - The host's context.
 * @returns The fetch handler.
 */
export default function register(_router: unknown, ctx: RoadmapContext) {
  return { fetch: createHandler(ctx) };
}
