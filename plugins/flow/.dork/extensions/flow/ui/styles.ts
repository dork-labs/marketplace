/**
 * The Flow tab's look, drawn from the host's theme variables so it follows
 * DorkOS's light and dark themes. The host's colors are HSL channel triples
 * (`--muted: 0 0% 96%`), so each is read as `hsl(var(--name))`.
 *
 * An extension cannot import the host's components, so where the tab stands in
 * for one (the notice, the settings group caption) the values below are those
 * components' Tailwind classes resolved against the DorkOS client's theme.
 *
 * @module @dorkos/flow/extension/ui/styles
 */

import type { Style } from './react.ts';

/**
 * A host color variable as a CSS color.
 *
 * @param name - The variable's name without `--`, such as `muted`.
 * @param alpha - An optional alpha, 0-1.
 * @returns The CSS color.
 */
export function hostColor(name: string, alpha?: number): string {
  return alpha === undefined ? `hsl(var(--${name}))` : `hsl(var(--${name}) / ${alpha})`;
}

/** The host's `rounded-md` (Tailwind's 0.375rem; the DorkOS client does not override it). */
const RADIUS_MD = '0.375rem';

/** The host's `text-sm`: DorkOS scales `--text-sm`; 0.875rem when it is absent. */
const TEXT_SM = 'var(--text-sm, 0.875rem)';

/** The host's `text-xs`. */
const TEXT_XS = 'var(--text-xs, 0.75rem)';

/**
 * The host `Notice`'s info tone (`@dork-labs/ui` `notice.tsx`):
 * `rounded-md border px-3 py-2 text-sm border-dui-border bg-dui-muted text-dui-foreground`.
 */
export const NOTICE: Style = {
  borderRadius: RADIUS_MD,
  border: `1px solid ${hostColor('border')}`,
  background: hostColor('muted'),
  color: hostColor('foreground'),
  padding: '0.5rem 0.75rem',
  fontSize: TEXT_SM,
  lineHeight: 'calc(1.25 / 0.875)',
};

/**
 * A settings group caption, as DorkOS's Runtimes sections draw theirs:
 * `text-muted-foreground text-xs font-semibold tracking-wide uppercase`.
 */
export const GROUP_CAPTION: Style = {
  margin: '1rem 0 0.25rem',
  color: hostColor('muted-foreground'),
  fontSize: TEXT_XS,
  lineHeight: 'calc(1 / 0.75)',
  fontWeight: 600,
  letterSpacing: '0.025em',
  textTransform: 'uppercase',
};

/** The tab's root. */
export const ROOT: Style = { color: hostColor('foreground'), fontSize: '13px', lineHeight: 1.45 };

/** The tab's heading. */
export const HEADING: Style = { margin: '0 0 2px', fontSize: '13px', fontWeight: 600 };

/** A muted line. */
export const MUTED: Style = { margin: 0, color: hostColor('muted-foreground'), fontSize: '12px' };

/** One row: an account, or a fleet-wide setting (the mockup's `.ax-rowx`). */
export const ROW: Style = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '9px 0',
  // The mockup's row rule (#f4f4f5) is the host's --muted.
  borderBottom: `1px solid ${hostColor('muted')}`,
};

/** A row's label, which takes the free width. */
export const ROW_LABEL: Style = { flex: 1, minWidth: 0, fontWeight: 600 };

/** An account's color dot. */
export const DOT: Style = { flex: 'none', width: '10px', height: '10px', borderRadius: '50%' };

/**
 * The inset panel under a Main or Kept out row (the mockup's `.ax-sub`: #fafafa
 * on a #f4f4f5 rule, the host's --background and --muted).
 */
export const INSET: Style = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '6px',
  margin: '0 0 8px 20px',
  padding: '8px 10px',
  borderRadius: 'var(--radius, 0.5rem)',
  border: `1px solid ${hostColor('muted')}`,
  background: hostColor('background'),
  fontSize: '12px',
};

/** The segmented control's frame. */
export const SEGMENTED: Style = {
  display: 'inline-flex',
  flex: 'none',
  height: '28px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: RADIUS_MD,
  overflow: 'hidden',
};

