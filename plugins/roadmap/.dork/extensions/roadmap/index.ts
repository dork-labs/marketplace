/**
 * The Roadmap extension's client entry: one right-panel tab, read-only.
 *
 * The tab shows nowhere until someone picks where: on the extension's card in
 * Settings → Extensions ("Roadmap tab shows"), or with an agent's
 * `config_patch` of `ui.panelTabs`. Room ids belong to one computer, so a
 * shared package leaves them to the person (and this repo is public).
 *
 * DorkOS bundles this file with `react` as an external and hands `activate`
 * its extension API. Only the methods used here are typed.
 *
 * @module @dorkos/roadmap/extension
 */

import type { ComponentType } from 'react';
import { RoadmapIcon } from './ui/icon.ts';
import { createPanel, type PanelHostApi } from './ui/panel.ts';

/** The part of DorkOS's `ExtensionAPI` this extension uses. */
export interface RoadmapExtensionApi extends PanelHostApi {
  /**
   * Add a right-panel tab.
   *
   * @returns A function that removes it.
   */
  registerComponent(
    slot: 'right-panel',
    id: string,
    component: ComponentType,
    options?: {
      label?: string;
      icon?: ComponentType<{ className?: string }>;
      showIn?: { agents?: string[]; rooms?: string[]; pages?: string[] };
    }
  ): () => void;
}

/**
 * Called by DorkOS when the extension is enabled.
 *
 * @param api - DorkOS's extension API.
 * @returns The cleanup DorkOS runs when the extension is turned off.
 */
export function activate(api: RoadmapExtensionApi): () => void {
  return api.registerComponent('right-panel', 'board', createPanel(api), {
    label: 'Roadmap',
    icon: RoadmapIcon,
    // Nowhere by default: the person picks the room in Settings → Extensions.
    showIn: { rooms: [] },
  });
}
