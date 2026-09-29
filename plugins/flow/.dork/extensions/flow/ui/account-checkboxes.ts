/**
 * "Accounts this project may use" (spec `flow-multiproject` §8.4, N6): one
 * checkbox per Claude account, read and written as the person, straight from
 * the browser, through DorkOS's own routes. DorkOS enforces the list for every
 * chat, schedule and handoff in the project, and flow's server half has no way
 * to change it.
 *
 * - Checked means the account may work here: both the project's list and the
 *   account's own rule allow it. No project list means every account.
 * - An account kept to other projects says so ("· only for client-app") and is
 *   unchecked; checking it asks first, then adds this project to the
 *   account's own list before allowing it here.
 * - Unchecking the last account asks first: with none allowed, every chat in
 *   the project is refused.
 * - Every change redraws from DorkOS's answer. A refusal (a 403 when DorkOS
 *   can't tell a person made the change, or any other) shows DorkOS's words
 *   and is not retried.
 *
 * On a DorkOS without the eligibility routes, nothing is drawn (§10).
 *
 * @module @dorkos/flow/extension/ui/account-checkboxes
 */

import {
  CORE_UNREACHABLE_MESSAGE,
  getEligibility,
  hasEligibilityRoutes,
  putOnlyProjects,
  putProjectAccounts,
  type AccountEligibility,
  type AccountEligibilityRow,
} from './core-api.ts';
import { h, useEffect, useId, useState, type Node } from './react.ts';
import { BUTTON, LINK, MUTED } from './parts.ts';
import { ALERT } from './styles.ts';

/** Main's id in DorkOS: this computer's own Claude sign-in. */
const MAIN_ID = 'default';

/** Where DorkOS shows each account's own rule. */
export const RUNTIMES_SETTINGS_LINK = '?settings=runtimes';

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
 * Whether a row is checked: it may work here.
 *
 * @param row - DorkOS's row.
 * @returns True when both rules allow it.
 */
export function isChecked(row: AccountEligibilityRow): boolean {
  return row.allowedByAccount && row.allowedByProject;
}

/**
 * The project's allow list after one account is checked or unchecked, or
 * `null` when every account ends up allowed (DorkOS then keeps no list).
 *
 * @param answer - DorkOS's answer now.
 * @param id - The account.
 * @param on - Checked or not.
 * @returns The list to send.
 */
export function nextAllow(answer: AccountEligibility, id: string, on: boolean): string[] | null {
  const all = answer.accounts.map((row) => row.id);
  const current = answer.allow ?? all;
  const next = on
    ? [...current.filter((entry) => entry !== id), id]
    : current.filter((entry) => entry !== id);
  return all.every((entry) => next.includes(entry)) ? null : all.filter((entry) => next.includes(entry));
}

/** A question asked before a change, with what Yes does. */
interface Confirm {
  /** The question. */
  text: string;
  /** Its Yes button's words. */
  yes: string;
  /** What Yes does. */
  run: () => Promise<void>;
}

/** What {@link AccountCheckboxes} takes. */
export interface AccountCheckboxesProps {
  /** The project's main checkout. */
  root: string;
  /** Its name. */
  projectName: string;
  /** Go to a DorkOS page. */
  navigate: (path: string) => void;
  /** Whether a person may change anything here. */
  canChange?: boolean;
}

/**
 * The checkboxes.
 *
 * @param props - See {@link AccountCheckboxesProps}.
 * @returns The list, or nothing on a DorkOS without account rules.
 */
