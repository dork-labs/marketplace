/**
 * The run chip (spec `flow-multiproject` §6, V5 B): `when` and `urgent` read
 * only the context core hands them; one item reads "DOR-2387 · Building" and
 * several read "3 items · 1 needs you" by the urgency order; Building goes
 * quiet after an hour and Needs you never does; flow's news older than five
 * minutes shows as such; done words; the phone drops the title; the list
 * offers "Open its chat" only for an item in its own chat, and the project in
 * Flow only where flow has pages.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowModel } from '../../lib/model.ts';
import type { StatusBarSlotContext, TrackerItemRef } from '../../lib/host-types.ts';
import {
  CHIP_LABEL,
  CHIP_PRIORITY,
  ageText,
  chipItems,
  chipUrgent,
  chipWhen,
  chipWords,
  createRunChip,
  listPosition,
  pillFromCore,
  registerRunChip,
  type ChipClock,
} from '../run-chip.ts';
import { FlowStore, STALE_STORE_MS } from '../store.ts';
import { flowModel, flowProject, runRow } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const FRESH: ChipClock = { now: NOW, fresh: true, heardAt: NOW };

/** One of core's tracker items. */
function item(id: string, extra: Partial<TrackerItemRef> = {}): TrackerItemRef {
  return {
    id,
    stage: 'execute',
    runStatus: 'running',
    startedAt: '2026-09-28T11:00:00.000Z',
    via: 'this-chat',
    ownChatSessionId: null,
    ...extra,
  };
}

/** A chat's status-bar context in dorkos. */
function ctx(
  items: TrackerItemRef[],
  extra: Partial<StatusBarSlotContext> = {}
): StatusBarSlotContext {
  return {
    sessionId: 's-chat',
    cwd: '/work/dorkos',
    project: { root: '/work/dorkos', name: 'dorkos' },
    trackerItems: items,
    compact: false,
    ...extra,
  };
}

/** Minutes before NOW, as ISO. */
function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

