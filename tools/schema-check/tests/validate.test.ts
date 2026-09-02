import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSkillFiles,
  validateManifests,
  validateRepo,
  validateSkills,
} from '../src/validate.ts';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/**
 * Build a throwaway repo holding one skill, and return its root. Fixtures are
 * seeded here and never in `plugins/` — a broken schedule committed to the real
 * tree is exactly what this gate exists to stop.
 */
function fixtureRepo(frontmatter: string, dir = 'plugins/demo/skills/demo-skill'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'schema-check-'));
  scratchDirs.push(root);
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(
    path.join(root, dir, 'SKILL.md'),
    `---\n${frontmatter}\n---\n\nDo the thing.\n`,
    'utf8'
  );
  return root;
}

const WORKING_SCHEDULE = [
  'name: demo-skill',
  'description: Runs the demo every hour',
  'schedule:',
  "  cron: '0 * * * *'",
  '  timezone: America/Los_Angeles',
  '  permissions: acceptEdits',
].join('\n');

const REQUIRED = ['plugins/demo/skills/demo-skill'];

describe('the real repository', () => {
  it('passes every check', () => {
    expect(validateRepo(repoRoot)).toEqual([]);
  });

  it('finds the SKILL.md files that are actually there', () => {
    const files = findSkillFiles(repoRoot);
    expect(files).toContain('plugins/flow/skills/flow-drain/SKILL.md');
    expect(files).toContain('plugins/flow/skills/flow-groom/SKILL.md');
    // Skills nest: the flow adapters live outside `skills/` and are still scanned.
    expect(files).toContain('plugins/flow/adapters/reference/linear-mcp/SKILL.md');
  });
});

describe('a schedule block that DorkOS would silently drop', () => {
  it('accepts the working block it is measured against', () => {
    expect(validateSkills(fixtureRepo(WORKING_SCHEDULE), REQUIRED)).toEqual([]);
  });

  // The exact seed from the DOR-1519 review: one transposed character in a
  // permission mode. DorkOS reads the file, cannot read the block, keeps the
  // skill and throws the schedule away.
  it('rejects a misspelled permission mode', () => {
    const findings = validateSkills(
      fixtureRepo(WORKING_SCHEDULE.replace('acceptEdits', 'acceptEditz')),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('plugins/demo/skills/demo-skill/SKILL.md');
    expect(findings[0].message).toContain('permissions');
  });

  it('rejects a misspelled setting NAME, which zod would otherwise just drop', () => {
    const findings = validateSkills(
      fixtureRepo(WORKING_SCHEDULE.replace('  permissions:', '  permissionz:')),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('"permissionz"');
  });

  it('rejects an unreadable max-runtime', () => {
    const findings = validateSkills(
      fixtureRepo(`${WORKING_SCHEDULE}\n  max-runtime: 2hh`),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('max-runtime');
  });

  it('rejects an empty cron rather than reading it as on-demand', () => {
    const findings = validateSkills(
      fixtureRepo(WORKING_SCHEDULE.replace("cron: '0 * * * *'", "cron: ''")),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('cron');
  });
});

describe('a schedule block that disappeared entirely', () => {
  it('rejects a required skill whose block was deleted', () => {
    const findings = validateSkills(
      fixtureRepo('name: demo-skill\ndescription: Runs the demo every hour'),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('must stay scheduled');
  });

  it('rejects a misspelled "schedule:" key, which leaves nothing to complain about', () => {
    const findings = validateSkills(
      fixtureRepo(WORKING_SCHEDULE.replace('schedule:', 'schedul:')),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('must stay scheduled');
  });

  it('rejects a required skill whose file is gone', () => {
    const findings = validateSkills(fixtureRepo(WORKING_SCHEDULE), [
      'plugins/demo/skills/not-here',
    ]);
    expect(findings.some((f) => f.message.includes('the file is gone'))).toBe(true);
  });
});

describe('the schedulable registry', () => {
  it('rejects a scheduled skill nobody registered', () => {
    const findings = validateSkills(fixtureRepo(WORKING_SCHEDULE), []);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('SCHEDULED_SKILLS');
  });
});

describe('manifests', () => {
  /** A fixture repo with the two registry files and one plugin manifest. */
  function manifestRepo(overrides: Record<string, unknown> = {}): string {
    const root = mkdtempSync(path.join(tmpdir(), 'schema-check-'));
    scratchDirs.push(root);
    mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(root, 'plugins/demo/.dork'), { recursive: true });
    const files: Record<string, unknown> = {
      '.claude-plugin/marketplace.json': {
        name: 'demo-marketplace',
        owner: { name: 'Dork Labs' },
        plugins: [{ name: 'demo', source: './plugins/demo', description: 'A demo plugin' }],
      },
      '.claude-plugin/dorkos.json': { schemaVersion: 1, plugins: {} },
      'plugins/demo/.dork/manifest.json': {
        schemaVersion: 1,
        name: 'demo',
        version: '1.0.0',
        type: 'plugin',
        description: 'A demo plugin',
      },
      ...overrides,
    };
    for (const [file, value] of Object.entries(files)) {
      writeFileSync(path.join(root, file), JSON.stringify(value, null, 2), 'utf8');
    }
    return root;
  }

  it('accepts the shape it is measured against', () => {
    expect(validateManifests(manifestRepo())).toEqual([]);
  });

  it('rejects a package manifest with an unknown type', () => {
    const findings = validateManifests(
      manifestRepo({
        'plugins/demo/.dork/manifest.json': {
          schemaVersion: 1,
          name: 'demo',
          version: '1.0.0',
          type: 'plugni',
          description: 'A demo plugin',
        },
      })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('plugins/demo/.dork/manifest.json');
  });

  it('rejects a marketplace entry pointing at a directory that is not there', () => {
    const findings = validateManifests(
      manifestRepo({
        '.claude-plugin/marketplace.json': {
          name: 'demo-marketplace',
          owner: { name: 'Dork Labs' },
          plugins: [{ name: 'demo', source: './plugins/ghost', description: 'A demo plugin' }],
        },
      })
    );
    expect(findings.some((f) => f.message.includes('./plugins/ghost'))).toBe(true);
  });

  it('rejects a registry file that is not valid JSON', () => {
    const root = manifestRepo();
    writeFileSync(path.join(root, '.claude-plugin/dorkos.json'), '{ nope', 'utf8');
    const findings = validateManifests(root);
    expect(findings.some((f) => f.message.includes('not valid JSON'))).toBe(true);
  });
});