export function AccountCheckboxes(props: AccountCheckboxesProps): Node {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [answer, setAnswer] = useState<AccountEligibility | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const labelId = useId();

  useEffect(() => {
    let live = true;
    setAnswer(null);
    setError(null);
    setConfirm(null);
    hasEligibilityRoutes().then((has) => {
      if (!live) return;
      setSupported(has);
      if (!has) return;
      getEligibility(props.root).then(
        (next) => {
          if (live) setAnswer(next);
        },
        (failure: unknown) => {
          if (live) setError(messageOf(failure));
        }
      );
    });
    return () => {
      live = false;
    };
  }, [props.root]);

  if (supported === false) return null;
  if (answer === null) {
    return h(
      'div',
      null,
      h('span', { id: labelId, style: { fontWeight: 600 } }, 'Accounts this project may use'),
      error === null
        ? h('p', { 'aria-busy': true, style: MUTED }, 'Loading…')
        : h('p', { role: 'alert', style: ALERT }, error)
    );
  }

  const act = (change: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setConfirm(null);
    change()
      .catch(async (failure: unknown) => {
        setError(messageOf(failure));
        // Redraw from what DorkOS holds now, whatever part of the change landed.
        const now = await getEligibility(props.root).catch(() => null);
        if (now !== null) setAnswer(now);
      })
      .finally(() => setBusy(false));
  };

  const allow = (id: string, on: boolean) => async () => {
    setAnswer(await putProjectAccounts(props.root, nextAllow(answer, id, on)));
  };

  const toggle = (row: AccountEligibilityRow) => {
    if (busy || props.canChange === false) return;
    const name = accountName(row);
    if (!isChecked(row)) {
      if (!row.allowedByAccount) {
        setConfirm({
          text: `${name} is ${onlyForText(row)}. Let ${props.projectName} use it too?`,
          yes: `Let ${props.projectName} use it`,
          run: async () => {
            const roots = (row.onlyProjects ?? []).map((project) => project.root);
            await putOnlyProjects(row.id, [...roots, props.root]);
            const widened = await getEligibility(props.root);
            const mine = widened.accounts.find((entry) => entry.id === row.id);
            setAnswer(
              mine !== undefined && !mine.allowedByProject
                ? await putProjectAccounts(props.root, nextAllow(widened, row.id, true))
                : widened
            );
          },
        });
        return;
      }
      act(allow(row.id, true));
      return;
    }
    const left = answer.accounts.filter((entry) => entry.id !== row.id && isChecked(entry));
    if (left.length === 0) {
      setConfirm({
        text: `With no accounts allowed, every chat in ${props.projectName} will be refused, including yours. Continue?`,
        yes: 'Allow no accounts',
        run: allow(row.id, false),
      });
      return;
    }
    act(allow(row.id, false));
  };

  return h(
    'div',
    { role: 'group', 'aria-labelledby': labelId, 'aria-busy': busy || undefined },
    h('span', { id: labelId, style: { fontWeight: 600 } }, 'Accounts this project may use'),
    h(
      'p',
      { style: { ...MUTED, margin: '2px 0 4px' } },
      'DorkOS keeps every chat, schedule and handoff in this project to these accounts.'
    ),
    ...answer.accounts.map((row) =>
      h(
        'label',
        {
          key: row.id,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 0',
            minHeight: '28px',
            cursor: props.canChange === false ? 'default' : 'pointer',
          },
        },
        h('input', {
          type: 'checkbox',
          checked: isChecked(row),
          disabled: busy || props.canChange === false,
          onChange: () => toggle(row),
        }),
        h('span', {
          'aria-hidden': true,
          style: {
            flex: 'none',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: row.color,
          },
        }),
        h(
          'span',
          { style: { minWidth: 0 } },
          accountName(row),
          row.id === MAIN_ID && row.implicit
            ? h('span', { style: MUTED }, " (this computer's sign-in)")
            : null,
          row.allowedByAccount ? null : h('span', { style: MUTED }, ` · ${onlyForText(row)}`)
        )
      )
    ),
    confirm === null
      ? null
      : h(
          'div',
          {
            role: 'alertdialog',
            'aria-label': 'Confirm',
            style: { margin: '6px 0 0', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
          },
          h('p', { style: { margin: 0, flexBasis: '100%', fontSize: '12px' } }, confirm.text),
          h(
            'button',
            { type: 'button', style: BUTTON, autoFocus: true, onClick: () => act(confirm.run) },
            confirm.yes
          ),
          h('button', { type: 'button', style: BUTTON, onClick: () => setConfirm(null) }, 'Cancel')
        ),
    error === null ? null : h('p', { role: 'alert', style: ALERT }, error),
    h(
      'p',
      { style: { ...MUTED, marginTop: '4px' } },
      'Which projects each account may work in is in ',
      h(
        'button',
        {
          type: 'button',
          style: { ...LINK, fontSize: 'inherit' },
          onClick: () => props.navigate(RUNTIMES_SETTINGS_LINK),
        },
        'Settings → Runtimes'
      ),
      '.'
    )
  );
}

/** The words for a failed call: DorkOS's own, or that it did not answer. */
function messageOf(failure: unknown): string {
  return failure instanceof Error && failure.message !== '' ? failure.message : CORE_UNREACHABLE_MESSAGE;
}