describe('when and urgent', () => {
  it('shows only for a chat with items, and is urgent only for an item waiting on a person', () => {
    expect(chipWhen(ctx([]))).toBe(false);
    expect(chipWhen(ctx([item('DOR-1')]))).toBe(true);
    expect(chipUrgent(ctx([item('DOR-1')]))).toBe(false);
    expect(chipUrgent(ctx([item('DOR-1'), item('DOR-2', { stage: 'review' })]))).toBe(true);
    expect(chipUrgent(ctx([item('DOR-1', { runStatus: 'waiting_for_review' })]))).toBe(true);
  });

  it('reads nothing but the context: a frozen context, no store and no fetch', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const frozen = Object.freeze(
      ctx(Object.freeze([Object.freeze(item('DOR-1', { stage: 'review' }))]) as never)
    );
    expect(chipWhen(frozen)).toBe(true);
    expect(chipUrgent(frozen)).toBe(true);
    expect(chipWhen(frozen)).toBe(chipWhen(frozen));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the words', () => {
  const model = (runs: ReturnType<typeof runRow>[]): FlowModel =>
    flowModel([flowProject('dorkos', { runs })]);

  it('names one item with its title and state; the phone drops the title', () => {
    const items = chipItems(
      ctx([item('DOR-2387')]),
      model([runRow('DOR-2387', { title: 'Out-of-usage banner', updatedAt: ago(5) })])
    );
    expect(chipWords(items, FRESH, false)).toEqual({
      subject: 'DOR-2387 Out-of-usage banner',
      state: 'Building',
      ago: null,
    });
    expect(chipWords(items, FRESH, true).subject).toBe('DOR-2387');
  });

  it('counts several items and names the most urgent state', () => {
    const runs = [
      runRow('DOR-1', { state: 'in-review' }),
      runRow('DOR-2', { state: 'building', updatedAt: ago(1) }),
      runRow('DOR-3', { state: 'needs-you' }),
      runRow('DOR-4', { state: 'parked' }),
    ];
    const all = ctx(runs.map((run) => item(run.identifier)));
    expect(chipWords(chipItems(all, model(runs)), FRESH, false)).toEqual({
      subject: '4 items',
      state: '1 needs you',
      ago: null,
    });
    expect(chipWords(chipItems(all, model(runs)), FRESH, true).state).toBe('Needs you');
    const calmer = runs.filter((run) => run.state !== 'needs-you');
    expect(
      chipWords(chipItems(ctx(calmer.map((r) => item(r.identifier))), model(calmer)), FRESH, false)
        .state
    ).toBe('1 parked');
    const building = [
      runRow('DOR-5', { updatedAt: ago(1) }),
      runRow('DOR-6', { updatedAt: ago(2) }),
      runRow('DOR-7', { state: 'in-review' }),
    ];
    expect(
      chipWords(
        chipItems(ctx(building.map((r) => item(r.identifier))), model(building)),
        FRESH,
        false
      ).state
    ).toBe('2 building');
  });

  it('says "Merged · closed" for one done item and "Done" when all of several are', () => {
    const one = [runRow('DOR-1', { state: 'done' })];
    expect(chipWords(chipItems(ctx([item('DOR-1')]), model(one)), FRESH, false).state).toBe(
      'Merged · closed'
    );
    const two = [runRow('DOR-1', { state: 'done' }), runRow('DOR-2', { state: 'done' })];
    expect(
      chipWords(chipItems(ctx([item('DOR-1'), item('DOR-2')]), model(two)), FRESH, false).state
    ).toBe('Done');
  });

  it('goes quiet after an hour for Building, not at 59 minutes, and never for Needs you', () => {
    const at = (minutes: number, state: 'building' | 'needs-you' = 'building') =>
      chipWords(
        chipItems(
          ctx([item('DOR-1')]),
          model([runRow('DOR-1', { state, updatedAt: ago(minutes) })])
        ),
        FRESH,
        false
      );
    expect(at(59)).toMatchObject({ state: 'Building', ago: null });
    expect(at(61)).toMatchObject({ state: 'Last update', ago: '1h ago' });
    expect(at(600, 'needs-you')).toMatchObject({ state: 'Needs you', ago: null });
  });

  it('says how old flow’s news is when the store has heard nothing for five minutes', () => {
    const items = chipItems(ctx([item('DOR-1')]), model([runRow('DOR-1', { state: 'needs-you' })]));
    const stale: ChipClock = { now: NOW, fresh: false, heardAt: NOW - STALE_STORE_MS - 60_000 };
    expect(chipWords(items, stale, false)).toMatchObject({ state: 'Last update', ago: '6m ago' });
    expect(chipWords([...items, ...items], stale, false)).toMatchObject({
      subject: '2 items',
      state: 'Last update',
    });
  });

  it('shows an item the store does not know by its id and core’s facts, never a stage name', () => {
    const items = chipItems(
      ctx([item('DOR-9', { stage: 'review', runStatus: 'running' })]),
      model([])
    );
    expect(items[0].run).toBeNull();
    expect(chipWords(items, FRESH, false)).toMatchObject({ subject: 'DOR-9', state: 'In review' });
    expect(pillFromCore(item('x', { runStatus: 'complete' }))).toBe('done');
    expect(pillFromCore(item('x', { runStatus: 'waiting_for_review' }))).toBe('needs-you');
    expect(pillFromCore(item('x', { stage: 'execute' }))).toBe('building');
  });

  it('prefers the run in the chat’s own project over one of the same id elsewhere', () => {
    const models = flowModel([
      flowProject('blintz', { runs: [runRow('X-1', { state: 'parked' })] }),
      flowProject('dorkos', { runs: [runRow('X-1', { state: 'in-review' })] }),
    ]);
    expect(chipItems(ctx([item('X-1')]), models)[0].pill).toBe('in-review');
  });

  it('writes ages briefly', () => {
    expect(ageText(10_000)).toBe('just now');
    expect(ageText(45 * 60_000)).toBe('45m ago');
    expect(ageText(2 * 3_600_000)).toBe('2h ago');
    expect(ageText(3 * 86_400_000)).toBe('3d ago');
  });

  it('opens the list upward and keeps it on a phone’s screen', () => {
    expect(listPosition({ top: 700, right: 390 }, { width: 390, height: 740 })).toEqual({
      position: 'fixed',
      left: '82px',
      bottom: '46px',
      width: '300px',
    });
    expect(listPosition({ top: 700, right: 280 }, { width: 300, height: 740 })).toMatchObject({
      left: '8px',
      width: '284px',
    });
  });
});

describe('the chip', () => {
  /** A store holding `model`, heard from just now. */
  function storeWith(model: FlowModel) {
    const store = new FlowStore({}, () => NOW);
    store.apply(model);
    return store;
  }

  it('opens a list with "Open its chat" only for an item in its own chat, and the project in Flow', async () => {
    const model = flowModel([
      flowProject('dorkos', {
        tracker: { label: 'Linear', team: 'DOR', url: null },
        runs: [
          runRow('DOR-1', {
            title: 'Keep the old API?',
            state: 'needs-you',
            cwd: '/wt/1',
            url: 'https://linear.app/x/DOR-1',
          }),
          runRow('DOR-2', { title: 'Banner', updatedAt: ago(1) }),
        ],
      }),
    ]);
    const api = { navigate: vi.fn(), registerPage: vi.fn() };
    const Chip = createRunChip(api, storeWith(model), () => NOW);
    render(
      React.createElement(
        Chip,
        ctx([item('DOR-1', { via: 'own-chat', ownChatSessionId: 's-own' }), item('DOR-2')])
      )
    );
    const chip = screen.getByRole('button', { name: /^2 items, 1 needs you/ });
    expect(chip.textContent).toContain('▴');
    fireEvent.click(chip);
    const list = screen.getByRole('dialog', { name: 'Items this chat is working on' });
    expect(list.textContent).toContain('DOR-1 Keep the old API?');
    expect(screen.getAllByRole('button', { name: 'Open its chat' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open in Linear ↗' }).getAttribute('href')).toBe(
      'https://linear.app/x/DOR-1'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open its chat' }));
    expect(api.navigate).toHaveBeenLastCalledWith('/session?session=s-own&dir=%2Fwt%2F1');
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Open dorkos in Flow →' }));
    expect(api.navigate).toHaveBeenLastCalledWith('/x/flow/p/dorkos');
    await act(async () => {});
  });

  it('closes on Escape and gives focus back to the chip', () => {
    const model = flowModel([
      flowProject('dorkos', { runs: [runRow('DOR-1', { updatedAt: ago(1) })] }),
    ]);
    const Chip = createRunChip({ navigate: vi.fn() }, storeWith(model), () => NOW);
    render(React.createElement(Chip, ctx([item('DOR-1')])));
    const chip = screen.getByRole('button', { name: /^DOR-1, Building/ });
    fireEvent.click(chip);
    const list = screen.getByRole('dialog');
    expect(screen.queryByRole('button', { name: /in Flow/ })).toBeNull();
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('draws nothing for a chat with no items', () => {
    const Chip = createRunChip({ navigate: vi.fn() }, storeWith(flowModel([])), () => NOW);
    const { container } = render(React.createElement(Chip, ctx([])));
    expect(container.textContent).toBe('');
  });
});

describe('registerRunChip', () => {
  it('adds one status-bar item with pure when and urgent', () => {
    const registerStatusBarItem = vi.fn(() => () => {});
    registerRunChip({ navigate: vi.fn(), registerStatusBarItem }, new FlowStore({}));
    expect(registerStatusBarItem).toHaveBeenCalledWith('run', expect.any(Function), {
      label: CHIP_LABEL,
      priority: CHIP_PRIORITY,
      when: chipWhen,
      urgent: chipUrgent,
    });
  });

  it('adds nothing on a DorkOS without a status bar for extensions', () => {
    expect(() => registerRunChip({ navigate: vi.fn() }, new FlowStore({}))()).not.toThrow();
  });
});
