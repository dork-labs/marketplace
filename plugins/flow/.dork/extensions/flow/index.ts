/**
 * The Flow extension's client entry (spec `claude-account-ui` §8.1, §8.3): it
 * adds the Flow tab to DorkOS Settings, under Add-ons. The host names it
 * `flow:fleet`, which the note in Settings → Runtimes links to.
 *
 * DorkOS bundles this file with `react`, `react-dom` and
 * `@dorkos/extension-api` as externals and hands `activate` its extension API.
 * Only the one method used here is typed, so the plugin needs no DorkOS
 * package to build.
 *
 * @module @dorkos/flow/extension
 */

import type { ComponentType } from 'react';
import { FleetTab } from './ui/fleet-tab.ts';

/** The part of DorkOS's `ExtensionAPI` this extension uses. */
export interface FlowExtensionApi {
  /**
   * Add a tab to Settings.
   *
   * @returns A function that removes it.
   */
  registerSettingsTab(
    id: string,
    label: string,
    component: ComponentType,
    options?: { group?: string }
  ): () => void;
}

/**
 * Called by DorkOS when the extension is enabled: registers the Flow tab.
 *
 * @param api - DorkOS's extension API.
 * @returns The cleanup DorkOS runs when the extension is turned off.
 */
export function activate(api: FlowExtensionApi): () => void {
  return api.registerSettingsTab('fleet', 'Flow', FleetTab as ComponentType, { group: 'Add-ons' });
}
