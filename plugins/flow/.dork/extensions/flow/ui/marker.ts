/**
 * The dot on the Flow tab (spec `flow-multiproject` §3.4, V3): a small amber
 * dot after the tab's label when something needs you, drawn by DorkOS. flow
 * only says whether it is on; it never styles it and never counts.
 *
 * It is on when a decision is waiting, or when every set-up project is paused
 * (so nothing is moving). A condition that only flow can fix, such as a slow
 * tracker, never turns it on. On a DorkOS without tab markers nothing happens.
 *
 * @module @dorkos/flow/extension/ui/marker
 */

import type { FlowModel } from '../lib/model.ts';
import type { ClientApi } from '../lib/host-types.ts';
import type { FlowStore } from './store.ts';

/** The id flow registers its right-panel tab under. */
export const PANEL_TAB_ID = 'panel';

/**
 * Whether the Flow tab should carry the dot.
 *
 * @param model - The model, or `null` before one arrived.
 * @returns `'attention'`, or `null` for no dot.
 */
export function markerFor(model: FlowModel | null): 'attention' | null {
  if (model === null) return null;
  if (model.decisions.length > 0) return 'attention';
  const ready = model.projects.filter((project) => project.setup === 'ready');
  if (ready.length > 0 && ready.every((project) => project.pause !== null)) return 'attention';
  return null;
}

/**
 * Keep the Flow tab's dot in step with the store. Only a change is sent.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @returns A function that stops following the store; DorkOS clears the dot itself
 *   when the extension is turned off.
 */
export function followMarker(api: Pick<ClientApi, 'setTabMarker'>, store: FlowStore): () => void {
  const setTabMarker = api.setTabMarker;
  if (typeof setTabMarker !== 'function') return () => {};
  let shown: 'attention' | null = null;
  const sync = () => {
    const next = markerFor(store.get().model);
    if (next === shown) return;
    shown = next;
    setTabMarker.call(api, PANEL_TAB_ID, next);
  };
  sync();
  return store.subscribe(sync);
}
