/**
 * What flow's full pages share (spec `flow-multiproject` §4): the page's frame,
 * which reads the same on a phone, a tablet and a desktop; its heading; the
 * loading and failed states; and a decision's row, used by Flow home's
 * "Needs you" band and at the top of a project's page.
 *
 * DorkOS gives a page the whole content area and leaves its layout to the
 * page, so the frame sets its own width and gutters.
 *
 * @module @dorkos/flow/extension/ui/page-parts
 */

import type { FlowDecision } from '../lib/model.ts';
import { DecisionAnswers, answeredHere, openInInbox, type AnswerApi } from './answers.ts';
import { projectPath } from './links.ts';
import { FOCUS_CSS, LINK, MUTED } from './parts.ts';
import { h, type Node, type Style } from './react.ts';
import type { FlowStore, StoreSnapshot } from './store.ts';
import { ALERT, CHIP, hostColor } from './styles.ts';

/** Shown when a page could not read flow's status. */
export const PAGE_LOAD_FAILED_TEXT = "Couldn't load Flow's status. Try again in a moment.";

/**
 * The page frame's layout: a readable width, a 16px gutter on a phone and a
 * wider one from tablet up, and decision rows whose project column moves above
 * the row on a narrow screen.
 */
export const PAGE_CSS = `
.flow-page { box-sizing: border-box; max-width: 880px; margin: 0 auto; padding: 16px; }
@media (min-width: 640px) { .flow-page { padding: 24px 32px; } }
.flow-page .flow-drow { display: flex; align-items: flex-start; gap: 12px; }
.flow-page .flow-pcol { flex: none; width: 130px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 519px) {
  .flow-page .flow-drow { flex-wrap: wrap; row-gap: 2px; }
  .flow-page .flow-pcol { width: 100%; }
}
.flow-page button[data-row]:hover { background: hsl(var(--muted) / 0.5); }
`;

/** The page's type. */
const PAGE: Style = {
  position: 'relative',
  color: hostColor('foreground'),
  fontSize: '13px',
  lineHeight: 1.5,
};

/** A page heading. */
export const TITLE: Style = { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: 1.3 };

/**
 * A heading kept for screen readers but not drawn: DorkOS's bar over the page
 * already shows the page's title.
 */
export const SR_ONLY: Style = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  margin: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

/** A band's caption ("Needs you · 3"). */
export const BAND: Style = {
  margin: '18px 0 4px',
  color: hostColor('muted-foreground'),
  fontSize: '11px',
  fontWeight: 400,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

/** A band's row. */
export const BAND_ROW: Style = {
  padding: '8px 0',
  borderBottom: `1px solid ${hostColor('muted')}`,
};

/**
 * A page's frame.
 *
 * @param children - Its content.
 * @returns The frame.
 */
export function pageRoot(...children: Node[]): Node {
  return h(
    'div',
    { className: 'flow-tab flow-page', style: PAGE },
    h('style', null, FOCUS_CSS + PAGE_CSS),
    ...children
  );
}

/**
 * What a page shows before the model arrives, or after it failed to; `null`
 * once there is a model.
 *
 * @param snapshot - The store.
 * @param store - The store, to try again.
 * @returns The state, or `null`.
 */
export function loadingState(snapshot: StoreSnapshot, store: FlowStore): Node | null {
  if (snapshot.phase === 'failed') {
    return pageRoot(
      h(
        'p',
        { key: `failed-${snapshot.failures}`, role: 'alert', style: ALERT },
        PAGE_LOAD_FAILED_TEXT
      ),
      h(
        'button',
        {
          type: 'button',
          style: { ...CHIP, marginTop: '6px', cursor: 'pointer' },
          onClick: () => store.retry(),
        },
        'Retry'
      )
    );
  }
  if (snapshot.model === null) return pageRoot(h('div', { 'aria-busy': true }));
  return null;
}

/**
 * The words of the link that opens DorkOS's Inbox on an ask: a review gate
 * and a floor question are answered there, so DorkOS credits the answer to
 * you (§4.2, A21). They name the Inbox, not the page the link lands on: a
 * DorkOS too old to open the Inbox from a link shows Activity instead, and
 * the Inbox is still where the ask is answered.
 *
 * @param decision - The decision.
 * @returns The link's words.
 */
export function decisionLinkText(decision: FlowDecision): string {
  return decision.kind === 'review' || decision.kind === 'question'
    ? 'Answer in Inbox →'
    : 'Open in Inbox →';
}

/**
 * One decision's row: its project (on Flow home), the ask and why, and its
 * buttons, or, for an ask that must be credited to you, the way to the Inbox.
 *
 * @param props - The decision, whether to show its project, its project's
 *   folder, the host API and the store.
 * @returns The row.
 */
export function DecisionRow(props: {
  decision: FlowDecision;
  showProject: boolean;
  api: AnswerApi;
  root?: string | null;
  store?: FlowStore;
}): Node {
  const { decision, api } = props;
  return h(
    'div',
    { className: 'flow-drow', style: BAND_ROW },
    props.showProject
      ? h(
          'button',
          {
            type: 'button',
            className: 'flow-pcol',
            style: {
              ...LINK,
              fontSize: 'inherit',
              fontWeight: 600,
              textAlign: 'left',
              textDecoration: 'none',
            },
            onClick: () => api.navigate(projectPath(decision.project)),
          },
          decision.project
        )
      : null,
    h(
      'div',
      { style: { flex: 1, minWidth: 0 } },
      h('div', { style: { fontWeight: 600 } }, decision.title),
      h('p', { style: MUTED }, decision.why)
    ),
    answeredHere(decision, api)
      ? h(DecisionAnswers, { decision, root: props.root ?? null, api, store: props.store })
      : h(
          'button',
          {
            type: 'button',
            style: { ...LINK, flex: 'none' },
            onClick: () => void openInInbox(api, decision),
          },
          decisionLinkText(decision)
        )
  );
}
