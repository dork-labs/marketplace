/**
 * The Roadmap panel: one column, built for the 390px phone layout, since the
 * right panel is about that wide. Top to bottom: the header, any banner, the
 * decisions lane, what changed since you last looked, then Now, Next and
 * Later (Later starts folded).
 *
 * It is read-only. The only action on a card is "Ask in this room", which
 * copies a message; asks on the decisions lane only link to where they are
 * answered. A new version that arrives while the panel is on screen waits
 * behind a "… moved 2 cards · Show" pill, so nothing reorders under the
 * reader.
 *
 * @module @dorkos/roadmap/extension/ui/panel
 */

import type { BoardView, HistoryEntry } from '../lib/board-service.ts';
import { HORIZONS, type Board, type Horizon, type Item } from '../lib/roadmap.ts';
import type { PanelConfig } from '../server.ts';
import { getBoard, getConfig, getSeen, putSeen } from './api.ts';
import { askInRoom, copyStarter, moveRequest, roadmapRequest } from './ask.ts';
import {
  HORIZON_LABEL,
  MOSCOW_LABEL,
  STATUS_LABEL,
  agoWords,
  changeParts,
  clockTime,
  column,
  daysUntil,
  decider,
  entriesSince,
  expiryWarning,
  itemHistory,
  laneCards,
  linkHref,
  milestoneParts,
  pillText,
  placedBy,
  reconnectLine,
  shortDate,
  subline,
  targetLabel,
  threadPath,
  who,
  type LaneCard,
} from './format.ts';
import { h, useEffect, useRef, useState, type Node } from './react.ts';
import { CSS } from './styles.ts';

/** How often the panel asks for the board while it is open. */
export const POLL_MS = 60_000;
/** Cards a column shows before "Show N more". */
export const COLUMN_LIMIT = 12;
/** Changes the feed shows before "Show N more". */
const FEED_LIMIT = 5;

/** The part of DorkOS's `ExtensionAPI` the panel uses. */
export interface PanelHostApi {
  /** Go to an in-app address. */
  navigate(path: string): void;
  /** Show a toast. */
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;
}

/** What the panel can be given in place of the real machine (tests). */
export interface PanelDeps {
  getBoard?: (refresh?: boolean) => Promise<BoardView>;
  getConfig?: () => Promise<PanelConfig>;
  getSeen?: () => Promise<string | null>;
  putSeen?: (sha: string) => Promise<void>;
  now?: () => Date;
  /** Whether the person can see the page right now. */
  visible?: () => boolean;
}

/** Everything a section of the board reads. */
interface Ctx {
  api: PanelHostApi;
  view: BoardView;
  board: Board;
  config: PanelConfig;
  now: Date;
  /** The commits since the person last marked the board seen, or null if they never have. */
  unseen: HistoryEntry[] | null;
}

function Muted({ children, small = true }: { children: Node; small?: boolean }) {
  return h('span', { className: `rm-muted${small ? ' rm-small' : ''}` }, children);
}

/** "Moved X Next → Now", with the bet's title in bold. */
function ChangeLine({ entry, ctx, index }: { entry: HistoryEntry; ctx: Ctx; index: number }) {
  const change = entry.changes[index];
  if (!change) return h('span', null, 'changed roadmap.json');
  const parts = changeParts(change, ctx.config.deciderName);
  return h(
    'span',
    null,
    parts.before,
    parts.title === null ? null : [' ', h('strong', { key: 't' }, parts.title)],
    parts.after
  );
}

/** The commit subject in quotes, or a faint "No reason given". */
function Reason({ reason }: { reason: string | null }) {
  return reason
    ? h('p', { className: 'rm-small rm-muted' }, `“${reason}”`)
    : h('p', { className: 'rm-small rm-faint' }, 'No reason given');
}

