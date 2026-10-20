import { describe, expect, it } from 'vitest';
import type { BoardView, HistoryEntry } from '../lib/board-service.ts';
import { parseRoadmap, type Board } from '../lib/roadmap.ts';
import {
  ago,
  changeParts,
  entriesSince,
  expiryWarning,
  laneCards,
  linkHref,
  milestoneParts,
  pillText,
  placedBy,
  reconnectLine,
  subline,
  targetLabel,
  threadPath,
  who,
} from '../ui/format.ts';
import { sampleText } from './fixtures/roadmap.ts';

const NOW = new Date('2030-01-15T12:00:00Z');

function board(): Board {
  const parsed = parseRoadmap(sampleText());
  if (!parsed.ok) throw new Error('fixture');
  return parsed.board;
}

function entry(sha: string, author: string, changes: HistoryEntry['changes']): HistoryEntry {
  return {
    sha,
    parentSha: null,
    url: null,
    author,
    date: '2030-01-15T10:00:00Z',
    reason: null,
    changes,
  };
}

const moved = (id: string): HistoryEntry['changes'][number] => ({
  kind: 'moved',
  id,
  title: 't',
  from: 'next',
  to: 'now',
});

describe('format', () => {
  it('says how long ago, short', () => {
    expect(ago('2030-01-15T11:59:30Z', NOW)).toBe('just now');
    expect(ago('2030-01-15T11:15:00Z', NOW)).toBe('45m');
    expect(ago('2030-01-15T10:00:00Z', NOW)).toBe('2h');
    expect(ago('2030-01-12T12:00:00Z', NOW)).toBe('3d');
  });

  it('shows a handle as @handle and a name as it is', () => {
    expect(who('kettle-bot')).toBe('@kettle-bot');
    expect(who('Sam Lee')).toBe('Sam Lee');
  });

  it('reads a milestone target as its date', () => {
    expect(targetLabel('milestone:beta', board())).toBe('Mar 2');
    expect(targetLabel('2030-02-14', board())).toBe('Feb 14');
    expect(targetLabel('milestone:gone', board())).toBeNull();
    expect(targetLabel(null, board())).toBeNull();
  });

  it('counts down to each milestone', () => {
    expect(milestoneParts(board(), NOW).map((m) => m.countdown)).toEqual(['46d', '116d']);
  });

  it('orders the asks by their due date', () => {
    expect(laneCards(board()).map((c) => c.need.by)).toEqual(['2030-01-20', '2030-02-01']);
  });

  it('turns changes into sentences that never say an ask was answered', () => {
    expect(changeParts(moved('x'), null)).toEqual({
      before: 'moved',
      title: 't',
      after: ' Next → Now',
    });
    expect(changeParts({ kind: 'asked', id: 'x', title: 't', ask: 'Pick one' }, 'Sam')).toEqual({
      before: 'asked Sam about',
      title: 't',
      after: ': Pick one',
    });
    const removed = changeParts({ kind: 'ask-removed', id: 'x', title: 't', ask: 'Pick' }, null);
    expect(`${removed.before} ${removed.after}`).not.toMatch(/approv|answer|yes|grant/i);
  });

  it('lists what changed since a revision', () => {
    const history = [entry('3', 'a', []), entry('2', 'a', []), entry('1', 'a', [])];
    expect(entriesSince(history, '2').map((e) => e.sha)).toEqual(['3']);
    expect(entriesSince(history, null)).toHaveLength(3);
    expect(entriesSince(history, 'gone')).toHaveLength(3);
  });

  it('words the pill for one author, several, and none named', () => {
    expect(pillText([entry('2', 'chef', [moved('a')]), entry('1', 'chef', [moved('b')])])).toBe(
      '@chef moved 2 cards'
    );
    expect(
      pillText([
        entry('2', 'chef', [moved('a')]),
        entry('1', 'nose', [{ kind: 'moscow', id: 'b', title: 't', to: 'could' }]),
      ])
    ).toBe('2 people changed 2 cards');
    expect(pillText([entry('2', 'chef', []), entry('1', 'chef', [{ kind: 'milestones' }])])).toBe(
      '@chef changed the roadmap'
    );
  });

  it('marks a card with the newest commit that placed it', () => {
    const newest = entry('2', 'chef', [moved('a')]);
    const placed = placedBy([newest, entry('1', 'nose', [moved('a')])]);
    expect(placed.get('a')).toBe(newest);
  });

  it('warns in the last week before the token expires, and not before', () => {
    expect(expiryWarning('2030-01-25T12:00:00Z', NOW)).toBeNull();
    expect(expiryWarning('2030-01-22T12:00:00Z', NOW)).toBe('GitHub access expires in 7 days');
    expect(expiryWarning('2030-01-15T20:00:00Z', NOW)).toBe('GitHub access expires within a day');
    expect(expiryWarning('2030-01-14T12:00:00Z', NOW)).toBeNull();
    expect(expiryWarning(null, NOW)).toBeNull();
  });

  it('gives everyone the same reconnect line', () => {
    expect(reconnectLine('Sam')).toBe("Sam can reconnect it in the extension's settings.");
    expect(reconnectLine(null)).toBe("The owner can reconnect it in the extension's settings.");
  });

  it('says the board went quiet after a week', () => {
    const view = {
      repo: 'acme/plans',
      board: board(),
      head: {
        sha: '1',
        parentSha: null,
        url: null,
        author: 'chef',
        date: '2030-01-06T12:00:00Z',
        reason: null,
      },
    } as BoardView;
    expect(subline(view, NOW)).toEqual({ stale: true, text: 'Last changed 9 days ago by @chef' });
    view.head!.date = '2030-01-15T10:00:00Z';
    expect(subline(view, NOW)).toEqual({
      stale: false,
      text: 'roadmap.json in acme/plans · changed 2h ago by @chef · 4 bets',
    });
  });

  it('links only to in-app threads and https pages', () => {
    expect(threadPath({ roomId: 'R1', entryId: 'E1' })).toBe('/channels?id=R1&thread=E1');
    expect(linkHref({ kind: 'pr', ref: '42', label: null }, 'acme/app')).toBe(
      'https://github.com/acme/app/pull/42'
    );
    expect(linkHref({ kind: 'pr', ref: 'acme/x#7', label: null }, 'acme/app')).toBe(
      'https://github.com/acme/x/pull/7'
    );
    expect(linkHref({ kind: 'url', ref: 'https://example.com', label: null }, 'a/b')).toBe(
      'https://example.com'
    );
    expect(linkHref({ kind: 'pr', ref: '42', label: null }, null)).toBeNull();
    expect(linkHref({ kind: 'linear', ref: 'TEA-12', label: null }, 'a/b')).toBeNull();
    expect(linkHref({ kind: 'doc', ref: 'docs/x.md', label: null }, 'a/b')).toBeNull();
  });
});