/**
 * One segment.
 *
 * @param selected - Whether it is the chosen one.
 * @param last - Whether it is the last one (no divider after it).
 * @returns Its style.
 */
export function segment(selected: boolean, last: boolean): Style {
  return {
    height: '100%',
    padding: '0 10px',
    border: 0,
    borderRight: last ? 0 : `1px solid ${hostColor('border')}`,
    background: selected ? hostColor('foreground') : 'transparent',
    color: selected ? hostColor('background') : hostColor('foreground'),
    fontSize: '12px',
    fontFamily: 'inherit',
    cursor: 'pointer',
  };
}

/** A native select or small text field. */
export const FIELD: Style = {
  height: '28px',
  padding: '0 8px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: RADIUS_MD,
  background: hostColor('background'),
  color: hostColor('foreground'),
  fontSize: '12px',
  fontFamily: 'inherit',
};

/** A repo chip. */
export const CHIP: Style = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  height: '24px',
  padding: '0 8px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: RADIUS_MD,
  background: hostColor('background'),
  color: hostColor('foreground'),
  fontSize: '12px',
  fontFamily: 'inherit',
};

/** The remove button inside a chip. */
export const CHIP_REMOVE: Style = {
  display: 'inline-flex',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: hostColor('muted-foreground'),
  cursor: 'pointer',
  fontSize: '12px',
  lineHeight: 1,
};

/** The reserve slider. */
export const RANGE_CLASS = 'flow-fleet-range';

/**
 * The reserve slider's inline style: `--flow-fill` is how far the host-colored
 * part of the track reaches.
 *
 * @param pct - The value, 0-100.
 * @returns Its style.
 */
export function rangeStyle(pct: number): Style {
  return { ['--flow-fill' as string]: `${pct}%` } as Style;
}

/** An error line under the control that failed. */
export const ALERT: Style = {
  margin: '4px 0 0',
  color: hostColor('destructive'),
  fontSize: '12px',
};

/**
 * Focus rings for the tab's own controls. Inline styles cannot express
 * `:focus-visible`, so the tab renders this once, scoped by its class names.
 */
export const FOCUS_CSS = `
.flow-fleet-tab button:focus-visible,
.flow-fleet-tab select:focus-visible,
.flow-fleet-tab input:not([type='range']):focus-visible,
.flow-fleet-tab a:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
}
.flow-fleet-tab [role='radio']:focus-visible { outline-offset: -2px; }
/* The host Slider (@dork-labs/ui slider.tsx): a 6px --muted track, filled
   with --primary; a 16px white thumb with a --primary border and shadow-sm,
   and a 4px --ring/50 ring on hover and focus. */
.flow-fleet-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100px;
  height: 16px;
  margin: 0;
  background: transparent;
  vertical-align: middle;
  touch-action: none;
}
.flow-fleet-range:focus-visible { outline: none; }
.flow-fleet-range::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 9999px;
  background: linear-gradient(to right, hsl(var(--primary)) var(--flow-fill), hsl(var(--muted)) var(--flow-fill));
}
.flow-fleet-range::-moz-range-track {
  height: 6px;
  border-radius: 9999px;
  background: hsl(var(--muted));
}
.flow-fleet-range::-moz-range-progress {
  height: 6px;
  border-radius: 9999px 0 0 9999px;
  background: hsl(var(--primary));
}
.flow-fleet-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  margin-top: -5px;
  border: 1px solid hsl(var(--primary));
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  transition: box-shadow 150ms;
}
.flow-fleet-range::-moz-range-thumb {
  box-sizing: border-box;
  width: 16px;
  height: 16px;
  border: 1px solid hsl(var(--primary));
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);
  transition: box-shadow 150ms;
}
.flow-fleet-range:hover::-webkit-slider-thumb,
.flow-fleet-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px hsl(var(--ring) / 0.5); }
.flow-fleet-range:hover::-moz-range-thumb,
.flow-fleet-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px hsl(var(--ring) / 0.5); }
@media (prefers-reduced-motion: reduce) {
  .flow-fleet-range::-webkit-slider-thumb, .flow-fleet-range::-moz-range-thumb { transition: none; }
}
`;
