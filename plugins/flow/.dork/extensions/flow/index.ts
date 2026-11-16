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
 * DorkOS client API version 2 (`extension.json` `clientApiVersion`): each
 * screen runs in a frame of its own, and `activate` runs once to register
 * (`api.context` is `registration`; that run stays loaded, hidden, and runs
 * the palette commands and the tab's dot) and once more inside each screen.
 * Every run registers the same surfaces, so the frame knows what to draw, and
 * starts one live store (`ui/store.ts`), which stops in the cleanup. Only the
 * registration run keeps the tab's dot. The status bar's run chip and the
 * dot are added only where the host has them, and skipped cleanly where it
 * does not.
 *
 * DorkOS builds this file as a classic script with `react`, `react-dom` and
 * `@dorkos/extension-api` as externals and hands `activate` its frame API.
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
import { setFlowRequester } from './ui/api.ts';
import { createSettingsTab } from './ui/settings-tab.ts';
import { FlowStore } from './ui/store.ts';

/** The part of DorkOS's `ExtensionAPI` this extension uses. */
export type FlowExtensionApi = ClientApi;

/**
 * Called by DorkOS in each of flow's frames: hands the calls the frame's API,
 * starts the live store and registers every surface the host can carry.
 *
 * @param api - DorkOS's frame API.
 * @returns The cleanup DorkOS runs when the frame goes away.
 */
export function activate(api: FlowExtensionApi): () => void {
  setFlowRequester(api);
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
  // The dot is the registration run's alone; a screen's frame would only repeat it.
  const stopMarker = api.context === 'view' ? () => {} : followMarker(api, store);
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
