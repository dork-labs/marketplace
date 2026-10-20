import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { activate } from '../../index.ts';
import type { BoardView, HistoryEntry } from '../../lib/board-service.ts';
import { parseRoadmap, type Board } from '../../lib/roadmap.ts';
import type { PanelConfig } from '../../server.ts';
import { RoadmapIcon } from '../icon.ts';
import { createPanel, type PanelDeps, type PanelHostApi } from '../panel.ts';
import { h } from '../react.ts';
import { itemsOf, sampleText } from '../../__tests__/fixtures/roadmap.ts';

const NOW = new Date('2030-01-15T12:00:00Z');

function board(edit?: (doc: Record<string, unknown>) => void): Board {
  const parsed = parseRoadmap(sampleText(edit));
  if (!parsed.ok) throw new Error('fixture');
  return parsed.board;
}

function entry(sha: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    sha,
    parentSha: null,
    url: `https://github.com/acme/plans/commit/${sha}`,
    author: 'chef',
    date: '2030-01-15T10:00:00Z',
    reason: 'Fridge first',
    changes: [
      {
        kind: 'moved',
        id: '01HZZZZZZZZZZZZZZZZZZZZZA3',
        title: 'Fridge inventory by smell',
        from: 'next',
        to: 'now',
      },
    ],
    ...extra,
  };
}

function view(extra: Partial<BoardView> = {}): BoardView {
  const history = extra.history ?? [
    entry('2'.repeat(40)),
    entry('1'.repeat(40), { changes: [{ kind: 'created' }], reason: null }),
  ];
  return {
    status: 'ok',
    repo: 'acme/plans',
    board: board(),
    skipped: [],
    stale: false,
    asOf: '2030-01-15T11:58:00Z',
    head: history[0] ?? null,
    revision: history[0]?.sha ?? null,
    history,
    parseError: null,
    problem: null,
    tokenExpiresAt: '2030-03-01T00:00:00Z',
    fileUrl: 'https://github.com/acme/plans/blob/main/roadmap/roadmap.json',
    checkedAt: '2030-01-15T12:00:00Z',
    ...extra,
  };
}

function host(): PanelHostApi & {
  navigate: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  return { navigate: vi.fn(), notify: vi.fn() };
}

const CONFIG: PanelConfig = { deciderName: 'Sam', keeperHandle: 'plan-keeper', prRepo: null };

async function mount(first: BoardView, deps: Partial<PanelDeps> = {}, api = host()) {
  const getBoard = vi.fn(async () => first);
  const Panel = createPanel(api, {
    getBoard,
    getConfig: async () => CONFIG,
    getSeen: async () => null,
    putSeen: async () => {},
    now: () => NOW,
    visible: () => true,
    ...deps,
  });
  const utils = render(h(Panel));
  await act(async () => {});
  return { ...utils, getBoard, api };
}

