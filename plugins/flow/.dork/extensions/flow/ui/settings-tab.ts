/**
 * Settings → Flow (spec `flow-multiproject` §8.1, V6): the same project
 * settings as each project's own page, with a project switcher on top, then
 * "This computer", the accounts flow may use, as before.
 *
 * - The switcher starts on the project ⚙ asked for (on a DorkOS without flow's
 *   pages), else the chat's project, else the first by name. The heading
 *   always names the project being edited ("Editing dorkos"), so a change is
 *   never made to the wrong one by mistake.
 * - Opening the tab moves any "Only for these repos" into DorkOS once, where
 *   DorkOS keeps accounts to projects itself, and says what moved (§8.5).
 *
 * The tab id stays `fleet`, so Settings → Runtimes' link to `flow:fleet` still
 * lands here.
 *
 * @module @dorkos/flow/extension/ui/settings-tab
 */

import type { ComponentType } from 'react';
import type { ClientApi } from '../lib/host-types.ts';
import type { FlowProject } from '../lib/model.ts';
import { RUNTIMES_SETTINGS_LINK } from './account-checkboxes.ts';
import { getFleet, getRepoMigration, putAccount, putRepoMigration } from './api.ts';
import {
  getEligibility,
  hasEligibilityRoutes,
  listCoreProjects,
  putOnlyProjects,
} from './core-api.ts';
import { FleetTab, type CoreRules } from './fleet-tab.ts';
import { migrateRepos, type MigrationDeps, type MigrationLine } from './migrate-repos.ts';
import { ProjectFlowSettings } from './project-settings.ts';
import { h, useEffect, useId, useState, type Node } from './react.ts';
import type { FlowStore } from './store.ts';
import { useStore } from './store.ts';
import { ALERT, FIELD, FOCUS_CSS, HEADING, MUTED, NOTICE, ROOT } from './styles.ts';

/** The real routes the move uses. */
export const MIGRATION_DEPS: MigrationDeps = {
  hasEligibilityRoutes,
  getFleet,
  listProjects: listCoreProjects,
  getEligibility: () => getEligibility(),
  putOnlyProjects,
  putAccount,
  getRecord: getRepoMigration,
  putRecord: putRepoMigration,
  now: () => new Date(),
};

/**
 * Which project the switcher starts on: the one ⚙ asked for, else the chat's,
 * else the first by name.
 *
 * @param projects - Every flow project.
 * @param asked - The project ⚙ asked for, or `null`.
 * @param current - The chat's project root, or `null`.
 * @returns The project's name, or `null` with no projects.
 */
export function startingProject(
  projects: readonly FlowProject[],
  asked: string | null,
  current: string | null
): string | null {
  if (asked !== null && projects.some((project) => project.name === asked)) return asked;
  const here = projects.find((project) => project.root === current);
  if (here !== undefined) return here.name;
  return [...projects].sort((a, b) => a.name.localeCompare(b.name))[0]?.name ?? null;
}

/**
 * Build the Settings → Flow tab over the live store.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @param deps - The move's routes (tests stand in for them).
 * @returns The tab's component.
 */
export function createSettingsTab(
  api: Pick<ClientApi, 'navigate' | 'getState' | 'projectSettings'>,
  store: FlowStore,
  deps: MigrationDeps = MIGRATION_DEPS
): ComponentType {
  function FlowSettingsTab(): Node {
    const snapshot = useStore(store);
    const projects = snapshot.model?.projects ?? [];
    const [picked, setPicked] = useState<string | null>(null);
    const [moved, setMoved] = useState<MigrationLine[]>([]);
    const [rules, setRules] = useState<CoreRules | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const switcherId = useId();

    useEffect(() => {
      let live = true;
      const openRuntimes = () => api.navigate(RUNTIMES_SETTINGS_LINK);
      migrateRepos(deps)
        .catch((): MigrationLine[] => [])
        .then(async (lines) => {
          if (!live) return;
          setMoved(lines);
          if (lines.some((line) => line.kind !== 'failed')) setReloadKey((n) => n + 1);
          if (!(await deps.hasEligibilityRoutes())) return;
          const answer = await deps.getEligibility().catch(() => null);
          if (!live || answer === null) return;
          const onlyFor = new Map<string, string[]>();
          for (const row of answer.accounts) {
            if (row.onlyProjects !== null) onlyFor.set(row.id, row.onlyProjects.map((p) => p.name));
          }
          setRules({ onlyFor, openRuntimes });
        });
      return () => {
        live = false;
      };
    }, []);

    const current =
      snapshot.currentProject?.root ??
      projects.find((project) => project.name === snapshot.model?.cwdProject)?.root ??
      null;
    const name = picked ?? startingProject(projects, store.settingsProject, current);
    const project = projects.find((candidate) => candidate.name === name) ?? null;

    return h(
      'div',
      { className: 'flow-fleet-tab', style: ROOT },
      h('style', null, FOCUS_CSS),
      moved.length === 0
        ? null
        : h(
            'div',
            { role: 'status', style: { ...NOTICE, marginBottom: '12px' } },
            ...moved.map((line, index) =>
              h(
                'p',
                { key: index, style: line.kind === 'failed' ? ALERT : { margin: '0 0 4px' } },
                line.text
              )
            ),
            moved.some((line) => line.kind !== 'failed')
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: {
                      padding: 0,
                      border: 0,
                      background: 'transparent',
                      color: 'inherit',
                      font: 'inherit',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                    },
                    onClick: () => api.navigate(RUNTIMES_SETTINGS_LINK),
                  },
                  'Change this in Settings → Runtimes →'
                )
              : null
          ),
      project === null
        ? null
        : h(
            'section',
            { 'aria-labelledby': `${switcherId}-heading`, style: { marginBottom: '20px' } },
            projects.length > 1
              ? h(
                  'label',
                  { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                  'Project:',
                  h(
                    'select',
                    {
                      id: switcherId,
                      value: project.name,
                      style: FIELD,
                      onChange: (event: { target: HTMLSelectElement }) => setPicked(event.target.value),
                    },
                    ...[...projects]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((candidate) =>
                        h('option', { key: candidate.name, value: candidate.name }, candidate.name)
                      )
                  )
                )
              : null,
            h('h3', { id: `${switcherId}-heading`, style: { ...HEADING, marginTop: '8px' } }, `Editing ${project.name}`),
            h('p', { style: { ...MUTED, wordBreak: 'break-all' } }, project.root),
            h(ProjectFlowSettings, { key: project.name, project, api })
          ),
      h('h3', { style: { ...HEADING, fontSize: '14px', margin: '8px 0 6px' } }, 'This computer'),
      h(FleetTab, { rules, reloadKey })
    );
  }
  return FlowSettingsTab as ComponentType;
}
