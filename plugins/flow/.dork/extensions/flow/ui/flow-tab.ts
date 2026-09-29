/**
 * The Flow tab in DorkOS's right-side panel (spec `flow-multiproject` §3.1):
 * it follows the chat. Beside a chat in a flow project it shows that project
 * (the project lens); anywhere else it shows the projects that need something
 * (the all-projects lens). Accounts are not here: the account chip and
 * Settings show them.
 *
 * It reads the one live store `activate` started (`store.ts`), and picks the
 * lens from DorkOS's `currentProject`, or, on a DorkOS that does not say, from
 * the project flow found for the chat's folder (`cwdProject`).
 *
 * On a DorkOS with extension pages, the lenses link out to flow's pages
 * (`home-page.ts`): a project's line opens its page, ⚙ its settings page, and
 * "need you elsewhere" Flow home. Without pages they stay in the tab.
 *
 * @module @dorkos/flow/extension/ui/flow-tab
 */

import type { ComponentType } from 'react';
import type { FlowModel, FlowProject } from '../lib/model.ts';
import type { ClientApi } from '../lib/host-types.ts';
import type { AnswerApi } from './answers.ts';
import { AllProjects } from './all-projects.ts';
import { hasPages } from './links.ts';
import { FOCUS_CSS, PANEL } from './parts.ts';
import { ProjectLens } from './project-lens.ts';
import { h, useEffect, useState, type Node } from './react.ts';
import { useStore, type FlowStore, type StoreSnapshot } from './store.ts';
import { ALERT, CHIP } from './styles.ts';

/** Shown when the tab could not read flow's status. */
export const LOAD_FAILED_TEXT = "Couldn't load Flow's status. Try again in a moment.";

/** The action beside {@link LOAD_FAILED_TEXT}. */
export const RETRY_TEXT = 'Retry';

/**
 * The flow project the chat is in, or `null`.
 *
 * @param snapshot - The store: the chat's project as DorkOS says, and the model.
 * @param model - The model.
 * @returns The project.
 */
export function chatProject(snapshot: StoreSnapshot, model: FlowModel): FlowProject | null {
  const current = snapshot.currentProject;
  if (current !== undefined) {
    return current === null
      ? null
      : (model.projects.find((project) => project.root === current.root) ?? null);
  }
  return model.projects.find((project) => project.name === model.cwdProject) ?? null;
}

/**
 * Build the Flow tab over DorkOS's client API and the live store.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @returns The tab's component.
 */
export function createFlowTab(
  api: AnswerApi & Pick<ClientApi, 'registerPage'>,
  store: FlowStore
): ComponentType {
  const pages = hasPages(api);
  function FlowTab(): Node {
    const snapshot = useStore(store);
    const [showAll, setShowAll] = useState(false);
    const model = snapshot.model;
    const project = model === null ? null : chatProject(snapshot, model);
    // A new chat's project replaces a lens someone switched away from.
    useEffect(() => setShowAll(false), [project?.root ?? null]);

    const root = (...children: Node[]): Node =>
      h('div', { className: 'flow-tab', style: PANEL }, h('style', null, FOCUS_CSS), ...children);

    if (snapshot.phase === 'failed') {
      return root(
        h(
          'p',
          { key: `load-failed-${snapshot.failures}`, role: 'alert', style: ALERT },
          LOAD_FAILED_TEXT
        ),
        h(
          'button',
          {
            type: 'button',
            style: { ...CHIP, marginTop: '6px', cursor: 'pointer' },
            onClick: () => store.retry(),
          },
          RETRY_TEXT
        )
      );
    }
    if (model === null) return root(h('div', { 'aria-busy': true }));
    if (project !== null && !showAll) {
      return root(
        h(ProjectLens, {
          project,
          model,
          api,
          store,
          schedulesStuck: snapshot.schedulesStuck.has(project.name),
          pages,
          onShowAll: () => setShowAll(true),
        })
      );
    }
    return root(h(AllProjects, { model, currentProject: snapshot.currentProject, api, pages }));
  }
  return FlowTab as ComponentType;
}
