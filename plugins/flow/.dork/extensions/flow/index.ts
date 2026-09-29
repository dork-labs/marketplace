/**
 * The Flow extension's client entry (specs `claude-account-ui` §8 and
 * `flow-multiproject` §3-§8): the Flow tab in DorkOS Settings, under Add-ons
 * (the host names it `flow:fleet`, which the note in Settings → Runtimes links
 * to), with each project's settings under a switcher and this computer's
 * accounts below; the Flow tab beside every chat, which follows the chat's project, and
 * its dot when something needs you; Flow home, each project's page and its
 * settings page; the run chip in the chat's status bar; and the palette
 * commands that pause and resume.
 *
 * One live store (`ui/store.ts`) feeds all of them: it starts here and stops
 * in the cleanup. Each surface that needs a newer DorkOS (pages, the status
 * bar, the tab's dot) is added only where the host has it, and skipped
 * cleanly where it does not.
 *
 * DorkOS bundles this file with `react`, `react-dom` and
 * `@dorkos/extension-api` as externals and hands `activate` its extension API.
 * Only the methods used here are typed (`lib/host-types.ts`), so the plugin
 * needs no DorkOS package to build.
 *
 * @module @dorkos/flow/extension
 */

import type { ComponentType } from 'react';
import type { ClientApi } from './lib/host-types.ts';
import { FlowIcon } from './ui/flow-icon.ts';
import { createFlowTab } from './ui/flow-tab.ts';
import { registerPages } from './ui/home-page.ts';
import { PANEL_TAB_ID, followMarker } from './ui/marker.ts';
import { registerPalette } from './ui/palette.ts';
import { registerRunChip } from './ui/run-chip.ts';
import { createSettingsTab } from './ui/settings-tab.ts';
import { FlowStore } from './ui/store.ts';

/** The part of DorkOS's `ExtensionAPI` this extension uses. */
export type FlowExtensionApi = ClientApi;

/**
 * Called by DorkOS when the extension is enabled: starts the live store and
 * registers every surface the host can carry.
 *
 * @param api - DorkOS's extension API.
 * @returns The cleanup DorkOS runs when the extension is turned off.
 */
export function activate(api: FlowExtensionApi): () => void {
  const store = new FlowStore(api);
  store.start();
  const removeTab = api.registerSettingsTab('fleet', 'Flow', createSettingsTab(api, store), {
    group: 'Add-ons',
  });
  const removePanel = api.registerComponent(
    'right-panel',
    PANEL_TAB_ID,
    createFlowTab(api, store),
    { label: 'Flow', icon: FlowIcon }
  );
  const stopMarker = followMarker(api, store);
  const removePages = registerPages(api, store);
  const removeChip = registerRunChip(api, store);
  const removePalette = registerPalette(api, store);
  return () => {
    removePalette();
    removeChip();
    removePages();
    stopMarker();
    removePanel();
    removeTab();
    store.stop();
  };
}
