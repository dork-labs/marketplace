/**
 * How long to pause (spec `flow-multiproject` §5.3, V4): every pause asks,
 * with three choices, so no pause lasts longer than the person chose. One
 * component, used by the Flow tab's header and by the palette's dialog.
 *
 * The browser works out the end in its own time zone and sends it with its
 * offset, so "tomorrow 9am" is the person's 9am.
 *
 * @module @dorkos/flow/extension/ui/pause-menu
 */

import { h, useEffect, useRef, type Node, type Style } from './react.ts';
import { hostColor } from './styles.ts';

/** One of the menu's choices. */
export type PauseChoice = 'tomorrow' | 'hour' | 'resume';

/** Each choice's words, in the menu's order. */
export const PAUSE_CHOICES: readonly { id: PauseChoice; label: string }[] = [
  { id: 'tomorrow', label: 'Until tomorrow 9am' },
  { id: 'hour', label: 'For 1 hour' },
  { id: 'resume', label: 'Until I resume' },
];

/** Two digits. */
function pad(value: number): string {
  return String(Math.trunc(Math.abs(value))).padStart(2, '0');
}

/**
 * A local time as ISO 8601 with its offset (`2026-09-30T09:00:00+02:00`),
 * which flow's engine needs to read the end in the right zone.
 *
 * @param date - The moment.
 * @returns The text.
 */
export function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/**
 * When a choice ends the pause. "Until tomorrow 9am" is 09:00 on the next
 * calendar day, even when chosen before 09:00: a pause never ends in minutes
 * by surprise.
 *
 * @param choice - The choice.
 * @param now - When it was chosen.
 * @returns The end with its offset, or `null` for "until I resume".
 */
export function pauseUntil(choice: PauseChoice, now: Date): string | null {
  if (choice === 'resume') return null;
  if (choice === 'hour') return isoWithOffset(new Date(now.getTime() + 60 * 60_000));
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return isoWithOffset(next);
}

const MENU: Style = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: '170px',
  padding: '4px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '0.375rem',
  background: hostColor('popover'),
  color: hostColor('popover-foreground'),
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
};

/**
 * One menu item's look.
 *
 * @param highlighted - Whether it is the default.
 * @returns Its style.
 */
function itemStyle(highlighted: boolean): Style {
  return {
    padding: '4px 8px',
    border: 0,
    borderRadius: '0.25rem',
    background: highlighted ? hostColor('muted') : 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '12px',
    fontWeight: highlighted ? 600 : 400,
    textAlign: 'left',
    cursor: 'pointer',
  };
}

/**
 * The menu: three choices, the default first in focus and highlighted.
 * Arrow keys move between them; Escape closes it.
 *
 * @param props - The highlighted default, what to do with a choice, and how to close.
 * @returns The menu.
 */
export function PauseMenu(props: {
  defaultChoice?: PauseChoice;
  label: string;
  onChoose: (until: string | null) => void;
  onClose?: () => void;
  now?: () => Date;
}): Node {
  const chosen = props.defaultChoice ?? 'tomorrow';
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[data-default="true"]')?.focus();
  }, []);
  const move = (event: { key: string; preventDefault(): void }) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose?.();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };
  return h(
    'div',
    { ref, role: 'menu', 'aria-label': props.label, style: MENU, onKeyDown: move },
    ...PAUSE_CHOICES.map(({ id, label }) =>
      h(
        'button',
        {
          key: id,
          type: 'button',
          role: 'menuitem',
          'data-default': id === chosen,
          style: itemStyle(id === chosen),
          onClick: () => props.onChoose(pauseUntil(id, (props.now ?? (() => new Date()))())),
        },
        label
      )
    )
  );
}
