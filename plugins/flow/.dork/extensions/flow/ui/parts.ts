/**
 * Small pieces the Flow tab's two lenses share: the look of a caption, a row,
 * a state pill and an account dot, a quiet link-style button, and the ⓘ that
 * shows how to do by hand what this DorkOS cannot yet do from a button.
 *
 * @module @dorkos/flow/extension/ui/parts
 */

import { h, useId, useState, type Node, type Style } from './react.ts';
import { hostColor } from './styles.ts';

/** The panel's root. */
export const PANEL: Style = {
  position: 'relative',
  padding: '10px 12px',
  color: hostColor('foreground'),
  fontSize: '12px',
  lineHeight: 1.5,
};

/** A section caption ("Running · 2 of 3"). */
export const CAPTION: Style = {
  margin: '10px 0 3px',
  color: hostColor('muted-foreground'),
  fontSize: '10px',
  fontWeight: 400,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

/** A muted line. */
export const MUTED: Style = { margin: 0, color: hostColor('muted-foreground'), fontSize: '11px' };

/** A row: dot, name, pill. */
export const ROW: Style = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  margin: 0,
  padding: '4px 0',
  border: 0,
  borderBottom: `1px solid ${hostColor('muted')}`,
  borderRadius: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
};

/** The part of a row that takes the free width. */
export const GROW: Style = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** A condition's muted box. */
export const CONDITION: Style = {
  margin: '8px 0 0',
  padding: '6px 8px',
  borderRadius: '8px',
  border: `1px solid ${hostColor('muted')}`,
  background: hostColor('muted', 0.4),
  color: hostColor('foreground'),
  fontSize: '11px',
};

/** A small outlined button ("Pause", "Resume"). */
export const BUTTON: Style = {
  display: 'inline-block',
  flex: 'none',
  padding: '1px 8px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '6px',
  background: hostColor('background'),
  color: hostColor('foreground'),
  fontSize: '11px',
  fontFamily: 'inherit',
  cursor: 'pointer',
};

/** A button that reads as a link. */
export const LINK: Style = {
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: '11px',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
};

/** A state pill: neutral, whatever the state. */
export const PILL: Style = {
  flex: 'none',
  padding: '0 6px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '9999px',
  color: hostColor('foreground'),
  fontSize: '10px',
  whiteSpace: 'nowrap',
};

/** Focus rings and hover for the tab's own controls, which inline styles cannot express. */
export const FOCUS_CSS = `
.flow-tab button:focus-visible,
.flow-tab [role='menu']:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
}
.flow-tab button[data-row]:hover { background: hsl(var(--muted) / 0.5); }
`;

/**
 * An account's color dot, hidden from screen readers (the row names the item).
 *
 * @param props - The color.
 * @returns The dot.
 */
export function Dot(props: { color: string }): Node {
  return h('span', {
    'aria-hidden': true,
    style: {
      flex: 'none',
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: props.color,
    },
  });
}

/**
 * The ⓘ beside words a button would carry on a newer DorkOS: pressed, it
 * shows how to do the same by hand. It is the only place a command appears.
 *
 * @param props - What to show.
 * @returns The ⓘ and, while open, its text.
 */
export function Hint(props: { text: string }): Node {
  const [open, setOpen] = useState(false);
  const id = useId();
  return h(
    'span',
    null,
    ' ',
    h(
      'button',
      {
        type: 'button',
        'aria-label': 'How to do this',
        'aria-expanded': open,
        'aria-controls': id,
        style: { ...LINK, textDecoration: 'none' },
        onClick: () => setOpen((value: boolean) => !value),
      },
      'ⓘ'
    ),
    open ? h('span', { id, style: { display: 'block', ...MUTED } }, props.text) : null
  );
}
