/**
 * Settings → Flow (spec `flow-multiproject` §8.1, V6): the same project
 * settings as each project's own page, with a project switcher on top, then
 * "This computer", the accounts flow may use, as before.
 *
 * - The switcher starts on the project ⚙ asked for (on a DorkOS without flow's
 *   pages), else the chat's project, else the first by name. The heading
 *   always names the project being edited ("Editing dorkos"), so a change is
 *   never made to the wrong one by mistake.
 * - Where DorkOS keeps accounts to projects itself, an account whose "Only
 *   for these repos" could move there says so on its row, and moves only when
 *   a person clicks (§8.5). Opening the tab writes nothing.
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
import {
  UNREACHABLE_MESSAGE,
  getFleet,
  getRepoMigration,
  putAccount,
  putRepoMigration,
} from './api.ts';
import {
  getEligibility,
  hasEligibilityRoutes,
  listCoreProjects,
  putOnlyProjects,
} from './core-api.ts';
import { FleetTab, type CoreRules, type MoveLineProps } from './fleet-tab.ts';
import {
  RULE_BEHAVIOUR,
  planMoves,
  runMove,
  type MigrationDeps,
  type MovePlan,
  type MoveResult,
} from './migrate-repos.ts';
import { ProjectFlowSettings } from './project-settings.ts';
import { h, useEffect, useId, useState, type Node } from './react.ts';
import type { FlowStore } from './store.ts';
import { useStore } from './store.ts';
import { FIELD, FOCUS_CSS, HEADING, MUTED, ROOT } from './styles.ts';

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
    const allCurrent = projects.every((project) => project.version.behaviour >= RULE_BEHAVIOUR);
    const [picked, setPicked] = useState<string | null>(null);
    const [plans, setPlans] = useState<MovePlan[]>([]);
    const [results, setResults] = useState<Record<string, MoveResult>>({});
    const [moving, setMoving] = useState<string | null>(null);
    const [rules, setRules] = useState<CoreRules | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    const [seen, setSeen] = useState(0);
    const switcherId = useId();

    // ⚙ picks a project for this visit only.
    useEffect(
      () => () => {
        store.settingsProject = null;
      },
      []
    );

    // Opening the tab only reads: what could move, and DorkOS's rules. Nothing is written.
    useEffect(() => {
      let live = true;
      const openRuntimes = () => api.navigate(RUNTIMES_SETTINGS_LINK);
      planMoves(deps, allCurrent)
        .catch((): MovePlan[] => [])
        .then(async (next) => {
          if (!live) return;
          setPlans(next);
          if ((await deps.hasEligibilityRoutes()) !== true) return;
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
    }, [allCurrent, seen]);

    const move = (key: string) => {
      setMoving(key);
      runMove(deps, key, allCurrent)
        .catch(
          (failure: unknown): MoveResult => ({
            ok: false,
            text: failure instanceof Error && failure.message !== '' ? failure.message : UNREACHABLE_MESSAGE,
          })
        )
        .then((result) => {
          setMoving(null);
          setResults((current) => ({ ...current, [key]: result }));
          setReloadKey((n) => n + 1);
          setSeen((n) => n + 1);
        });
    };
    const moves = new Map<string, MoveLineProps>(
      plans.map((plan) => [
        plan.key,
        {
          plan,
          result: results[plan.key] ?? null,
          busy: moving === plan.key,
          onMove: () => move(plan.key),
        },
      ])
    );
    for (const [key, result] of Object.entries(results)) {
      if (!moves.has(key)) {
        moves.set(key, {
          plan: { key, kind: 'core-has-rule', text: '', action: null },
          result,
          busy: false,
          onMove: () => {},
        });
      }
    }

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
                      onChange: (event: { target: HTMLSelectElement }) =>
                        setPicked(event.target.value),
                    },
                    ...[...projects]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((candidate) =>
                        h('option', { key: candidate.name, value: candidate.name }, candidate.name)
                      )
                  )
                )
              : null,
            h(
              'h3',
              { id: `${switcherId}-heading`, style: { ...HEADING, marginTop: '8px' } },
              `Editing ${project.name}`
            ),
            h('p', { style: { ...MUTED, wordBreak: 'break-all' } }, project.root),
            h(ProjectFlowSettings, { key: project.name, project, api })
          ),
      h('h3', { style: { ...HEADING, fontSize: '14px', margin: '8px 0 6px' } }, 'This computer'),
      h(FleetTab, { rules, reloadKey, moves })
    );
  }
  return FlowSettingsTab as ComponentType;
}
