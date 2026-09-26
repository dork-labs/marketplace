/**
 * `judgeEjection` (spec `flow-handoff-dispatch` §4.6, task 3.3): the pure
 * "was a merge-queue ejection this PR's fault" rule.
 */

import { describe, expect, it } from 'vitest';

import { judgeEjection } from '../../scripts/forge/ejection.ts';

describe('judgeEjection', () => {
  // Every failing check also failed for a group without this PR: failing for everyone.
  it('innocent when every failing check failed elsewhere', () => {
    expect(
      judgeEjection({
        failing: ['browser-test', 'lint'],
        otherGroups: [
          { prs: [11], failing: ['browser-test'] },
          { prs: [12], failing: ['lint', 'unit'] },
        ],
        pr: 10,
      })
    ).toBe('innocent');
  });

  // One check failed only here: the PR is a suspect.
  it('suspect when a failing check failed only here', () => {
    expect(
      judgeEjection({
        failing: ['browser-test', 'typecheck'],
        otherGroups: [{ prs: [11], failing: ['browser-test'] }],
        pr: 10,
      })
    ).toBe('suspect');
  });

  // No evidence either way.
  it('unknown with no other groups or no failing checks', () => {
    expect(judgeEjection({ failing: ['x'], otherGroups: [], pr: 10 })).toBe('unknown');
    expect(
      judgeEjection({ failing: [], otherGroups: [{ prs: [11], failing: ['x'] }], pr: 10 })
    ).toBe('unknown');
  });

  // The PR's own group, or any group that may hold it, never proves innocence.
  it('excludes groups that contain the PR', () => {
    expect(
      judgeEjection({
        failing: ['browser-test'],
        otherGroups: [
          { prs: [10], failing: ['browser-test'] },
          { prs: [11, 10], failing: ['browser-test'] },
        ],
        pr: 10,
      })
    ).toBe('unknown');
    expect(
      judgeEjection({
        failing: ['browser-test'],
        otherGroups: [
          { prs: [10, 11], failing: ['browser-test'] },
          { prs: [12], failing: ['lint'] },
        ],
        pr: 10,
      })
    ).toBe('suspect');
  });
});
