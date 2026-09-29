/**
 * The run chip in the chat's status bar (spec `flow-multiproject` §6, V5 B):
 * which tracker item this chat is working on and where it stands, such as
 * "DOR-2387 · Building", or, for a chat that handed items to chats of their
 * own, "3 items · 1 needs you". Pressed, it opens a list upward: one row per
 * item with its state, "Open its chat" for an item that runs in its own chat,
 * a link to the item in the tracker, and the project in Flow.
 *
 * The items are core's (`ctx.trackerItems`, newest first). Each is matched by
 * id to a run in the live store for its state and title; one the store does
 * not know yet shows core's own facts. It states facts only and never
 * estimates time left.
 *
 * `when` and `urgent` read only the context core hands them: core calls them
 * on every status-bar render, so they never touch the store or the network.
 *
 * @module @dorkos/flow/extension/ui/run-chip
 */

import type { ComponentType } from 'react';
import type { FlowModel, FlowProject, FlowRunRow, RunPill } from '../lib/model.ts';
import type { ClientApi, StatusBarSlotContext, TrackerItemRef } from '../lib/host-types.ts';
import { hasPages, projectPath, webHref } from './links.ts';
import { PILL_TEXT } from './panel-format.ts';
import { FOCUS_CSS, GROW, LINK, MUTED, PILL, ROW } from './parts.ts';
import { sessionRoute } from './project-lens.ts';
import { h, useEffect, useRef, useState, type Node, type Style } from './react.ts';
import { storeIsFresh, useStore, type FlowStore } from './store.ts';
import { hostColor } from './styles.ts';

/** The chip's accessible name in the status bar. */
export const CHIP_LABEL = 'Flow run';

/** Where the chip sits among extension items (lower is first). */
export const CHIP_PRIORITY = 50;

/** The run statuses flow writes for a run that waits on a person. */
const WAITING_ON_PERSON = new Set(['waiting_for_review']);

/** How long a Building or Handing off item may be quiet before the chip says so, in ms. */
export const QUIET_AFTER_MS = 60 * 60_000;

/** The states from most to least urgent: the chip names the first one present. */
export const URGENCY: readonly RunPill[] = [
  'needs-you',
  'handing-off',
  'parked',
  'building',
  'in-review',
  'done',
];

/** Each state as the chip counts it ("1 needs you", "2 building"). */
const COUNTED: Readonly<Record<RunPill, string>> = {
  'needs-you': 'needs you',
  'handing-off': 'handing off',
  parked: 'parked',
  building: 'building',
  'in-review': 'in review',
  done: 'done',
};

/**
 * Whether the chip shows for this chat: it works on at least one item.
 * Pure: it reads only `ctx`.
 *
 * @param ctx - The chat's status-bar context.
 * @returns True when there is an item.
 */
export function chipWhen(ctx: StatusBarSlotContext): boolean {
  return ctx.trackerItems.length > 0;
}

/**
 * Whether the chip needs attention: an item is at review, or its run waits
 * on a person. Pure: it reads only `ctx`.
 *
 * @param ctx - The chat's status-bar context.
 * @returns True when something waits on you.
 */
export function chipUrgent(ctx: StatusBarSlotContext): boolean {
  return ctx.trackerItems.some(waitsOnYou);
}

/**
 * Whether core's facts say an item waits on a person: it is at review, or its
 * run waits for one. The chip's words follow this, so the chip never reads
 * "In review" while DorkOS draws it as needing you.
 *
 * @param item - Core's item.
 * @returns True when it waits on you.
 */
export function waitsOnYou(item: TrackerItemRef): boolean {
  return (
    item.stage === 'review' || (item.runStatus !== null && WAITING_ON_PERSON.has(item.runStatus))
  );
}

/**
 * An item's state from core's facts alone, for an item the store does not
 * know yet. No stage name ever reaches the screen: only the pill words.
 *
 * @param item - Core's item.
 * @returns The pill.
 */
export function pillFromCore(item: TrackerItemRef): RunPill {
  if (item.runStatus === 'complete') return 'done';
  if (item.runStatus === 'failed') return 'parked';
  if (waitsOnYou(item)) return 'needs-you';
  return 'building';
}

/** One of the chat's items, matched to what flow knows of it. */
export interface ChipItem {
  /** Core's item. */
  ref: TrackerItemRef;
  /** The run flow has for it, or `null` when the store does not know it yet. */
  run: FlowRunRow | null;
  /** The project the run belongs to, or `null`. */
  project: FlowProject | null;
  /** Its state. */
  pill: RunPill;
  /** When it last moved, as flow knows it, or `null`. */
  lastUpdate: string | null;
}

