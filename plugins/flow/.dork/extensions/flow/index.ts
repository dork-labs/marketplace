/**
 * The Flow extension's client entry (specs `claude-account-ui` §8 and
 * `flow-multiproject` §3, §5.4): the Flow tab in DorkOS Settings, under
 * Add-ons (the host names it `flow:fleet`, which the note in Settings →
 * Runtimes links to); the Flow tab beside every chat, which follows the chat's
 * project; and the palette commands that pause and resume.
 *
 * One live store (`ui/store.ts`) feeds all of them: it starts here and stops
 * in the cleanup.
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
import { FleetTab } from './ui/fleet-tab.ts';
import { FlowIcon } from './ui/flow-icon.ts';
import { createFlowTab } from './ui/flow-tab.ts';
import { registerPalette } from './ui/palette.ts';
import { FlowStore } from './ui/store.ts';

/** The part of DorkOS's `ExtensionAPI` this extension uses. */
export type FlowExtensionApi = ClientApi;

/**
 * Called by DorkOS when the extension is enabled: starts the live store and
 * registers the Settings tab, the Flow tab and the palette commands.
 *
 * @param api - DorkOS's extension API.
 * @returns The cleanup DorkOS runs when the extension is turned off.
 */
export function activate(api: FlowExtensionApi): () => void {
  const store = new FlowStore(api);
  store.start();
  const removeTab = api.registerSettingsTab('fleet', 'Flow', FleetTab as ComponentType, {
    group: 'Add-ons',
  });
  const removePanel = api.registerComponent('right-panel', 'panel', createFlowTab(api, store), {
    label: 'Flow',
    icon: FlowIcon,
  });
  const removePalette = registerPalette(api, store);
  return () => {
    removePalette();
    removePanel();
    removeTab();
    store.stop();
  };
}
