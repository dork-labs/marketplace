/**
 * The Flow panel's tab icon in DorkOS's right-panel tab strip: a 24px
 * line icon drawn in `currentColor` like the host's `lucide-react` icons, so
 * the strip sizes and colors it through `className`.
 *
 * @module @dorkos/flow/extension/ui/flow-icon
 */

import { h, type Node } from './react.ts';

/**
 * Two boxes joined by a path: lucide's `workflow` shape (ISC), drawn inline
 * because the extension cannot bundle `lucide-react`.
 *
 * @param props - The host's sizing class.
 * @returns The icon.
 */
export function FlowIcon(props: { className?: string }): Node {
  return h(
    'svg',
    {
      className: props.className,
      xmlns: 'http://www.w3.org/2000/svg',
      width: 24,
      height: 24,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('rect', { x: 3, y: 3, width: 8, height: 8, rx: 2 }),
    h('path', { d: 'M7 11v4a2 2 0 0 0 2 2h4' }),
    h('rect', { x: 13, y: 13, width: 8, height: 8, rx: 2 })
  );
}