/**
 * Match core's items to the store's runs. A run in the chat's own project
 * wins over one of the same id elsewhere.
 *
 * @param ctx - The chat's status-bar context.
 * @param model - The store's model, or `null`.
 * @returns The items, in core's order.
 */
export function chipItems(ctx: StatusBarSlotContext, model: FlowModel | null): ChipItem[] {
  const projects = model === null ? [] : [...model.projects];
  const own = ctx.project === null ? -1 : projects.findIndex((p) => p.root === ctx.project?.root);
  if (own > 0) projects.unshift(...projects.splice(own, 1));
  return ctx.trackerItems.map((ref) => {
    for (const project of projects) {
      const run = project.runs.find((row) => row.identifier === ref.id);
      if (run !== undefined) {
        const pill = run.state !== 'done' && waitsOnYou(ref) ? 'needs-you' : run.state;
        return { ref, run, project, pill, lastUpdate: run.updatedAt ?? ref.startedAt };
      }
    }
    return { ref, run: null, project: null, pill: pillFromCore(ref), lastUpdate: ref.startedAt };
  });
}

/**
 * A short age: "just now", "45m ago", "2h ago", "3d ago".
 *
 * @param ms - How long ago, in ms.
 * @returns The words.
 */
export function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** What an item's state reads as: its pill, or "Last update 2h ago" when it has gone quiet. */
export type ItemStatus = { kind: 'state'; pill: RunPill } | { kind: 'quiet'; ago: string };

/** The clock and the store's freshness, which every status is read against. */
export interface ChipClock {
  /** Now, in ms. */
  now: number;
  /** Whether the store's facts are current. */
  fresh: boolean;
  /** When the store last heard from flow, in ms, or `null`. */
  heardAt: number | null;
}

/**
 * An item's status. Building and Handing off go quiet after an hour without
 * news; Needs you, In review and Parked are expected to wait, so they never
 * do. When the store itself has heard nothing for five minutes, every item
 * says how old flow's news is.
 *
 * @param item - The item.
 * @param clock - The clock and the store's freshness.
 * @returns The status.
 */
export function itemStatus(item: ChipItem, clock: ChipClock): ItemStatus {
  if (!clock.fresh) {
    return { kind: 'quiet', ago: ageText(clock.heardAt === null ? 0 : clock.now - clock.heardAt) };
  }
  if ((item.pill === 'building' || item.pill === 'handing-off') && item.lastUpdate !== null) {
    const at = Date.parse(item.lastUpdate);
    if (Number.isFinite(at) && clock.now - at > QUIET_AFTER_MS) {
      return { kind: 'quiet', ago: ageText(clock.now - at) };
    }
  }
  return { kind: 'state', pill: item.pill };
}

/** What the chip itself reads. */
export interface ChipWords {
  /** The item's id and title, or "3 items". */
  subject: string;
  /** The state ("Building", "1 needs you", "Merged · closed"), or "Last update". */
  state: string;
  /** The quiet age ("2h ago"), shown muted, or `null`. */
  ago: string | null;
}

/**
 * The chip's words.
 *
 * - One item: "DOR-2387 Out-of-usage banner · Building"; "Merged · closed"
 *   once done. At phone width the title is dropped.
 * - Several: "3 items · 1 needs you", naming the most urgent state and how
 *   many are in it, or "Done" when all are. At phone width, the state alone.
 *
 * @param items - The chat's items.
 * @param clock - The clock and the store's freshness.
 * @param compact - True at phone width.
 * @returns The words.
 */
export function chipWords(
  items: readonly ChipItem[],
  clock: ChipClock,
  compact: boolean
): ChipWords {
  if (items.length === 1) {
    const [item] = items;
    const title = item.run?.title ?? null;
    const subject = compact || title === null ? item.ref.id : `${item.ref.id} ${title}`;
    const status = itemStatus(item, clock);
    if (status.kind === 'quiet') return { subject, state: 'Last update', ago: status.ago };
    return {
      subject,
      state: status.pill === 'done' ? 'Merged · closed' : PILL_TEXT[status.pill],
      ago: null,
    };
  }
  const subject = `${items.length} items`;
  if (!clock.fresh) {
    const ago = ageText(clock.heardAt === null ? 0 : clock.now - clock.heardAt);
    return { subject, state: 'Last update', ago };
  }
  if (items.every((item) => item.pill === 'done')) return { subject, state: 'Done', ago: null };
  const worst = URGENCY.find((pill) => items.some((item) => item.pill === pill)) ?? 'building';
  if (compact) return { subject, state: PILL_TEXT[worst], ago: null };
  const count = items.filter((item) => item.pill === worst).length;
  return { subject, state: `${count} ${COUNTED[worst]}`, ago: null };
}

