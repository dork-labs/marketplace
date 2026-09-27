/**
 * The repos a kept-out account may serve, as chips (spec `claude-account-ui`
 * §8.3 item 4, Q9): one chip per `owner/name` with a remove button, and an
 * "+ add" chip that turns into a small text field.
 *
 * @module @dorkos/flow/extension/ui/repo-chips
 */

import { h, useId, useState, type KeyEvent, type Node } from './react.ts';
import { ALERT, CHIP, CHIP_REMOVE, FIELD } from './styles.ts';

/** A repo a kept-out account may serve: `owner/name` (flow's own rule, `lib/fleet.ts`). */
export const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Shown under the field when what was typed is not `owner/name`. */
export const REPO_INVALID_TEXT = 'Use owner/name, like acme/app.';

/** What {@link RepoAddChip} takes. */
export interface RepoAddChipProps {
  /** Called with a valid `owner/name`. */
  onAdd: (repo: string) => void;
  /** The id of the element that names the field. */
  labelledBy?: string;
}

/**
 * The "+ add" chip. Clicking it opens a text field (placeholder `owner/name`):
 * Enter adds a valid repo, Escape cancels, and anything else shows
 * "Use owner/name, like acme/app."
 *
 * @param props - See {@link RepoAddChipProps}.
 * @returns The chip or its field.
 */
export function RepoAddChip(props: RepoAddChipProps): Node {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();

  const close = (): void => {
    setEditing(false);
    setDraft('');
    setInvalid(false);
  };

  if (!editing) {
    return h(
      'button',
      { type: 'button', style: { ...CHIP, cursor: 'pointer' }, onClick: () => setEditing(true) },
      '+ add'
    );
  }

  return h(
    'span',
    { style: { display: 'inline-flex', flexDirection: 'column' } },
    h('input', {
      type: 'text',
      autoFocus: true,
      placeholder: 'owner/name',
      value: draft,
      'aria-labelledby': props.labelledBy,
      'aria-invalid': invalid || undefined,
      'aria-describedby': invalid ? errorId : undefined,
      style: { ...FIELD, height: '24px', width: '11rem' },
      onChange: (event: { target: HTMLInputElement }) => {
        setDraft(event.target.value);
        setInvalid(false);
      },
      onKeyDown: (event: KeyEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const repo = draft.trim();
        if (!REPO_PATTERN.test(repo)) {
          setInvalid(true);
          return;
        }
        close();
        props.onAdd(repo);
      },
      onBlur: () => {
        if (draft.trim() === '') close();
      },
    }),
    invalid ? h('span', { id: errorId, role: 'alert', style: ALERT }, REPO_INVALID_TEXT) : null
  );
}

/** What {@link RepoChips} takes. */
export interface RepoChipsProps {
  /** The repos, in order. */
  repos: readonly string[];
  /** Called with the new list after a remove or an add. */
  onChange: (repos: string[]) => void;
  /** The id of the element that names the list. */
  labelledBy?: string;
}

/**
 * The chips, then "+ add".
 *
 * @param props - See {@link RepoChipsProps}.
 * @returns The chips.
 */
export function RepoChips(props: RepoChipsProps): Node {
  const { repos } = props;
  return h(
    'span',
    { style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '6px' } },
    ...repos.map((repo) =>
      h(
        'span',
        { key: repo, style: CHIP },
        repo,
        h(
          'button',
          {
            type: 'button',
            'aria-label': `Remove ${repo}`,
            style: CHIP_REMOVE,
            onClick: () => props.onChange(repos.filter((entry) => entry !== repo)),
          },
          h('span', { 'aria-hidden': true }, '✕')
        )
      )
    ),
    h(RepoAddChip, {
      key: '+add',
      labelledBy: props.labelledBy,
      onAdd: (repo: string) => {
        if (!repos.includes(repo)) props.onChange([...repos, repo]);
      },
    })
  );
}
