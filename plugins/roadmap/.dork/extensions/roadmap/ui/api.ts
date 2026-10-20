/**
 * The panel's calls. It calls only this extension's own two routes, mounted by
 * DorkOS at `/api/ext/roadmap/`, and never a DorkOS core route.
 *
 * @module @dorkos/roadmap/extension/ui/api
 */

import type { BoardView } from '../lib/board-service.ts';
import type { PanelConfig } from '../server.ts';

/** The desktop shell's bridge, when the panel runs inside the DorkOS app. */
interface ElectronBridge {
  getServerPort?: () => number | null | undefined;
}

/**
 * The DorkOS API base URL. In the desktop app the page is not served by the
 * DorkOS server, so a relative `/api` would miss it; the shell reports the port.
 *
 * @returns `http://localhost:<port>/api` in the desktop app, else `/api`.
 */
export function apiBase(): string {
  const bridge = (window as unknown as { electronAPI?: ElectronBridge }).electronAPI;
  const port = bridge?.getServerPort?.();
  return port ? `http://localhost:${port}/api` : '/api';
}

/** The extension's server didn't answer, or answered with an error. */
export class RoadmapRequestError extends Error {
  constructor() {
    super("Roadmap's server isn't answering.");
    this.name = 'RoadmapRequestError';
  }
}

async function get<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/ext/roadmap${path}`, { cache: 'no-store' });
  } catch {
    throw new RoadmapRequestError();
  }
  if (!response.ok) throw new RoadmapRequestError();
  return (await response.json()) as T;
}

/**
 * Read the board.
 *
 * @param refresh - Ask GitHub again now (the server allows it every ten seconds).
 * @returns The `GET /board` body.
 */
export function getBoard(refresh = false): Promise<BoardView> {
  return get<BoardView>(refresh ? '/board?refresh=1' : '/board');
}

/**
 * Read the names the panel uses.
 *
 * @returns The `GET /config` body.
 */
export function getConfig(): Promise<PanelConfig> {
  return get<PanelConfig>('/config');
}