/** One commit in the feed. */
function FeedItem({ entry, ctx }: { entry: HistoryEntry; ctx: Ctx }) {
  const lines = entry.changes.length === 0 ? [0] : entry.changes.slice(0, 3).map((_, i) => i);
  const more = entry.changes.length - 3;
  return h(
    'li',
    null,
    h(
      'div',
      { className: 'rm-between' },
      h(
        'div',
        null,
        lines.map((i) =>
          h(
            'p',
            { key: i },
            h('strong', null, who(entry.author)),
            ' ',
            h(ChangeLine, { entry, ctx, index: i })
          )
        ),
        more > 0 ? h(Muted, null, `and ${more} more`) : null
      ),
      h('span', { className: 'rm-muted rm-small rm-nowrap' }, agoWords(entry.date, ctx.now))
    ),
    h(Reason, { reason: entry.reason }),
    entry.url
      ? h(
          'a',
          {
            className: 'rm-link rm-muted',
            href: entry.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'View commit'
        )
      : null
  );
}

/** "Since you last looked", hidden when nothing changed. */
function Feed({ ctx, onMarkSeen }: { ctx: Ctx; onMarkSeen: () => void }) {
  const [all, setAll] = useState(false);
  const first = ctx.unseen === null;
  const entries = first ? ctx.view.history.slice(0, FEED_LIMIT) : ctx.unseen!;
  if (entries.length === 0) return null;
  const shown = all ? entries : entries.slice(0, FEED_LIMIT);
  return h(
    'section',
    { className: 'rm-section', 'aria-labelledby': 'rm-feed-h' },
    h(
      'div',
      { className: 'rm-between' },
      h(
        'h3',
        { className: 'rm-section-head', id: 'rm-feed-h' },
        first ? 'Recent changes' : 'Since you last looked',
        h('span', { className: 'rm-badge' }, String(entries.length))
      ),
      h(
        'button',
        { type: 'button', className: 'rm-link rm-muted', onClick: onMarkSeen },
        'Mark seen'
      )
    ),
    h(
      'ul',
      { className: 'rm-feed' },
      shown.map((entry) => h(FeedItem, { key: entry.sha, entry, ctx }))
    ),
    !all && entries.length > FEED_LIMIT
      ? h(
          'button',
          { type: 'button', className: 'rm-link', onClick: () => setAll(true) },
          `Show ${entries.length - FEED_LIMIT} more`
        )
      : null
  );
}

/** One ask on the decisions lane. Its only action opens where it is answered. */
function AskCard({ card, ctx }: { card: LaneCard; ctx: Ctx }) {
  const { item, need } = card;
  const overdue = need.by !== null && daysUntil(need.by, ctx.now) < 0;
  const open = () =>
    need.thread ? ctx.api.navigate(threadPath(need.thread)) : ctx.api.navigate('/');
  return h(
    'article',
    { className: 'rm-card' },
    h(
      'p',
      { className: 'rm-small rm-muted' },
      need.kind === 'permission' ? '🔒 Permission' : 'Decision',
      ' · ',
      item.title
    ),
    h('p', { style: { fontWeight: 500, marginTop: 2 } }, need.ask),
    need.recommend
      ? h(
          'p',
          { className: 'rm-small', style: { marginTop: 4 } },
          h('strong', null, `@${need.askedBy} recommends: `),
          need.recommend
        )
      : null,
    h(
      'div',
      { className: 'rm-between', style: { marginTop: 8, alignItems: 'center' } },
      h(
        'span',
        { className: 'rm-small' },
        h('span', { className: 'rm-muted' }, `@${need.askedBy}`),
        need.by
          ? h(
              'span',
              { className: overdue ? 'rm-red' : 'rm-muted' },
              ` · ${overdue ? 'Was due' : 'By'} ${shortDate(need.by)}`
            )
          : null
      ),
      h(
        'button',
        { type: 'button', className: 'rm-link', onClick: open },
        need.thread ? 'Answer in the thread →' : 'Find the approval on Home →'
      )
    )
  );
}

/** "Needs Sam": every ask, soonest first. Lists decisions; never takes them. */
function NeedsLane({ ctx }: { ctx: Ctx }) {
  const cards = laneCards(ctx.board);
  return h(
    'section',
    { className: 'rm-section', 'aria-labelledby': 'rm-needs-h' },
    h(
      'h3',
      { className: 'rm-section-head', id: 'rm-needs-h' },
      `Needs ${decider(ctx.config.deciderName)}`,
      h(
        'span',
        { className: 'rm-badge', 'data-brand': cards.length > 0 ? '' : undefined },
        String(cards.length)
      ),
      h(
        'span',
        { className: 'rm-count' },
        cards.length > 0
          ? 'Listed here, answered where they live'
          : `Nothing is waiting on ${decider(ctx.config.deciderName)}`
      )
    ),
    cards.map((card) => h(AskCard, { key: card.need.id, card, ctx }))
  );
}

/** A bet's detail: why, its fields, its links and its last five changes. */
function Details({ item, ctx }: { item: Item; ctx: Ctx }) {
  const history = itemHistory(ctx.view.history, item.id).slice(0, 5);
  const fields: [string, string][] = [
    ['Horizon', HORIZON_LABEL[item.horizon]],
    ['MoSCoW', MOSCOW_LABEL[item.moscow]],
    ['Owner', `@${item.owner}`],
    ['Target', targetLabel(item.target, ctx.board) ?? 'None'],
    ['Status', STATUS_LABEL[item.status]],
  ];
  return h(
    'div',
    { className: 'rm-details' },
    h('p', null, item.why),
    h(
      'dl',
      { className: 'rm-fields' },
      fields.map(([k, v]) => [h('dt', { key: `${k}t` }, k), h('dd', { key: `${k}d` }, v)])
    ),
    item.links.length > 0
      ? h(
          'div',
          { className: 'rm-links' },
          item.links.map((link, i) => {
            const href = linkHref(link, ctx.config.prRepo);
            const text = link.label ?? link.ref;
            return href
              ? h(
                  'a',
                  {
                    key: i,
                    className: 'rm-linkchip',
                    href,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  },
                  `${text} ↗`
                )
              : h('span', { key: i, className: 'rm-linkchip' }, text);
          })
        )
      : null,
    history.length > 0
      ? h(
          'div',
          null,
          h('h4', { className: 'rm-small rm-muted', style: { fontWeight: 600 } }, 'History'),
          h(
            'ul',
            { className: 'rm-feed' },
            history.map((entry) => h(FeedItem, { key: entry.sha, entry, ctx }))
          )
        )
      : null,
    h(
      Muted,
      null,
      'To change anything, edit roadmap.json. Each change is a commit with its author.'
    )
  );
}

/** One bet. Enter or a click opens its detail; ⋯ holds "Ask in this room". */
function Card({ item, ctx, placed }: { item: Item; ctx: Ctx; placed: HistoryEntry | undefined }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const firstItem = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (menu) firstItem.current?.focus();
  }, [menu]);
  const closeMenu = () => {
    setMenu(false);
    menuButton.current?.focus();
  };
  const asks = item.needs.length;
  const target = targetLabel(item.target, ctx.board);
  return h(
    'article',
    { className: 'rm-card', 'data-new': placed ? '' : undefined },
    h(
      'div',
      { className: 'rm-between' },
      h(
        'button',
        {
          type: 'button',
          className: 'rm-cardbtn',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
        h('span', { className: 'rm-title', title: item.title }, item.title)
      ),
      h(
        'button',
        {
          type: 'button',
          ref: menuButton,
          className: 'rm-icon-btn',
          'aria-label': `More for ${item.title}`,
          'aria-haspopup': 'menu',
          'aria-expanded': menu,
          onClick: () => setMenu(!menu),
        },
        '⋯'
      )
    ),
    menu
      ? h(
          'div',
          {
            className: 'rm-menu',
            role: 'menu',
            onKeyDown: (event: { key: string }) => {
              if (event.key === 'Escape') closeMenu();
            },
            // Leaving the menu closes it, unless focus went to ⋯, whose click toggles it.
            onBlur: (event: { currentTarget: HTMLElement; relatedTarget: EventTarget | null }) => {
              const to = event.relatedTarget as globalThis.Node | null;
              if (to && (event.currentTarget.contains(to) || to === menuButton.current)) return;
              setMenu(false);
            },
          },
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              ref: firstItem,
              className: 'rm-menu-item',
              onClick: () => {
                setMenu(false);
                void askInRoom(ctx.api, moveRequest(ctx.config.keeperHandle, item.title));
              },
            },
            'Ask in this room'
          )
        )
      : null,
    h(
      'div',
      { className: 'rm-meta' },
      h(
        'span',
        { className: 'rm-chip', 'data-must': item.moscow === 'must' ? '' : undefined },
        MOSCOW_LABEL[item.moscow]
      ),
      h('span', null, `@${item.owner}`),
      target ? h('span', null, target) : null,
      item.status === 'blocked' ? h('span', { className: 'rm-red' }, 'Blocked') : null,
      asks > 0
        ? h(
            'span',
            { className: 'rm-red', 'aria-label': `${asks} open ${asks === 1 ? 'ask' : 'asks'}` },
            `⚑ ${asks}`
          )
        : null
    ),
    placed
      ? h(
          'p',
          { className: 'rm-small', style: { marginTop: 6 } },
          h('strong', null, who(placed.author)),
          ` moved it here ${agoWords(placed.date, ctx.now)}: `,
          placed.reason
            ? h('span', { className: 'rm-muted' }, placed.reason)
            : h('span', { className: 'rm-faint' }, 'No reason given')
        )
      : null,
    open ? h(Details, { item, ctx }) : null
  );
}

