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

  it('rejects a misspelled "schedule:" key, and says what it was probably meant to be', () => {
    const messages = validateSkills(
      fixtureRepo(WORKING_SCHEDULE.replace('schedule:', 'schedul:')),
      REQUIRED
    ).map((finding) => finding.message);
    expect(messages).toHaveLength(2);
    expect(messages.some((m) => m.includes('must stay scheduled'))).toBe(true);
    expect(messages.some((m) => m.includes('Did you mean "schedule:"?'))).toBe(true);
  });

  it('rejects a required skill whose file is gone', () => {
    const findings = validateSkills(fixtureRepo(WORKING_SCHEDULE), [
      'plugins/demo/skills/not-here',
    ]);
    expect(findings.some((f) => f.message.includes('the file is gone'))).toBe(true);
  });
});

// The five schedule fields that end in `.catch(...)` upstream. zod NEVER
// reports them as invalid: it swallows the bad value, substitutes a fallback,
// and returns success. `enabled` is the one that bites — an unreadable value
// falls back to TRUE, so a typo arms a schedule its author was switching off.
describe('a schedule setting zod silently replaces instead of rejecting', () => {
  const swallowed: [string, string, string][] = [
    ['effort', '  effort: hihg', '"hihg"'],
    ['model', "  model: ''", '""'],
    ['runtime', '  runtime: 12345', '12345'],
    ['sticky', '  sticky: sometimes', '"sometimes"'],
    ['enabled', '  enabled: maybe', '"maybe"'],
  ];

  for (const [field, line, wrote] of swallowed) {
    it(`rejects an unreadable ${field}`, () => {
      const findings = validateSkills(fixtureRepo(`${WORKING_SCHEDULE}\n${line}`), REQUIRED);
      expect(findings).toHaveLength(1);
      expect(findings[0].message).toContain(`${field}: ${wrote}`);
      expect(findings[0].message).toContain('DorkOS cannot read');
    });
  }

  it('says what an unreadable "enabled" silently becomes, because it is "true"', () => {
    const findings = validateSkills(fixtureRepo(`${WORKING_SCHEDULE}\n  enabled: maybe`), REQUIRED);
    expect(findings[0].message).toContain('silently uses true instead');
  });

  // The other half of the same check: DorkOS reads the YAML 1.1 boolean words
  // on purpose, so `enabled: no` is the author getting what they asked for.
  // Flagging it would make this gate a second opinion about what DorkOS takes.
  it('accepts the boolean words DorkOS deliberately understands', () => {
    const words = ['no', 'off', "'false'", '0', 'yes', 'on', '1'];
    for (const word of words) {
      const findings = validateSkills(
        fixtureRepo(`${WORKING_SCHEDULE}\n  enabled: ${word}\n  sticky: ${word}`),
        REQUIRED
      );
      expect(findings, `enabled: ${word}`).toEqual([]);
    }
  });
});

describe('top-level frontmatter, which degrades the same way', () => {
  it('rejects a key DorkOS does not know', () => {
    const findings = validateSkills(fixtureRepo(`${WORKING_SCHEDULE}\nmodle: sonnet`), REQUIRED);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('"modle:"');
  });

  it('rejects a known key whose value is silently thrown away', () => {
    const findings = validateSkills(
      fixtureRepo(`${WORKING_SCHEDULE}\nbackground: sometimes`),
      REQUIRED
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('background: "sometimes"');
  });

  it('does not flag the schedule block itself, which the schema rewrites on purpose', () => {
    expect(validateSkills(fixtureRepo(WORKING_SCHEDULE), REQUIRED)).toEqual([]);
  });

  it('accepts the optional keys the real skills use', () => {
    const frontmatter = [
      WORKING_SCHEDULE,
      'display-name: /demo the thing',
      'disable-model-invocation: true',
      'kind: task',
      "allowed-tools: 'Read, Bash'",
    ].join('\n');
    expect(validateSkills(fixtureRepo(frontmatter), REQUIRED)).toEqual([]);
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

  // Each of the three schema checks gets its own failing input, because
  // deleting any one of them left the suite green: `{name:'x'}` is rejected by
  // the DorkOS schema and the Claude Code one for different reasons, and the
  // two findings are told apart by the Claude Code wording.
  it('rejects a marketplace.json the DorkOS schema will not take', () => {
    const findings = validateManifests(
      manifestRepo({ '.claude-plugin/marketplace.json': { name: 'x' } })
    );
    const dorkos = findings.filter(
      (f) =>
        f.file === '.claude-plugin/marketplace.json' &&
        !f.message.includes('Claude Code marketplace')
    );
    expect(dorkos).toHaveLength(1);
  });

  it('rejects a marketplace.json Claude Code itself would not take', () => {
    const findings = validateManifests(
      manifestRepo({ '.claude-plugin/marketplace.json': { name: 'x' } })
    );
    expect(findings.some((f) => f.message.includes('Not valid as a Claude Code marketplace'))).toBe(
      true
    );
  });

  it('rejects a dorkos.json sidecar the schema will not take', () => {
    const findings = validateManifests(
      manifestRepo({ '.claude-plugin/dorkos.json': { schemaVersion: 'banana', plugins: 'nope' } })
    );
    expect(findings.filter((f) => f.file === '.claude-plugin/dorkos.json')).toHaveLength(1);
  });

  it('survives a registry file that is null rather than crashing', () => {
    const findings = validateManifests(manifestRepo({ '.claude-plugin/marketplace.json': null }));
    expect(findings.length).toBeGreaterThan(0);
  });

  it('rejects a registry file that is not valid JSON', () => {
    const root = manifestRepo();
    writeFileSync(path.join(root, '.claude-plugin/dorkos.json'), '{ nope', 'utf8');
    const findings = validateManifests(root);
    expect(findings.some((f) => f.message.includes('not valid JSON'))).toBe(true);
  });
});
