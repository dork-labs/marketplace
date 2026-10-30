/**
 * The Roadmap tab's icon: three stacked bars of different lengths. An inline
 * SVG, since an extension can't import the host's icon set.
 *
 * @module @dorkos/roadmap/extension/ui/icon
 */

import { h } from './react.ts';

/**
 * The icon. The host sizes it through `className`; it draws in `currentColor`.
 *
 * @param props.className - The host's sizing classes.
 */
export function RoadmapIcon({ className }: { className?: string }) {
  return h(
    'svg',
    {
      className,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M4 6h10' }),
    h('path', { d: 'M4 12h16' }),
    h('path', { d: 'M4 18h7' })
  );
}
