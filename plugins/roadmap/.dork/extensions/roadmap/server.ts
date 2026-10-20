/**
 * The Roadmap extension's server half. It runs in its own process
 * (`runtime: "subprocess"`) that may reach api.github.com and nothing else, and
 * serves its routes under `/api/ext/roadmap/` from a fetch handler:
 *
 * - `GET /board` answers the board (`?refresh=1` asks GitHub again, at most
 *   every ten seconds).
 * - `GET /config` answers the panel's names and the repo for bare PR numbers.
 * - `GET /seen` and `PUT /seen` read and set the commit the person marked
 *   seen. Only a person may set it.
 *
 * The roadmap is never written: the only thing stored is in the extension's
 * own storage. No route takes a path, repo or ref from the request: the repo
 * comes from the extension's settings and the file is always
 * `roadmap/roadmap.json`. The panel calls these routes and no DorkOS core
 * route, so the extension's data has one writer.
 *
 * @module @dorkos/roadmap/extension/server
 */

import { BoardService } from './lib/board-service.ts';
import { validRepo } from './lib/github.ts';
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
  /** The `owner/name` a bare PR number in `links` belongs to, or null to show it as text. */
  prRepo: string | null;
}

/** What {@link createHandler} can be given in place of the real machine. */
export interface HandlerOverrides {
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Who sent a request, as DorkOS decided (the fetch handler's second argument). */
type Caller = unknown;

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ROUTES = new Set(['/board', '/config', '/seen']);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The refusal for a caller who is not a person, or null for a person. DorkOS
 * decides this on the real request and hands it over as `caller.person`;
 * anything this can't read is refused, as DorkOS's own `checkPerson` does.
 *
 * @param caller - The fetch handler's second argument.
 */
export function refuseUnlessPerson(caller: Caller): Response | null {
  const person = (caller as { person?: unknown } | null | undefined)?.person as
    { ok?: unknown; status?: unknown; body?: unknown } | undefined;
  if (person?.ok === true) return null;
  const status =
    typeof person?.status === 'number' && person.status >= 400 && person.status <= 599
      ? person.status
      : 403;
  return json({ error: 'Only a person can do this.', code: 'extension_person_required' }, status);
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
  const prSetting = await ctx.settings.get('pr_repo');
  const prRepo = typeof prSetting === 'string' ? prSetting.trim() : '';
  return {
    deciderName: decider || null,
    keeperHandle: HANDLE.test(keeper) ? keeper : null,
    prRepo: validRepo(prRepo) ? prRepo : null,
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
): (request: Request, caller?: Caller) => Promise<Response> {
  const service = new BoardService({
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    secrets: ctx.secrets,
    settings: ctx.settings,
    storage: ctx.storage,
    now: overrides.now,
    log: overrides.log,
  });
  return async (request, caller) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (!ROUTES.has(path)) return json({ error: 'Not found' }, 404);
    const write = path === '/seen' && request.method === 'PUT';
    if (request.method !== 'GET' && !write) return json({ error: 'Not allowed' }, 405);
    try {
      if (path === '/config') return json(await readConfig(ctx));
      if (path === '/board') {
        return json(await service.view({ refresh: url.searchParams.get('refresh') === '1' }));
      }
      if (!write) return json({ seen: await service.seen() });
      const refused = refuseUnlessPerson(caller);
      if (refused) return refused;
      const body = (await request.json().catch(() => null)) as { seen?: unknown } | null;
      if (typeof body?.seen !== 'string' || !/^[0-9a-f]{40}$/.test(body.seen)) {
        return json({ error: 'seen must be a full commit sha' }, 400);
      }
      await service.markSeen(body.seen);
      return json({ seen: body.seen });
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
