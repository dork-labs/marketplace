/**
 * DorkOS's account rule as flow reads it (`scripts/fleet/project-eligibility.ts`),
 * beyond the shared 4.2.0 cases: Main, the id `default`, is judged only by
 * `defaultAccountOnlyProjects`, exactly as DorkOS judges it, even when a
 * registered row wrongly carries that id.
 */

import { describe, expect, it } from 'vitest';
import { projectEligibility } from '../../scripts/fleet/project-eligibility.ts';

const same = (folder: string) => folder;

describe('Main (`default`)', () => {
  it('is judged by defaultAccountOnlyProjects, never by a row that claims its id', () => {
    const config = {
      runtimes: {
        claudeCode: {
          accounts: [{ id: 'default', path: '/home/me/.claude', onlyProjects: ['/work/a'] }],
          defaultAccountOnlyProjects: null,
        },
      },
    };
    // The row's list is not Main's rule: Main may work anywhere.
    expect(projectEligibility(config, 'default', '/work/b', same)).toEqual({ eligible: true });
  });

  it('follows defaultAccountOnlyProjects when a row claims its id too', () => {
    const config = {
      runtimes: {
        claudeCode: {
          accounts: [{ id: 'default', path: '/home/me/.claude', onlyProjects: null }],
          defaultAccountOnlyProjects: ['/work/a'],
        },
      },
    };
    expect(projectEligibility(config, 'default', '/work/b', same)).toEqual({
      eligible: false,
      reason: 'only-projects',
    });
  });
});
