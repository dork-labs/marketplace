/**
 * "Accounts this project may use" (spec `flow-multiproject` §8.4, N6): each
 * Claude account, and whether DorkOS lets it work in this project. DorkOS
 * enforces the rules for every chat, schedule and handoff in the project, and
 * only a person changes them.
 *
 * Read only. On DorkOS client API version 2 the screen runs in a frame that
 * can call only flow's routes, and flow has no route that writes these
 * rules, so the list reads them through `GET /accounts/eligibility` and sends
 * the person to Settings → Runtimes to change them.
 *
 * - An account may work here when both its own rule and the project's list
 *   allow it. No project list means every account.
 * - An account kept to other projects says so ("only for client-app").
 *
 * @module @dorkos/flow/extension/ui/project-accounts
 */

import type { NavigateResult } from '../lib/host-types.ts';
import {
  UNREACHABLE_MESSAGE,
  getEligibility,
  type AccountEligibility,
  type AccountEligibilityRow,
} from './api.ts';
import { h, useEffect, useId, useState, type Node } from './react.ts';
import { BUTTON, LINK, MUTED } from './parts.ts';
import { ALERT } from './styles.ts';

/** Main's id in DorkOS: this computer's own Claude sign-in. */
const MAIN_ID = 'default';

/**
 * Where DorkOS shows each account's own limits, and each project's list. It
 * can limit an account to projects, or remove a project's list, but not yet
 * choose a project's accounts: say only what it can do.
 * TODO(DOR-4549): point at the screen that sets a project's account list once it ships.
 */
export const RUNTIMES_SETTINGS_LINK = '?settings=runtimes';

/** The button that opens it, saying what the person can do there today. */
export const OPEN_RUNTIMES_LABEL = 'Limit an account to projects in Settings → Runtimes';

/** Said under the list: what changes the list, and where. */
export const CHANGE_IN_RUNTIMES_TEXT =
  'Only you can change where an account may work. In Settings → Runtimes you can limit an account to certain projects.';

/** Said when the project keeps its own account list. */
export const PROJECT_LIST_TEXT =
  'This project has its own list of accounts. Settings → Runtimes shows it under Project limits, where you can remove it.';

/** What to call an account. */
export function accountName(row: Pick<AccountEligibilityRow, 'id' | 'label'>): string {
  if (row.label !== null && row.label !== '') return row.label;
  return row.id === MAIN_ID ? 'Main' : row.id;
}

/** The names in a list, joined as a person would say them. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The "· only for …" note of an account kept to other projects. */
export function onlyForText(row: AccountEligibilityRow): string {
  const names = (row.onlyProjects ?? []).map((project) => project.name);
  return names.length === 0 ? 'not used in any project' : `only for ${joinNames(names)}`;
}

/**
 * Whether a row may work here: both rules allow it.
 *
 * @param row - DorkOS's row.
 * @returns True when both rules allow it.
 */
export function mayWorkHere(row: AccountEligibilityRow): boolean {
  return row.allowedByAccount && row.allowedByProject;
}

/**
 * What a row says about this project.
 *
 * @param row - DorkOS's row.
 * @returns The words after the account's name.
 */
export function rowText(row: AccountEligibilityRow): string {
  if (!row.allowedByAccount) return `not here: ${onlyForText(row)}`;
  if (!row.allowedByProject) return "not here: this project's list leaves it out";
  return 'may work here';
}

/**
 * Open a DorkOS page from a click, and say why not when DorkOS refuses.
 *
 * @param navigate - The host's navigate.
 * @param path - The page.
 * @param onRefused - Told DorkOS's sentence when it refuses.
 */
export function openPage(
  navigate: (path: string) => Promise<NavigateResult> | void,
  path: string,
  onRefused: (message: string) => void
): void {
  void Promise.resolve(navigate(path)).then(
    (result) => {
      if (result !== undefined && !result.ok) onRefused(result.message);
    },
    () => onRefused(UNREACHABLE_MESSAGE)
  );
}

/** What {@link ProjectAccounts} takes. */
export interface ProjectAccountsProps {
  /** The project's main checkout. */
  root: string;
  /** Its name. */
  projectName: string;
  /** Go to a DorkOS page. */
  navigate: (path: string) => Promise<NavigateResult> | void;
}

/**
 * The list.
 *
 * @param props - See {@link ProjectAccountsProps}.
 * @returns The list.
 */
export function ProjectAccounts(props: ProjectAccountsProps): Node {
  const [answer, setAnswer] = useState<AccountEligibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const labelId = useId();

  useEffect(() => {
    let live = true;
    setAnswer(null);
    setError(null);
    getEligibility(props.root).then(
      (next) => {
        if (live) setAnswer(next);
      },
      (failure: unknown) => {
        if (live) setError(messageOf(failure));
      }
    );
    return () => {
      live = false;
    };
  }, [props.root, attempt]);

  const heading = h(
    'span',
    { id: labelId, style: { fontWeight: 600 } },
    'Accounts this project may use'
  );
  if (answer === null) {
    return h(
      'div',
      null,
      heading,
      error === null
        ? h('p', { 'aria-busy': true, style: MUTED }, 'Loading…')
        : h('p', { role: 'alert', style: ALERT }, error),
      error === null
        ? null
        : h(
            'button',
            { type: 'button', style: BUTTON, onClick: () => setAttempt((n) => n + 1) },
            'Retry'
          )
    );
  }

  return h(
    'div',
    { role: 'group', 'aria-labelledby': labelId },
    heading,
    h(
      'p',
      { style: { ...MUTED, margin: '2px 0 4px' } },
      `DorkOS keeps every chat, schedule and handoff in ${props.projectName} to the accounts that may work here.`
    ),
    h(
      'ul',
      { style: { listStyle: 'none', margin: 0, padding: 0 } },
      ...answer.accounts.map((row) =>
        h(
          'li',
          {
            key: row.id,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '4px 0',
              minHeight: '28px',
            },
          },
          h('span', {
            'aria-hidden': true,
            style: {
              flex: 'none',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: row.color,
              opacity: mayWorkHere(row) ? 1 : 0.4,
            },
          }),
          h(
            'span',
            { style: { minWidth: 0 } },
            accountName(row),
            row.id === MAIN_ID && row.implicit
              ? h('span', { style: MUTED }, " (this computer's sign-in)")
              : null,
            h('span', { style: MUTED }, ` · ${rowText(row)}`)
          )
        )
      )
    ),
    answer.allow === null
      ? null
      : h('p', { style: { ...MUTED, marginTop: '4px' } }, PROJECT_LIST_TEXT),
    h(
      'p',
      { style: { ...MUTED, marginTop: '4px' } },
      `${CHANGE_IN_RUNTIMES_TEXT} `,
      h(
        'button',
        {
          type: 'button',
          style: { ...LINK, fontSize: 'inherit' },
          onClick: () => openPage(props.navigate, RUNTIMES_SETTINGS_LINK, setError),
        },
        OPEN_RUNTIMES_LABEL
      )
    ),
    error === null ? null : h('p', { role: 'alert', style: ALERT }, error)
  );
}

/** The words for a failed read: flow's own, or that it did not answer. */
function messageOf(failure: unknown): string {
  return failure instanceof Error && failure.message !== '' ? failure.message : UNREACHABLE_MESSAGE;
}