/** One horizon. Later starts folded to its count. */
function Column({
  horizon,
  ctx,
  placed,
}: {
  horizon: Horizon;
  ctx: Ctx;
  placed: Map<string, HistoryEntry>;
}) {
  const [folded, setFolded] = useState(horizon === 'later');
  const [all, setAll] = useState(false);
  const items = column(ctx.board, horizon);
  const shown = all ? items : items.slice(0, COLUMN_LIMIT);
  const id = `rm-col-${horizon}`;
  const label = [
    HORIZON_LABEL[horizon],
    h('span', { key: 'c', className: 'rm-count' }, ` ${items.length}`),
  ];
  return h(
    'section',
    { className: 'rm-section', 'aria-labelledby': id },
    h(
      'h3',
      { className: 'rm-section-head', id },
      horizon === 'later'
        ? h(
            'button',
            {
              type: 'button',
              className: 'rm-cardbtn',
              style: { width: 'auto', fontWeight: 600 },
              'aria-expanded': !folded,
              onClick: () => setFolded(!folded),
            },
            folded ? '▸ ' : '▾ ',
            label
          )
        : label
    ),
    folded
      ? null
      : items.length === 0
        ? h('p', { className: 'rm-small rm-muted' }, 'Nothing yet')
        : [
            ...shown.map((item) =>
              h(Card, { key: item.id, item, ctx, placed: placed.get(item.id) })
            ),
            !all && items.length > COLUMN_LIMIT
              ? h(
                  'button',
                  {
                    key: 'more',
                    type: 'button',
                    className: 'rm-link',
                    style: { marginTop: 6 },
                    onClick: () => setAll(true),
                  },
                  `Show ${items.length - COLUMN_LIMIT} more`
                )
              : null,
          ]
  );
}

