/**
 * The near-duplicate rule `flow create` refuses on (DOR-4546), tried on
 * real-looking pairs of titles: rewordings of one report match, items that
 * only share a theme do not. Every title here is made up.
 */

import { describe, expect, it } from 'vitest';

import {
  NEAR_MATCH,
  isNearMatch,
  nearMatches,
  titleSimilarity,
  titleWords,
} from '../scripts/duplicate-title.ts';

describe('titleWords', () => {
  it('drops filler, one-letter words and a capture tag, and folds plurals', () => {
    expect([...titleWords("Fix the room times in the person's clock [acme/app#7]")]).toEqual([
      'room',
      'time',
      'person',
      'clock',
    ]);
    expect([...titleWords('Status of the analysis pages')]).toEqual(['status', 'analysis', 'page']);
  });
});

describe('isNearMatch', () => {
  it.each([
    ['Export the monthly report as CSV', 'Let people export the monthly report as a CSV file'],
    [
      'Room times show in UTC instead of the person clock',
      'Show room times on the person own clock',
    ],
    [
      'OpenCode turns end at 2 minutes on a slow local model',
      'OpenCode turns wait for a slow local model',
    ],
    ['Typo in the README install section', 'Fix the README install section typo'],
    ['Merge queue ejects every PR', 'The merge queue ejects every PR on a flaky check'],
  ])('matches "%s" and "%s"', (a, b) => {
    expect(isNearMatch(a, b)).toBe(true);
    expect(isNearMatch(b, a)).toBe(true);
  });

  it.each([
    ['Flaky test in the rooms e2e suite', 'Flaky test in the relay unit suite'],
    ['Translate the greeting into French', 'Add a greeting command'],
    ['Settings toggle says the wrong thing after a restart', 'Restart the server after an upgrade'],
    ['Keyboard shortcut to archive a chat', 'Empty state for the archive page could say more'],
    ['T', 'T'],
  ])('does not match "%s" and "%s"', (a, b) => {
    expect(isNearMatch(a, b)).toBe(false);
  });

  it('puts the line at two thirds: 0.6 passes, 0.8 matches', () => {
    expect(NEAR_MATCH).toBeCloseTo(2 / 3);
    expect(
      titleSimilarity('Flaky test in the rooms e2e suite', 'Flaky test in the relay unit suite')
        .score
    ).toBeCloseTo(0.6);
    expect(
      titleSimilarity(
        'Export the monthly report as CSV',
        'Let people export the monthly report as a CSV file'
      ).score
    ).toBeCloseTo(0.8);
  });

  it('matches two one-word titles only when the word is the same', () => {
    expect(isNearMatch('Onboarding', 'onboarding')).toBe(true);
    expect(isNearMatch('Onboarding', 'Billing')).toBe(false);
  });
});

describe('nearMatches', () => {
  it('lists every near match, best first', () => {
    const items = [
      { identifier: 'ABC-3', title: 'Monthly report export as a CSV file' },
      { identifier: 'ABC-1', title: 'Export the monthly report as CSV' },
      { identifier: 'ABC-2', title: 'Add a greeting command' },
    ];
    expect(nearMatches('Export the monthly report as CSV', items).map((m) => m.identifier)).toEqual(
      ['ABC-1', 'ABC-3']
    );
  });
});