const CHIP: Style = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  minWidth: 0,
  maxWidth: '100%',
  padding: '0 2px',
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const SUBJECT: Style = {
  minWidth: 0,
  maxWidth: '16em',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/** The list's width, and the gap it keeps from the screen's edges, in px. */
const LIST_WIDTH = 300;
const EDGE = 8;

/**
 * Where the list opens: upward from the chip, its right edge on the chip's,
 * kept on screen. Fixed, so a status bar that clips its content cannot cut it.
 *
 * @param rect - The chip's box.
 * @param viewport - The window's size.
 * @returns The list's position.
 */
export function listPosition(
  rect: { top: number; right: number },
  viewport: { width: number; height: number }
): Style {
  const width = Math.min(LIST_WIDTH, viewport.width - EDGE * 2);
  const left = Math.max(EDGE, Math.min(rect.right - width, viewport.width - width - EDGE));
  return {
    position: 'fixed',
    left: `${left}px`,
    bottom: `${viewport.height - rect.top + 6}px`,
    width: `${width}px`,
  };
}

/**
 * Whether an element sits inside a box that moves or scales what it holds (a
 * popover or a drawer). There, `position: fixed` measures from that box rather
 * than the window, so the list opens in place instead.
 *
 * @param element - The chip.
 * @returns True inside such a box.
 */
export function insideMovedBox(element: Element | null): boolean {
  for (let at = element?.parentElement ?? null; at !== null; at = at.parentElement) {
    const style = getComputedStyle(at);
    const willChange = style.willChange ?? '';
    const contain = style.contain ?? '';
    if (
      (style.transform !== '' && style.transform !== 'none') ||
      (style.filter !== '' && style.filter !== 'none') ||
      (style.perspective !== '' && style.perspective !== 'none') ||
      /transform|filter|perspective/.test(willChange) ||
      /paint|layout|strict|content/.test(contain)
    ) {
      return true;
    }
  }
  return false;
}

const LIST: Style = {
  zIndex: 50,
  maxHeight: '60vh',
  overflowY: 'auto',
  padding: '6px 10px',
  border: `1px solid ${hostColor('border')}`,
  borderRadius: '10px',
  background: hostColor('popover'),
  color: hostColor('popover-foreground'),
  boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)',
  fontSize: '12px',
  lineHeight: 1.5,
  whiteSpace: 'normal',
};

/**
 * Build the run chip over the live store.
 *
 * @param api - The host API (navigation, and whether flow's pages exist).
 * @param store - The live store.
 * @param clock - The clock, in ms (tests).
 * @returns The chip's component.
 */