describe('activate', () => {
  it('adds one Roadmap tab that shows nowhere until someone picks a room', () => {
    const remove = vi.fn();
    const registerComponent = vi.fn(() => remove);
    const cleanup = activate({ ...host(), registerComponent });
    expect(registerComponent).toHaveBeenCalledWith('right-panel', 'board', expect.any(Function), {
      label: 'Roadmap',
      icon: RoadmapIcon,
      showIn: { rooms: [] },
    });
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('the panel', () => {
  it('draws the decisions lane first, then the feed, then Now, Next and Later', async () => {
    const { container } = await mount(view());
    const heads = [...container.querySelectorAll('h3')].map((el) => el.textContent);
    expect(heads[0]).toMatch(/^Needs Sam2/);
    expect(heads[1]).toMatch(/^Recent changes/);
    expect(heads.slice(2).map((t) => t!.replace(/\d+$/, '').replace(/[▸▾ ]/g, ''))).toEqual([
      'Now',
      'Next',
      'Later',
    ]);
    // Later starts folded; the shipped bet is not on the board.
    expect(screen.queryByText('Self-folding laundry')).toBeNull();
    expect(screen.queryByText('The old blender')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    expect(screen.getByText('Self-folding laundry')).toBeTruthy();
  });

  it('RM-1: the decisions lane only links to where an ask is answered', async () => {
    const { api, container } = await mount(view());
    const lane = container.querySelector('[aria-labelledby="rm-needs-h"]') as HTMLElement;
    const buttons = within(lane)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(buttons).toEqual(['Find the approval on Home →', 'Answer in the thread →']);
    expect(lane.textContent).not.toMatch(/\b(approve|deny|yes|no)\b/i);
    fireEvent.click(within(lane).getByText('Answer in the thread →'));
    expect(api.navigate).toHaveBeenLastCalledWith(
      '/channels?id=01HZZZZZZZZZZZZZZZZZZZZZR1&thread=01HZZZZZZZZZZZZZZZZZZZZZE1'
    );
    fireEvent.click(within(lane).getByText('Find the approval on Home →'));
    expect(api.navigate).toHaveBeenLastCalledWith('/');
  });

  it('marks an ask past its date in red', async () => {
    await mount(
      view({
        board: board((doc) => {
          (itemsOf(doc)[0]!.needs as Record<string, unknown>[])[0]!.by = '2030-01-10';
        }),
      })
    );
    expect(screen.getByText(/Was due Jan 10/).className).toContain('rm-red');
  });

  it('RM-3: every change shows its author and its reason, or "No reason given"', async () => {
    await mount(view());
    expect(screen.getAllByText('@chef').length).toBeGreaterThan(0);
    expect(screen.getByText('“Fridge first”')).toBeTruthy();
    expect(screen.getByText('No reason given')).toBeTruthy();
  });

  it('shows commit text as text: no markup, no links but the commit', async () => {
    const hostile = entry('3'.repeat(40), {
      author: '<b>chef</b>',
      reason: '<img src=x onerror=alert(1)> [click](https://evil.example) https://evil.example',
    });
    const { container } = await mount(view({ history: [hostile] }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((href) => href?.includes('evil'))).toBe(false);
    expect(screen.getByText(/onerror=alert/)).toBeTruthy();
  });

  it('RM-4: a change that lands while you look waits behind a pill until Show', async () => {
    const next = view({
      board: board((doc) => {
        itemsOf(doc)[2]!.horizon = 'now';
      }),
      history: [entry('4'.repeat(40)), entry('2'.repeat(40)), entry('1'.repeat(40))],
    });
    const getBoard = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(next);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { container } = await mount(view(), { getBoard });
      const now = () => container.querySelector('[aria-labelledby="rm-col-now"]')!.textContent;
      expect(now()).not.toContain('Fridge inventory');
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText('@chef moved 1 card')).toBeTruthy();
      expect(now()).not.toContain('Fridge inventory');
      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(now()).toContain('Fridge inventory');
      expect(screen.queryByText('@chef moved 1 card')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('RM-5: a file that stops parsing keeps the last good board, dimmed, under one banner', async () => {
    const { container } = await mount(
      view({
        status: 'invalid',
        stale: true,
        parseError: { message: "line 4: unexpected '}'", line: 4 },
      })
    );
    expect(screen.getByText("roadmap.json doesn't parse · line 4: unexpected '}'")).toBeTruthy();
    expect(screen.getByText(/Showing the last good version/)).toBeTruthy();
    expect(container.querySelector('.rm-dim')).not.toBeNull();
    expect(screen.getByText('Teach the kettle to whistle in tune')).toBeTruthy();
  });

  it('says GitHub access expired, by date, and who can reconnect it, never the 401', async () => {
    const { container } = await mount(
      view({
        status: 'auth-expired',
        stale: true,
        problem: 'GitHub refused (401)',
        tokenExpiresAt: '2030-01-14T00:00:00Z',
      })
    );
    expect(screen.getByText('GitHub access expired on Jan 14.')).toBeTruthy();
    expect(container.textContent).toContain("Sam can reconnect it in the extension's settings.");
    expect(container.textContent).not.toContain('401');
    expect(container.querySelector('.rm-dim')).not.toBeNull();
  });

  it('says access stopped working on a 401 before the expiry date', async () => {
    const { container } = await mount(
      view({ status: 'auth-failed', stale: true, problem: 'GitHub refused (401)' })
    );
    expect(screen.getByText('GitHub access stopped working.')).toBeTruthy();
    expect(container.textContent).not.toContain('401');
  });

  it('warns quietly in the week before the token expires', async () => {
    const { container } = await mount(view({ tokenExpiresAt: '2030-01-18T12:00:00Z' }));
    expect(container.textContent).toContain('GitHub access expires in 3 days');
  });

  it('asks to connect GitHub when there is no token', async () => {
    await mount(view({ status: 'no-token', board: null, history: [] }));
    expect(screen.getByText('Connect GitHub to load the roadmap')).toBeTruthy();
    expect(
      screen.getByText("Sam can add a GitHub token in the extension's settings.")
    ).toBeTruthy();
  });

  it('offers to ask the keeper or copy a starter file when there is no roadmap yet', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const { api } = await mount(view({ status: 'no-file', board: null, history: [] }));
    expect(screen.getByText('No roadmap here yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask @plan-keeper' }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('@plan-keeper could you start the roadmap? ');
    expect(api.notify).toHaveBeenCalled();
  });

  it('"Ask in this room" copies a message and moves nothing', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const getBoard = vi.fn(async () => view());
    await mount(view(), { getBoard });
    const calls = getBoard.mock.calls.length;
    fireEvent.click(
      screen.getByRole('button', { name: 'More for Teach the kettle to whistle in tune' })
    );
    const item = screen.getByRole('menuitem', { name: 'Ask in this room' });
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(
      '@plan-keeper move "Teach the kettle to whistle in tune" to … because …'
    );
    expect(getBoard.mock.calls.length).toBe(calls);
  });

  it('opens a card with Enter or a click to show why, its fields and its links', async () => {
    await mount(view());
    fireEvent.click(screen.getByRole('button', { name: 'Teach the kettle to whistle in tune' }));
    expect(screen.getByText('Every morning starts with a flat note.')).toBeTruthy();
    const link = screen.getByText('Notes ↗') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.com/kettle');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('TEA-12').tagName).toBe('SPAN');
  });

  it('marks a card moved since you last looked, and Mark seen saves the newest commit', async () => {
    const putSeen = vi.fn(async () => {});
    const { container } = await mount(
      view({ board: board((doc) => void (itemsOf(doc)[2]!.horizon = 'now')) }),
      { getSeen: async () => '1'.repeat(40), putSeen }
    );
    expect(container.querySelector('[data-new]')!.textContent).toContain('moved it here 2h ago');
    expect(screen.getByText(/^Since you last looked/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark seen' }));
    expect(putSeen).toHaveBeenCalledWith('2'.repeat(40));
  });

  it('holds a changed board behind the pill even when its commit is unknown', async () => {
    const next = view({
      board: board((doc) => void (itemsOf(doc)[2]!.horizon = 'now')),
      history: [],
      revision: null,
      head: null,
    });
    const getBoard = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(next);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { container } = await mount(view(), { getBoard });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByText('The roadmap changed')).toBeTruthy();
      const now = container.querySelector('[aria-labelledby="rm-col-now"]')!.textContent;
      expect(now).not.toContain('Fridge inventory');
    } finally {
      vi.useRealTimers();
    }
  });

  it('links a bare PR number only when a PR repo is set', async () => {
    const withPr = view({
      board: board((doc) => void (itemsOf(doc)[0]!.links = [{ kind: 'pr', ref: '42' }])),
    });
    await mount(withPr, { getConfig: async () => ({ ...CONFIG, prRepo: 'acme/app' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Teach the kettle to whistle in tune' }));
    expect(screen.getByText('42 ↗').getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/42'
    );
  });

  it('closes the card menu when focus leaves it', async () => {
    await mount(view());
    fireEvent.click(
      screen.getByRole('button', { name: 'More for Teach the kettle to whistle in tune' })
    );
    const item = screen.getByRole('menuitem', { name: 'Ask in this room' });
    fireEvent.blur(item, { relatedTarget: document.body });
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('shows the first twelve cards of a long column and offers the rest', async () => {
    const many = board((doc) => {
      const items = itemsOf(doc);
      for (let i = 0; i < 15; i += 1) {
        items.push({
          ...items[2],
          id: `01HZZZZZZZZZZZZZZZZZZZZB${String(i).padStart(2, '0')}`,
          title: `Bet ${i}`,
        });
      }
    });
    await mount(view({ board: many }));
    expect(screen.getByRole('button', { name: 'Show 4 more' })).toBeTruthy();
  });

  it('lists skipped items by id and reason', async () => {
    await mount(
      view({ skipped: [{ id: '01HZZZZZZZZZZZZZZZZZZZZZQ1', reason: 'has no horizon' }] })
    );
    expect(screen.getByText('1 item skipped')).toBeTruthy();
    expect(screen.getByText('01HZZZ… has no horizon')).toBeTruthy();
  });
});
