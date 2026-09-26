/**
 * The `flow fleet` screen (spec `flow-usage` §2.6 "Human output"). A golden text
 * at a fixed clock pins every cell rule at once; the helper tests pin each rule's
 * edges so a golden change can be read.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_COLUMNS,
  age,
  bar,
  countdown,
  dorkosNote,
  place,
  renderFleet,
  runtimeTitle,
  spendCell,
} from '../../scripts/fleet/render.ts';
import { NOW, goldenModel } from './render-model.ts';

const GOLDEN = [
  'Claude Code               5-hour                       week',
  '  claude2       main      [####......]   41%  2h 14m   [#######...]   72%  3d 04h',
  '                          reserve 50%, seen 3m ago',
  '  claude3       rotation  [##########]   out  42m      [###.......]   31%  5d 11h',
  '                          limited (5-hour), seen 1h ago',
  '  claude4       kept-out  no reading                   [..........]    0%  reset',
  '                          kept out of all repos, seen 6d ago',
  '  spend-down12  rotation  [#.........]    5%  -        [##########]   out  10h 00m',
  '                          reserve 20% (0% now: spend-down), limited (week), seen <1m ago',
  '  Bad_Id        invalid id, not tracked',
  '',
  'Codex                     5-hour                       week',
  '  default       rotation  no reading                   [####......]   35%  4d 02h',
  '                          gpt-5.3-codex-spark 12%, plan pro, seen 5m ago',
  '',
  'OpenCode',
  '  default       rotation  $0.75 this month',
  '                          out (credits: openrouter), seen 20m ago',
  '',
  'Sessions',
  '  Claude Code',
  '    claude2  DOR-2369  busy         cli     1a2b3c4d  ~/…/spec-flow-usage                3h',
  '    claude2  -         idle         cli     2b3c4d5e  ~/Keep/dork-os/dorkos              <1m',
  '    claude2  DOR-2370  unseen       dorkos  5e4d3c2b  -                                  -',
  '    claude2  DOR-2371  parked       dorkos  6f5e4d3c  /srv/app                           2d',
  '    claude3  -         limited      cli     9f8e7d6c  ~/Keep/dork-os/dorkos              12m',
  '    claude3  DOR-2372  stale        cmux    a0b1c2d3  ~/wt                               5h',
  '    claude4  -         unknown      cli     b1c2d3e4  /tmp/x                             1m',
  '    ?        -         interrupted  dorkos  c2d3e4f5  /…/final-folder-name-that-is-long  -',
  '    ?        DOR-2373  unseen       ?       d3e4f5a6  -                                  -',
  '  Codex',
  '    default  -         busy         dorkos  e4f5a6b7  ~/Keep/app                         7m',
  '  OpenCode',
  '    default  DOR-2374  unseen       cli     f5a6b7c8  -                                  -',
  '',
  'Sessions on accounts flow does not know are not shown.',
  'DorkOS: not running at http://127.0.0.1:4242',
].join('\n');

describe('renderFleet', () => {
  it('draws the golden screen: expired, stale, rejected, no reading, spend-down, invalid id, unknown account, every state', () => {
    // Purpose: one fixed clock pins bars, percents, countdowns, notes, places and ages together.
    expect(renderFleet(goldenModel(), NOW)).toBe(GOLDEN);
  });

  it('keeps every line within 100 columns with a 12-character id', () => {
    // Purpose: the spec caps the screen at 100 columns; long notes must move to their own line.
    const lines = renderFleet(goldenModel(), NOW).split('\n');
    expect(goldenModel().accounts.some((a) => a.id.length === 12)).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_COLUMNS);
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  });

  it('keeps notes on the bar line when every row fits', () => {
    // Purpose: short notes stay beside the bars, as the spec's example shows.
    const model = goldenModel();
    model.accounts = [
      { ...model.accounts[0], reservePct: 0, effectiveReservePct: 0 },
      { ...model.accounts[1], windows: { five_hour: model.accounts[1].windows.seven_day } },
    ];
    const text = renderFleet(model, NOW);
    expect(text.split('\n').slice(0, 3)).toEqual([
      'Claude Code          5-hour                       week',
      '  claude2  main      [####......]   41%  2h 14m   [#######...]   72%  3d 04h   seen 3m ago',
      '  claude3  rotation  [###.......]   31%  5d 11h   no reading                   seen 1h ago',
    ]);
  });

  it('says so when there are no accounts and no sessions, and always prints the footer', () => {
    // Purpose: the two empty cases each have one plain line, and the footer never disappears.
    const model = goldenModel();
    model.accounts = [];
    model.sessions = [];
    model.dorkos = null;
    expect(renderFleet(model, NOW)).toBe(
      [
        'No accounts registered. Add one: flow accounts add --path ~/.claude',
        '',
        'Sessions: none running',
        '',
        'Sessions on accounts flow does not know are not shown.',
      ].join('\n')
    );
  });
});

describe('cell helpers', () => {
  it('fills the bar by rounded tenths', () => {
    // Purpose: 44% is four cells, 45% five, and the bar never overflows.
    expect(bar(0)).toBe('[..........]');
    expect(bar(44)).toBe('[####......]');
    expect(bar(45)).toBe('[#####.....]');
    expect(bar(100)).toBe('[##########]');
  });

  it('counts down in the four spec forms, and says reset or - at the edges', () => {
    // Purpose: each countdown form switches at its boundary.
    const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
    expect(countdown(null, NOW)).toBe('-');
    expect(countdown(at(0), NOW)).toBe('reset');
    expect(countdown(at(59_000), NOW)).toBe('<1m');
    expect(countdown(at(42 * 60_000), NOW)).toBe('42m');
    expect(countdown(at(134 * 60_000), NOW)).toBe('2h 14m');
    expect(countdown(at((3 * 24 + 4) * 3_600_000), NOW)).toBe('3d 04h');
  });

  it('gives ages in one coarse unit', () => {
    // Purpose: "seen 3m ago" and a session's age read at a glance.
    const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
    expect(age(null, NOW)).toBe('-');
    expect(age(ago(30_000), NOW)).toBe('<1m');
    expect(age(ago(12 * 60_000), NOW)).toBe('12m');
    expect(age(ago(3 * 3_600_000), NOW)).toBe('3h');
    expect(age(ago(6 * 86_400_000), NOW)).toBe('6d');
  });

  it('shows the home folder as ~ and cuts long places from the left', () => {
    // Purpose: the place column never exceeds 34 characters and keeps the folder that names the work.
    expect(place(null, '/home/x')).toBe('-');
    expect(place('/home/x', '/home/x')).toBe('~');
    expect(place('/home/xy/repo', '/home/x')).toBe('/home/xy/repo');
    expect(place('/home/x/Keep/dork-os/marketplace/spec-flow-usage', '/home/x')).toBe(
      '~/…/marketplace/spec-flow-usage'
    );
    const long = place(`/a/${'z'.repeat(50)}`, '/home/x');
    expect(long).toHaveLength(34);
    expect(long.startsWith('…')).toBe(true);
  });

  it('writes the DorkOS note only for what is known', () => {
    // Purpose: not running, running with nothing live, and silence when rows came or it errored.
    const url = 'http://127.0.0.1:4242';
    expect(dorkosNote(null, false)).toBeNull();
    expect(dorkosNote({ url, reachable: false, sessionsShown: 0 }, false)).toBe(
      `DorkOS: not running at ${url}`
    );
    expect(dorkosNote({ url, reachable: true, sessionsShown: 0 }, true)).toBe(
      `DorkOS: running at ${url}, no live sessions`
    );
    expect(dorkosNote({ url, reachable: true, sessionsShown: 2 }, true)).toBeNull();
    // A 401: reachable, but its answer was not a list. The warning speaks; the note does not.
    expect(dorkosNote({ url, reachable: true, sessionsShown: 0 }, false)).toBeNull();
  });
});

describe('the runtime cells', () => {
  it("shows this month's spend, and $0.00 for a reading from an earlier month", () => {
    // Purpose: a spend reading never goes stale, so last month's total must not read as this month's.
    const spend = {
      periodStart: '2026-09-01T00:00:00.000Z',
      costUsd: 0.7504,
      limitUsd: null,
      observedAt: '2026-09-20T00:00:00.000Z',
      source: 'transcript' as const,
    };
    expect(spendCell(spend, NOW)).toBe('$0.75 this month');
    expect(spendCell(spend, '2026-10-02T00:00:00.000Z')).toBe('$0.00 this month');
    expect(spendCell(null, NOW)).toBe('no spend recorded');
  });

  it('names each runtime, and keeps an unknown one as it is', () => {
    // Purpose: a DorkOS runtime flow does not know still gets a heading.
    expect(['claude-code', 'codex', 'opencode', 'test-mode'].map(runtimeTitle)).toEqual([
      'Claude Code',
      'Codex',
      'OpenCode',
      'test-mode',
    ]);
  });
});
