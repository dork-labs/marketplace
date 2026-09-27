/**
 * The Flow extension's client entry (spec `claude-account-ui` §8.1, §8.3,
 * §8.5): it adds the Flow tab to DorkOS Settings, under Add-ons (the host
 * names it `flow:fleet`, which the note in Settings → Runtimes links to), and
 * the Flow panel to the right-side panel beside every chat.
 *
 * DorkOS bundles this file with `react`, `react-dom` and
 * `@dorkos/extension-api` as externals and hands `activate` its extension API.
 * Only the methods used here are typed, so the plugin needs no DorkOS package
 * to build.
 *
 * @module @dorkos/flow/extension
 */

import type { ComponentType } from 'react';
import { FleetTab } from './ui/fleet-tab.ts';
import { FlowIcon } from './ui/flow-icon.ts';
import { createFlowPanel, type PanelHostApi } from './ui/flow-panel.ts';

/** The part of DorkOS's `ExtensionAPI` this extension uses. */
export interface FlowExtensionApi extends PanelHostApi {
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
  /**
   * Add a component to a UI slot; for `right-panel`, a tab with `label` and `icon`.
   *
   * @returns A function that removes it.
   */
  registerComponent(
    slot: 'right-panel',
    id: string,
    component: ComponentType,
    options?: { label?: string; icon?: ComponentType<{ className?: string }> }
  ): () => void;
}

/**
 * Called by DorkOS when the extension is enabled: registers the Flow tab and
 * the Flow panel.
 *
 * @param api - DorkOS's extension API.
 * @returns The cleanup DorkOS runs when the extension is turned off.
 */
export function activate(api: FlowExtensionApi): () => void {
  const removeTab = api.registerSettingsTab('fleet', 'Flow', FleetTab as ComponentType, {
    group: 'Add-ons',
  });
  const removePanel = api.registerComponent('right-panel', 'panel', createFlowPanel(api), {
    label: 'Flow',
    icon: FlowIcon,
  });
  return () => {
    removePanel();
    removeTab();
  };
}
