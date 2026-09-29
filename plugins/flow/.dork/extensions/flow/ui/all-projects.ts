/**
 * The all-projects lens (spec `flow-multiproject` §3.3, V3): what the Flow tab
 * shows beside a chat that is in no flow project. It is not a copy of Flow
 * home: only the projects that need something, most urgent first, one line
 * each, and how many are fine.
 *
 * @module @dorkos/flow/extension/ui/all-projects
 */

import type { FlowModel, FlowProject } from '../lib/model.ts';
import type { ClientApi, ProjectRef } from '../lib/host-types.ts';
import { HOME_PATH, projectPath } from './links.ts';
import { pausedText } from './panel-format.ts';
import { CONDITION, GROW, LINK, MUTED, ROW } from './parts.ts';
import { MARKETPLACE_ROUTE, conditionLine } from './project-lens.ts';
import { h, type Node } from './react.ts';

/** Shown when no project on this computer has flow. */
export const NO_PROJECTS_TEXT = "Flow isn't set up in any project yet.";

/** The link to Flow home at the bottom of the lens. */
export const OPEN_HOME_TEXT = 'Open Flow home →';

/** The quiet offer for a repo without flow (§3.3). */
export const SET_UP_HERE_TEXT = 'This folder is a repo.';

/** One project's line, and how urgent it is (lower is more urgent). */
export interface ProjectLine {
  /** The project. */
  project: FlowProject;
  /** What it needs, in words. */
  text: string;
  /** Its order: decisions, then problems only a person can fix, then the rest. */
  rank: number;
}

/**
 * The line a project gets in the all-projects lens, or `null` when it is fine.
 * A project with a decision says how many need you; otherwise its most urgent
 * condition speaks, in the lens's own words.
 *
 * @param project - The project.
 * @param model - The model, for its decisions.
 * @param now - The moment to read times from.
 * @param locale - The locale for times (default: the browser's).
 * @returns The line, or `null`.
 */
export function projectLine(
  project: FlowProject,
  model: FlowModel,
  now: Date,
  locale?: string
): ProjectLine | null {
  const decisions = model.decisions.filter((decision) => decision.project === project.name);
  if (decisions.length > 0) {
    return {
      project,
      text: `${decisions.length} need${decisions.length === 1 ? 's' : ''} you`,
      rank: 0,
    };
  }
  const tracker = project.tracker?.label ?? 'the tracker';
  if (project.restoreSchedules.length > 0) {
    // Only a DorkOS page can switch them back on; say so rather than look fine.
    return { project, text: 'Schedules stay off until DorkOS is open', rank: 1.5 };
  }
  const order: Record<string, number> = {
    'sign-in': 1,
    'settings-problem': 2,
    'tracker-unreachable': 3,
    'nothing-ready': 4,
    paused: 5,
  };
  const worst = [...project.conditions].sort((a, b) => order[a.kind] - order[b.kind])[0];
  if (worst === undefined) {
    return project.setup === 'not-set-up'
      ? { project, text: "Flow isn't set up here yet", rank: 6 }
      : null;
  }
  if (worst.kind === 'paused') {
    return project.pause === null
      ? null
      : { project, text: pausedText(project.pause, now, locale), rank: order.paused };
  }
  if (worst.kind === 'sign-in') {
    return { project, text: `Sign in to ${tracker} again`, rank: order['sign-in'] };
  }
  const line = conditionLine(worst, project, locale);
  return line === null ? null : { project, text: line.text, rank: order[worst.kind] };
}

/**
 * The all-projects lens.
 *
 * On a DorkOS with flow's pages, each line opens its project's page and the
 * lens ends with a link to Flow home.
 *
 * @param props - The model, the chat's project (when DorkOS knows it), the
 *   host API, and whether flow's pages exist.
 * @returns The lens.
 */
export function AllProjects(props: {
  model: FlowModel;
  currentProject: ProjectRef | null | undefined;
  api: Pick<ClientApi, 'navigate'>;
  pages?: boolean;
}): Node {
  const { model, currentProject, api } = props;
  const pages = props.pages === true;
  const now = new Date();
  const body: Node[] = [h('b', { key: 'title', style: { fontSize: '13px' } }, 'All projects')];
  if (model.projects.length === 0) {
    body.push(h('p', { key: 'none', style: { ...MUTED, marginTop: '8px' } }, NO_PROJECTS_TEXT));
  }
  const lines = model.projects
    .map((project) => projectLine(project, model, now))
    .filter((line): line is ProjectLine => line !== null)
    .sort((a, b) => a.rank - b.rank || a.project.name.localeCompare(b.project.name));
  for (const line of lines) {
    const words = h(
      'span',
      { style: GROW },
      h('b', null, line.project.name),
      h('span', { style: MUTED }, ` · ${line.text}`)
    );
    body.push(
      pages
        ? h(
            'button',
            {
              key: line.project.root,
              type: 'button',
              'data-row': 'project',
              style: { ...ROW, marginTop: '4px', cursor: 'pointer' },
              onClick: () => api.navigate(projectPath(line.project.name)),
            },
            words
          )
        : h('div', { key: line.project.root, style: { ...ROW, marginTop: '4px' } }, words)
    );
  }
  const fine = model.projects.length - lines.length;
  if (fine > 0 && lines.length > 0) {
    body.push(
      h(
        'p',
        { key: 'fine', style: { ...MUTED, marginTop: '6px' } },
        `${fine} other project${fine === 1 ? ' is' : 's are'} fine`
      )
    );
  } else if (fine > 0) {
    body.push(
      h(
        'p',
        { key: 'fine', style: { ...MUTED, marginTop: '8px' } },
        fine === 1 ? 'Your flow project is fine.' : `All ${fine} flow projects are fine.`
      )
    );
  }
  const hasFlow =
    currentProject !== null &&
    currentProject !== undefined &&
    model.projects.some((project) => project.root === currentProject.root);
  if (currentProject !== null && currentProject !== undefined && !hasFlow) {
    body.push(
      h(
        'p',
        { key: 'setup', style: { ...CONDITION, background: 'transparent' } },
        `${SET_UP_HERE_TEXT} `,
        h(
          'button',
          { type: 'button', style: LINK, onClick: () => api.navigate(MARKETPLACE_ROUTE) },
          'Set up flow here'
        )
      )
    );
  }
  if (pages && model.projects.length > 0) {
    body.push(
      h(
        'p',
        { key: 'home', style: { margin: '10px 0 0' } },
        h(
          'button',
          { type: 'button', style: LINK, onClick: () => api.navigate(HOME_PATH) },
          OPEN_HOME_TEXT
        )
      )
    );
  }
  return h('div', null, ...body);
}
