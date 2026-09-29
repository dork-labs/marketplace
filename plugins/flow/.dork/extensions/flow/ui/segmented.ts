/**
 * A segmented control built as a real radio group (spec `claude-account-ui`
 * §10): `role="radiogroup"` of `role="radio"` buttons with `aria-checked`,
 * one tab stop (roving tabindex), and arrow keys that move and choose.
 *
 * @module @dorkos/flow/extension/ui/segmented
 */

import { h, useRef, type KeyEvent, type Node } from './react.ts';
import { SEGMENTED, segment } from './styles.ts';

/** One choice. */
export interface SegmentOption<T extends string> {
  /** The value it stands for. */
  value: T;
  /** Its words. */
  label: string;
}

/** What {@link SegmentedControl} takes. */
export interface SegmentedControlProps<T extends string> {
  /** The choices, in order. */
  options: readonly SegmentOption<T>[];
  /** The chosen value. */
  value: T;
  /** Called with a newly chosen value (never the current one). */
  onChange: (value: T) => void;
  /** The group's accessible name. */
  label?: string;
  /** The id of the element that names the group, in place of `label`. */
  labelledBy?: string;
  /** The id of an element that says more about the group. */
  describedBy?: string;
  /** Shown but not changeable. */
  disabled?: boolean;
  /** Let the choices wrap onto more lines on a narrow screen (long labels). */
  wrap?: boolean;
}

/** The index a key moves to from `index` among `count` choices, or `null` for other keys. */
function nextIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * A segmented control. Left/Up choose the previous option and Right/Down the
 * next, wrapping; Home and End choose the first and last.
 *
 * @param props - See {@link SegmentedControlProps}.
 * @returns The radio group.
 */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>): Node {
  const { options, value } = props;
  const group = useRef<HTMLDivElement>(null);
  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );

  const choose = (index: number, focus: boolean): void => {
    if (props.disabled === true) return;
    const option = options[index];
    if (focus) {
      group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
    }
    if (option.value !== value) props.onChange(option.value);
  };

  return h(
    'div',
    {
      ref: group,
      role: 'radiogroup',
      'aria-label': props.label,
      'aria-labelledby': props.labelledBy,
      'aria-describedby': props.describedBy,
      'aria-disabled': props.disabled === true || undefined,
      style: {
        ...SEGMENTED,
        ...(props.wrap === true ? { height: 'auto', flexWrap: 'wrap', maxWidth: '100%' } : {}),
        ...(props.disabled === true ? { opacity: 0.6 } : {}),
      },
    },
    ...options.map((option, index) =>
      h(
        'button',
        {
          key: option.value,
          type: 'button',
          role: 'radio',
          'aria-checked': option.value === value,
          tabIndex: index === selected ? 0 : -1,
          style: {
            ...segment(option.value === value, index === options.length - 1),
            ...(props.wrap === true ? { minHeight: '28px' } : {}),
            ...(props.disabled === true ? { cursor: 'not-allowed' } : {}),
          },
          onClick: () => choose(index, false),
          onKeyDown: (event: KeyEvent) => {
            const next = nextIndex(event.key, index, options.length);
            if (next === null) return;
            event.preventDefault();
            choose(next, true);
          },
        },
        option.label
      )
    )
  );
}
