/**
 * The one notice the Flow tab may show above its rows (spec `claude-account-ui`
 * §8.3): a first-visit explanation of the three roles, or a warning that flow
 * has nothing, or only the main account, to spend.
 *
 * @module @dorkos/flow/extension/ui/notice
 */

import type { FleetView } from '../lib/fleet.ts';
import { h, type Node } from './react.ts';
import { NOTICE, NOTICE_ICON } from './styles.ts';

/**
 * The guide that explains the roles (`plugins/flow/docs/use-all-your-accounts.mdx`).
 * The spec's published address; the page is not live on the docs site yet.
 */
export const GUIDE_URL = 'https://dorkos.ai/docs/use-all-your-accounts';

/** The guide link's words (Q22, decided). */
export const GUIDE_LINK_TEXT = 'How to use all your accounts';

/** The first-visit notice's lines, one per role. */
export const ROLE_LINES = [
  'Main: yours. Flow keeps it in reserve and uses it last.',
  'Rotation: flow may use it fully.',
  'Kept out: flow never uses it.',
] as const;

/** Shown when roles are stored and no account is Main or Rotation (Q23, decided). */
export const NOTHING_USABLE_TEXT =
  "Flow can't use any account yet. Make one account Main or Rotation.";

/** Shown when a Main is set and no account that can rotate is in Rotation. */
export const NOTHING_IN_ROTATION_TEXT =
  'Nothing is in rotation yet, so flow only uses your main account.';

/** Which notice the tab shows. */
export type NoticeKind = 'first-visit' | 'nothing-usable' | 'nothing-in-rotation';

/**
 * Pick the one notice to show, in order: first visit, then nothing usable,
 * then nothing in rotation.
 *
 * - First visit: no account has a stored role yet.
 * - Nothing usable: no account of any runtime is Main or Rotation. A runtime's
 *   implicit account counts, since it is Rotation by default and flow can use it.
 * - Nothing in rotation: among the runtimes that take several accounts
 *   (`supportsAccounts`), a Main is set and none is in Rotation. An implicit
 *   account such as Codex's does not count.
 *
 * @param body - The `GET /fleet` body.
 * @returns The notice, or `null` for none.
 */
export function pickNotice(body: FleetView): NoticeKind | null {
  if (!body.anyRoleStored) return 'first-visit';
  const all = body.groups.flatMap((group) => group.accounts);
  if (!all.some((account) => account.role === 'main' || account.role === 'rotation')) {
    return 'nothing-usable';
  }
  const rotating = body.groups
    .filter((group) => group.supportsAccounts)
    .flatMap((group) => group.accounts);
  const hasMain = rotating.some((account) => account.role === 'main');
  const hasRotation = rotating.some((account) => account.role === 'rotation');
  return hasMain && !hasRotation ? 'nothing-in-rotation' : null;
}

/** The info icon (Lucide's `Info`, which the host uses for its info tone), redrawn inline. */
function InfoIcon(): Node {
  return h(
    'svg',
    {
      'aria-hidden': true,
      'data-slot': 'notice-icon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: NOTICE_ICON,
    },
    h('circle', { cx: 12, cy: 12, r: 10 }),
    h('path', { d: 'M12 16v-4' }),
    h('path', { d: 'M12 8h.01' })
  );
}

/**
 * A notice in the host `Notice` component's info tone, with its icon.
 *
 * @param props - The notice's content.
 * @returns The notice.
 */
export function InfoNotice(props: { children?: Node }): Node {
  return h(
    'div',
    { role: 'status', 'data-slot': 'notice', 'data-tone': 'info', style: NOTICE },
    h(InfoIcon),
    h('div', { style: { minWidth: 0 } }, props.children)
  );
}

/**
 * The notice for `kind`.
 *
 * @param props - Which notice.
 * @returns The notice.
 */
export function FleetNotice(props: { kind: NoticeKind }): Node {
  if (props.kind === 'nothing-usable') return h(InfoNotice, null, NOTHING_USABLE_TEXT);
  if (props.kind === 'nothing-in-rotation') return h(InfoNotice, null, NOTHING_IN_ROTATION_TEXT);
  return h(
    InfoNotice,
    null,
    ...ROLE_LINES.map((line) => h('p', { key: line, style: { margin: 0 } }, line)),
    h(
      'p',
      { style: { margin: '0.25rem 0 0' } },
      h(
        'a',
        {
          href: GUIDE_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' },
        },
        GUIDE_LINK_TEXT
      )
    )
  );
}