export function createRunChip(
  api: Pick<ClientApi, 'navigate' | 'registerPage'>,
  store: FlowStore,
  clock: () => number = Date.now
): ComponentType<StatusBarSlotContext> {
  const pages = hasPages(api);
  function RunChip(ctx: StatusBarSlotContext): Node {
    const snapshot = useStore(store);
    const [open, setOpen] = useState(false);
    const [inPlace, setInPlace] = useState(false);
    const [, setTick] = useState(0);
    const button = useRef<HTMLButtonElement | null>(null);
    const list = useRef<HTMLDivElement | null>(null);
    const wrapper = useRef<HTMLSpanElement | null>(null);
    // Ages move on their own: redraw every minute.
    useEffect(() => {
      const timer = setInterval(() => setTick((n: number) => n + 1), 60_000);
      return () => clearInterval(timer);
    }, []);
    useEffect(() => {
      if (!open) return;
      (list.current?.querySelector<HTMLElement>('a, button') ?? list.current)?.focus();
      const onPointer = (event: PointerEvent) => {
        const target = event.target as globalThis.Node;
        if (button.current?.contains(target) || list.current?.contains(target)) return;
        setOpen(false);
      };
      // Escape closes the list first, wherever focus is, and goes no further:
      // caught on the window before a popover around the chip (which listens
      // on the document) would close as well.
      const onKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      };
      document.addEventListener('pointerdown', onPointer);
      window.addEventListener('keydown', onKey, true);
      return () => {
        document.removeEventListener('pointerdown', onPointer);
        window.removeEventListener('keydown', onKey, true);
      };
    }, [open]);

    const items = chipItems(ctx, snapshot.model);
    if (items.length === 0) return null;
    const now = clock();
    const time: ChipClock = { now, fresh: storeIsFresh(snapshot, now), heardAt: snapshot.heardAt };
    const words = chipWords(items, time, ctx.compact);
    const several = items.length > 1;
    const close = (returnFocus: boolean) => {
      setOpen(false);
      if (returnFocus) button.current?.focus();
    };
    const go = (path: string) => {
      close(false);
      api.navigate(path);
    };
    const project =
      (ctx.project === null
        ? null
        : snapshot.model?.projects.find((p) => p.root === ctx.project?.root)) ??
      items.find((item) => item.project !== null)?.project ??
      null;

    const row = (item: ChipItem): Node => {
      const status = itemStatus(item, time);
      const title = item.run?.title ?? null;
      const links: Node[] = [];
      const ownChat = item.ref.via === 'own-chat' ? item.ref.ownChatSessionId : null;
      if (ownChat !== null) {
        const route =
          item.run === null
            ? `/session?session=${encodeURIComponent(ownChat)}`
            : sessionRoute({ sessionId: ownChat, cwd: item.run.cwd });
        links.push(
          h(
            'button',
            { key: 'chat', type: 'button', style: LINK, onClick: () => go(route) },
            'Open its chat'
          )
        );
      }
      const url = webHref(item.run?.url);
      if (url !== null) {
        const tracker = item.project?.tracker?.label ?? 'the tracker';
        links.push(
          h(
            'a',
            {
              key: 'tracker',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: LINK,
              onClick: () => close(false),
            },
            `Open in ${tracker} ↗`
          )
        );
      }
      return h(
        'li',
        { key: item.ref.id, style: { ...ROW, flexWrap: 'wrap', listStyle: 'none' } },
        h('span', { style: GROW }, title === null ? item.ref.id : `${item.ref.id} ${title}`),
        status.kind === 'quiet'
          ? h('span', { style: PILL }, 'Last update ', h('span', { style: MUTED }, status.ago))
          : h(
              'span',
              { style: PILL },
              status.pill === 'done' && !several ? 'Merged · closed' : PILL_TEXT[status.pill]
            ),
        links.length === 0
          ? null
          : h(
              'span',
              {
                style: {
                  display: 'flex',
                  gap: '10px',
                  flexBasis: '100%',
                  justifyContent: 'flex-end',
                },
              },
              ...links
            )
      );
    };

    // The age moves every minute; the name says only that it has gone quiet,
    // so nothing re-reads it.
    const state = words.ago === null ? words.state : 'no recent update';
    const label = `${words.subject}, ${state}. Show ${several ? 'the items' : 'the item'}`;
    return h(
      'span',
      {
        ref: wrapper,
        className: 'flow-tab',
        style: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 },
        onBlur: (event: { relatedTarget: EventTarget | null }) => {
          const next = event.relatedTarget as globalThis.Node | null;
          if (open && (next === null || !wrapper.current?.contains(next))) setOpen(false);
        },
      },
      h('style', null, FOCUS_CSS),
      h(
        'button',
        {
          ref: button,
          type: 'button',
          style: CHIP,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': label,
          'aria-live': 'off',
          onClick: () => {
            setInPlace(insideMovedBox(button.current));
            setOpen((value: boolean) => !value);
          },
        },
        h('span', { style: SUBJECT }, words.subject),
        h('span', { 'aria-hidden': true }, '·'),
        h('span', null, words.state),
        words.ago === null ? null : h('span', { style: { opacity: 0.7 } }, words.ago),
        several && !ctx.compact ? h('span', { 'aria-hidden': true }, '▴') : null
      ),
      open
        ? h(
            'div',
            {
              ref: list,
              role: 'dialog',
              tabIndex: -1,
              'aria-label': several
                ? 'Items this chat is working on'
                : 'The item this chat is working on',
              style: inPlace
                ? { ...LIST, flexBasis: '100%', marginTop: '6px', maxWidth: `${LIST_WIDTH}px` }
                : {
                    ...LIST,
                    ...listPosition(
                      button.current?.getBoundingClientRect() ?? { top: 0, right: 0 },
                      { width: window.innerWidth, height: window.innerHeight }
                    ),
                  },
            },
            h('ul', { style: { margin: 0, padding: 0 } }, ...items.map(row)),
            pages && project !== null
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: { ...LINK, display: 'block', marginTop: '6px' },
                    onClick: () => go(projectPath(project.name)),
                  },
                  `Open ${project.name} in Flow →`
                )
              : null
          )
        : null
    );
  }
  return RunChip as ComponentType<StatusBarSlotContext>;
}

/**
 * Put the run chip in the status bar, where DorkOS has one for extensions.
 *
 * @param api - The host API.
 * @param store - The live store.
 * @returns A function that removes it.
 */
export function registerRunChip(
  api: Pick<ClientApi, 'navigate' | 'registerPage' | 'registerStatusBarItem'>,
  store: FlowStore
): () => void {
  if (typeof api.registerStatusBarItem !== 'function') return () => {};
  return api.registerStatusBarItem('run', createRunChip(api, store), {
    label: CHIP_LABEL,
    priority: CHIP_PRIORITY,
    when: chipWhen,
    urgent: chipUrgent,
  });
}