/** The title, the subline, the token warning and the milestones. */
function Header({ ctx }: { ctx: Ctx }) {
  const line = subline(ctx.view, ctx.now);
  const warning = expiryWarning(ctx.view.tokenExpiresAt, ctx.now);
  const milestones = milestoneParts(ctx.board, ctx.now);
  return h(
    'header',
    null,
    h(
      'div',
      { className: 'rm-between' },
      h('h2', { className: 'rm-h1' }, 'Roadmap'),
      ctx.view.fileUrl
        ? h(
            'a',
            {
              className: 'rm-link rm-muted',
              href: ctx.view.fileUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            'Open file ↗'
          )
        : null
    ),
    h(
      'p',
      { className: 'rm-small rm-muted', style: { marginTop: 2 } },
      line.text,
      line.stale
        ? [
            ' · ',
            h(
              'button',
              {
                key: 'ask',
                type: 'button',
                className: 'rm-link',
                onClick: () =>
                  void askInRoom(ctx.api, roadmapRequest(ctx.config.keeperHandle, 'update')),
              },
              'Ask for an update'
            ),
          ]
        : null
    ),
    warning
      ? h(
          'p',
          { className: 'rm-small rm-faint' },
          `${warning} · ${reconnectLine(ctx.config.deciderName)}`
        )
      : null,
    milestones.length > 0
      ? h(
          'p',
          { className: 'rm-row rm-small', style: { marginTop: 8 } },
          milestones.map((m) =>
            h(
              'span',
              { key: m.id },
              h('strong', null, m.date),
              ` ${m.title}`,
              m.countdown ? h('span', { className: 'rm-muted' }, ` ${m.countdown}`) : null
            )
          )
        )
      : null
  );
}

/** The one banner over a board that isn't the file as it is now. */
function Banner({
  view,
  config,
  now,
  onRetry,
}: {
  view: BoardView;
  config: PanelConfig;
  now: Date;
  onRetry: () => void;
}) {
  const copy = view.asOf ? `Showing the copy from ${clockTime(view.asOf)}.` : '';
  let title: string;
  let detail: string;
  let action: Node = null;
  switch (view.status) {
    case 'invalid': {
      title = `roadmap.json doesn't parse · ${view.parseError?.message ?? ''}`;
      const by = view.head
        ? `${view.head.author}'s change ${agoWords(view.head.date, now)} broke it. `
        : '';
      detail = view.stale
        ? `${by}Showing the last good version, from ${clockTime(view.asOf!)}.`
        : `${by}There's no earlier version to show.`;
      action = view.fileUrl
        ? h(
            'a',
            {
              className: 'rm-btn',
              href: view.fileUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            'Open file'
          )
        : null;
      break;
    }
    case 'unreachable':
      title =
        view.problem && view.problem !== "GitHub didn't answer"
          ? view.problem
          : "Can't reach GitHub";
      detail = `${copy} It updates on its own when GitHub answers.`.trim();
      action = h('button', { type: 'button', className: 'rm-btn', onClick: onRetry }, 'Retry');
      break;
    case 'auth-expired':
      title = view.tokenExpiresAt
        ? `GitHub access expired on ${shortDate(view.tokenExpiresAt)}.`
        : 'GitHub access expired.';
      detail = `${reconnectLine(config.deciderName)} ${copy}`.trim();
      break;
    case 'auth-failed':
      title = 'GitHub access stopped working.';
      detail = `${reconnectLine(config.deciderName)} ${copy}`.trim();
      break;
    default:
      return null;
  }
  return h(
    'div',
    { className: 'rm-banner', role: 'status' },
    h(
      'div',
      null,
      h('p', { style: { fontWeight: 600 } }, title),
      h('p', { className: 'rm-muted' }, detail)
    ),
    action
  );
}

/** "2 items skipped" and why. */
function Skipped({ view }: { view: BoardView }) {
  if (view.skipped.length === 0) return null;
  const n = view.skipped.length;
  return h(
    'div',
    { className: 'rm-banner' },
    h(
      'div',
      null,
      h('p', { style: { fontWeight: 600 } }, `${n} ${n === 1 ? 'item' : 'items'} skipped`),
      h(
        'p',
        { className: 'rm-muted' },
        view.skipped
          .map((s) => `${s.id.length > 8 ? `${s.id.slice(0, 6)}…` : s.id} ${s.reason}`)
          .join(' · ')
      )
    )
  );
}

/** A panel with no board to show: setup, no token, no file, or nothing read yet. */
function Empty({ title, body, children }: { title: string; body: string; children?: Node }) {
  return h(
    'div',
    { className: 'rm-empty' },
    h('p', { style: { fontWeight: 600 } }, title),
    h('p', { className: 'rm-small rm-muted', style: { marginTop: 4 } }, body),
    children ? h('div', { className: 'rm-row' }, children) : null
  );
}

function emptyFor(
  view: BoardView,
  config: PanelConfig,
  api: PanelHostApi,
  now: Date,
  onRetry: () => void
): Node {
  const owner = config.deciderName ?? 'The owner';
  switch (view.status) {
    case 'setup':
      return h(Empty, {
        title: "Roadmap isn't set up yet",
        body: `${owner} can add the GitHub repo that holds roadmap/roadmap.json in the extension's settings.`,
      });
    case 'no-token':
      return h(Empty, {
        title: 'Connect GitHub to load the roadmap',
        body: `${owner} can add a GitHub token in the extension's settings.`,
      });
    case 'no-file':
      return h(
        Empty,
        {
          title: 'No roadmap here yet',
          body: `The board reads roadmap/roadmap.json from ${view.repo}. Ask an agent to start one, or add it yourself.`,
        },
        config.keeperHandle
          ? h(
              'button',
              {
                type: 'button',
                className: 'rm-btn',
                'data-solid': '',
                onClick: () => void askInRoom(api, roadmapRequest(config.keeperHandle, 'start')),
              },
              `Ask @${config.keeperHandle}`
            )
          : null,
        h(
          'button',
          { type: 'button', className: 'rm-btn', onClick: () => void copyStarter(api) },
          'Copy a starter file'
        )
      );
    default:
      return h(Banner, { view, config, now, onRetry });
  }
}

/**
 * Build the panel.
 *
 * @param api - DorkOS's extension API.
 * @param deps - Replacements for the real machine (tests).
 * @returns The panel component the right-panel tab renders.
 */
export function createPanel(api: PanelHostApi, deps: PanelDeps = {}) {
  const readBoard = deps.getBoard ?? getBoard;
  const readConfig = deps.getConfig ?? getConfig;
  const readSeen = deps.getSeen ?? getSeen;
  const writeSeen = deps.putSeen ?? putSeen;
  const clock = deps.now ?? (() => new Date());
  const visible = deps.visible ?? (() => document.visibilityState === 'visible');

  return function RoadmapPanel() {
    const [shown, setShown] = useState<BoardView | null>(null);
    const [pending, setPending] = useState<BoardView | null>(null);
    const [config, setConfig] = useState<PanelConfig>({
      deciderName: null,
      keeperHandle: null,
      prRepo: null,
    });
    const [seen, setSeen] = useState<string | null | undefined>(undefined);
    const [down, setDown] = useState(false);
    const [, setTick] = useState(0);
    const shownRef = useRef<BoardView | null>(null);
    const pendingRef = useRef<BoardView | null>(null);

    const show = (view: BoardView) => {
      shownRef.current = view;
      pendingRef.current = null;
      setShown(view);
      setPending(null);
    };

    /** Take a new answer: show it, or hold it behind the pill if it would reorder the board. */
    const accept = (next: BoardView) => {
      const current = shownRef.current;
      // Only a fresh board replacing a fresh board waits behind the pill. A
      // change of state (GitHub failing, or working again) is news and shows
      // at once. Boards are compared by content, since a commit can be unknown
      // (GitHub listed none) while the file still changed.
      const fresh = (view: BoardView | null) =>
        view?.board != null && view.status === 'ok' && !view.stale;
      const reorders =
        fresh(current) &&
        fresh(next) &&
        JSON.stringify(current!.board) !== JSON.stringify(next.board);
      if (reorders && visible()) {
        pendingRef.current = next;
        setPending(next);
      } else {
        show(next);
      }
    };

    const load = async (refresh = false) => {
      try {
        accept(await readBoard(refresh));
        setDown(false);
      } catch {
        setDown(true);
      }
      setTick((t) => t + 1);
    };

    useEffect(() => {
      let live = true;
      void readConfig()
        .then((c) => live && setConfig(c))
        .catch(() => {});
      void readSeen()
        .then((sha) => live && setSeen(sha))
        .catch(() => live && setSeen(null));
      void load();
      const timer = setInterval(() => void load(), POLL_MS);
      const onVisible = () => {
        if (!visible()) return;
        if (pendingRef.current) show(pendingRef.current);
        void load();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        live = false;
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }, []);

    const markSeen = () => {
      const head = shownRef.current?.history[0]?.sha;
      if (!head) return;
      setSeen(head);
      void writeSeen(head).catch(() =>
        api.notify("Couldn't save where you left off.", { type: 'error' })
      );
    };

    const retry = () => void load(true);
    let body: Node;
    if (!shown) {
      body = down
        ? h(
            Empty,
            { title: "Roadmap's server isn't answering", body: 'It may still be starting.' },
            h('button', { type: 'button', className: 'rm-btn', onClick: retry }, 'Retry')
          )
        : h(Empty, { title: 'Loading the roadmap…', body: '' });
    } else if (!shown.board) {
      body = emptyFor(shown, config, api, clock(), retry);
    } else {
      const now = clock();
      const unseen = seen ? entriesSince(shown.history, seen) : null;
      const ctx: Ctx = { api, view: shown, board: shown.board, config, now, unseen };
      const placed = placedBy(unseen ?? []);
      body = [
        h(Header, { key: 'header', ctx }),
        h(Banner, { key: 'banner', view: shown, config, now, onRetry: retry }),
        h(Skipped, { key: 'skipped', view: shown }),
        h(
          'div',
          { key: 'board', className: shown.stale ? 'rm-dim' : undefined },
          h(NeedsLane, { ctx }),
          h(Feed, { ctx, onMarkSeen: markSeen }),
          HORIZONS.map((horizon) => h(Column, { key: horizon, horizon, ctx, placed }))
        ),
      ];
    }
    // With no known commit on screen, name no cards rather than count the whole history.
    // Name the commits since the one on screen; when that one isn't in the new
    // history (unknown, or too far back), name no cards rather than all of them.
    const since =
      pending && shown?.revision && pending.history.some((e) => e.sha === shown.revision)
        ? entriesSince(pending.history, shown.revision)
        : [];
    const pill = pending ? pillText(since) : null;
    return h(
      'div',
      { className: 'rm' },
      h('style', null, CSS),
      pill
        ? h(
            'div',
            { className: 'rm-pill' },
            h('span', null, pill),
            h(
              'button',
              { type: 'button', className: 'rm-btn', onClick: () => show(pendingRef.current!) },
              'Show'
            )
          )
        : null,
      h(
        'div',
        { role: 'status', 'aria-live': 'polite', style: VISUALLY_HIDDEN },
        pill ? `${pill}. Show to update the board.` : ''
      ),
      body
    );
  };
}

/** Read by screen readers, not drawn. */
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;
