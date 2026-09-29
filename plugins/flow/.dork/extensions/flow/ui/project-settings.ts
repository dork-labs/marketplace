/**
 * A project's Flow settings page (spec `flow-multiproject` §8.1), reached from
 * ⚙ in the project's lens. This version is the page's frame only: it says
 * honestly that the project's settings can't be changed here yet, where they
 * live and who a change there reaches, and links to the settings DorkOS
 * already has (this computer's accounts, in Settings → Flow).
 *
 * @module @dorkos/flow/extension/ui/project-settings
 */

import type { FlowProject } from '../lib/model.ts';
import type { ClientApi } from '../lib/host-types.ts';
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  PROJECT_CONFIG_DIR,
} from '../../../../scripts/config-names.ts';
import { SETTINGS_TAB_LINK, projectPath } from './links.ts';
import { BAND, BAND_ROW, TITLE } from './page-parts.ts';
import { LINK, MUTED, PILL } from './parts.ts';
import { h, type Node, type Style } from './react.ts';

/** The line that says what this page can't do yet. */
export const NOT_HERE_YET_TEXT = "You can't change this project's flow settings here yet.";

/** Where the shared settings live, relative to the project. */
export const SHARED_FILE = `${PROJECT_CONFIG_DIR}/${CONFIG_FILE}`;

/** Where this computer's settings for the project live, relative to the project. */
export const LOCAL_FILE = `${PROJECT_CONFIG_DIR}/${LOCAL_CONFIG_FILE}`;

const MONO: Style = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '12px',
  wordBreak: 'break-all',
};

/**
 * One of the two files, with who a change there reaches.
 *
 * @param props - Its heading, who it affects, its path, and what it holds.
 * @returns The row.
 */
function FileRow(props: { heading: string; who: string; file: string; holds: string }): Node {
  return h(
    'div',
    { style: BAND_ROW },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      h('b', null, props.heading),
      h('span', { style: PILL }, props.who)
    ),
    h('p', { style: { ...MUTED, fontSize: '12px', margin: '2px 0' } }, props.holds),
    h('code', { style: MONO }, props.file)
  );
}

/**
 * The page.
 *
 * @param props - The project and the host API.
 * @returns The page's content.
 */
export function ProjectSettings(props: {
  project: FlowProject;
  api: Pick<ClientApi, 'navigate'>;
}): Node {
  const { project, api } = props;
  return h(
    'div',
    null,
    h(
      'button',
      { type: 'button', style: LINK, onClick: () => api.navigate(projectPath(project.name)) },
      `← ${project.name}`
    ),
    h('h1', { style: { ...TITLE, marginTop: '8px' } }, `${project.name} · Flow settings`),
    h('p', { style: { ...MUTED, ...MONO } }, project.root),
    h('p', { style: { margin: '14px 0 0' } }, NOT_HERE_YET_TEXT),
    h(
      'p',
      { style: { ...MUTED, fontSize: '12px' } },
      'They live in two files in the project. A change to the first reaches everyone who works on the repo once it is committed; the second stays on this computer.'
    ),
    h('h2', { style: BAND }, 'Where they live'),
    h(FileRow, {
      heading: 'Shared with the repo',
      who: 'everyone on this repo',
      file: SHARED_FILE,
      holds: 'The tracker, reviews, merging, labels.',
    }),
    h(FileRow, {
      heading: 'Just me',
      who: 'only this computer',
      file: LOCAL_FILE,
      holds: 'Sign-ins, and anything you set only for yourself.',
    }),
    h('h2', { style: BAND }, 'This computer'),
    h(
      'p',
      { style: { margin: 0 } },
      'Which accounts flow may use, and what happens when one runs out, are in ',
      h(
        'button',
        {
          type: 'button',
          style: { ...LINK, fontSize: 'inherit' },
          onClick: () => api.navigate(SETTINGS_TAB_LINK),
        },
        'Settings → Flow'
      ),
      '.'
    )
  );
}
