import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_WRITERS,
  breach,
  checkAllowedTools,
  collectGrants,
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
    const files = collectGrants(repoRoot).grants.map((g) => g.file);
    expect(
      files.filter((f) => f.startsWith('plugins/flow/commands/')).length
    ).toBeGreaterThanOrEqual(15);
    expect(checkAllowedTools(repoRoot)).toEqual([]);
  });

  it('lists only files that exist and still need the grant', () => {
    const files = new Set(collectGrants(repoRoot).grants.map((g) => g.file));
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
      // Found by the adversarial review: shapes a deny-list let through.
      'mcp__linear',
      'mcp__linear__',
      'PowerShell',
      'PowerShell(Get-ChildItem)',
      'MultiEdit',
      'MultiEdit(specs/**)',
      'Edit(*)',
      'Edit(./*)',
      'Edit(**/*)',
      'Edit(./**/*)',
      'Edit(*/**)',
      'Edit(//etc/**)',
      'Edit(.claude*/settings.json)',
      'Edit(.c*/**)',
      'Edit(.[c]laude/settings.json)',
      'Edit(**/.git*/**)',
      'Edit(specs/.git/hooks/**)',
      'Edit(specs/.c*/**)',
      'Edit(specs\\..\\x)',
      'Edit(%2e%2e/x)',
      'Edit(a(b)',
      'Bash---',
      'bAsh(*)',
      'Bash("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh:*)',
      // Round 2: gitignore drops trailing spaces, so `.claude ` is `.claude`.
      'Edit(.claude )',
      'Edit(.git )',
      'Edit(src/.claude )',
      'Edit(.)',
      'Edit(specs//x)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
  });

  it('passes scoped rules', () => {
    const r = root();
    for (const rule of [
      'Task',
      'mcp__dorkos__tasks_list',
      'Edit(specs/**)',
      'Edit(.dork/flow/tmp/**)',
      'Bash(ls -la)',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts":*)',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts" selftest:*)',
      'Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh:*)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
  });

  it('refuses exact commands whose first word runs any program (DOR-3294)', () => {
    const r = root();
    for (const rule of [
      'Bash(git status)',
      'Bash(npm test)',
      'Bash(npx vitest)',
      'Bash(make)',
      'Bash(node scripts/x.js)',
      'Bash(env)',
      'Bash(find . -name x)',
      'Bash(xargs rm)',
      'Bash(sh -c ls)',
      'Bash(python3 -V)',
      'Bash("git" status)',
      'Bash(GIT_DIR=x git status)',
      'Bash(./scripts/build.sh)',
      'Bash(/bin/ls)',
      'Bash(~/bin/x)',
      'Bash($HOME/x)',
      'Bash(curl https://example.com)',
      'Bash(gh pr list)',
      'Bash("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
    for (const rule of [
      'Bash(ls)',
      'Bash(pwd)',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts")',
      'Bash(node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/tool.ts" check)',
      'Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh)',
      'Bash("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" check)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
    expect(breach('Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gone.sh)', file, pkg, r)).toMatch(
      /does not exist/
    );
  });

  it('allows a reviewed any-program command only in its own package', () => {
    const r = fixtureRepo({});
    const verify = 'plugins/flow/commands/verify.md';
    expect(breach('Bash(git status --porcelain)', verify, 'plugins/flow', r)).toBeNull();
    expect(breach('Bash(git status --porcelain)', file, pkg, r)).not.toBeNull();
    expect(breach('Bash(git status)', verify, 'plugins/flow', r)).not.toBeNull();
  });

  it('keeps read rules inside the project and off secrets', () => {
    const r = root();
    for (const rule of [
      'Read(~/.ssh/**)',
      'Read(/etc/passwd)',
      'Read(//Users/x/.aws/credentials)',
      'Read(../other/**)',
      'Read($HOME/x)',
      'Read(.env)',
      'Read(config/.env.local)',
      'Read(.aws/credentials)',
      'Read(.config/gh/hosts.yml)',
      'Read(.dork/**)',
      'Read(.claude/**)',
      'Read(.claude.json)',
      'Read(.npmrc)',
      'Grep(.git-credentials)',
      'Glob(.s*/**)',
      'LS(~)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
    for (const rule of [
      'Read(specs/**)',
      'Grep(src/**)',
      'Glob(**/*.md)',
      'Read(.github/workflows/**)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
  });

  it('refuses bare reads except in a reviewed package', () => {
    const r = root();
    for (const rule of ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']) {
      expect(breach(rule, file, pkg, r), rule).toMatch(/reads any file/);
    }
    const verify = 'plugins/flow/commands/verify.md';
    for (const rule of ['Read', 'Grep', 'Glob']) {
      expect(breach(rule, verify, 'plugins/flow', r), rule).toBeNull();
    }
    expect(breach('LS', verify, 'plugins/flow', r)).not.toBeNull();
  });

  it('allows WebFetch only for one literal host', () => {
    const r = root();
    for (const rule of [
      'WebFetch',
      'WebFetch(domain:*)',
      'WebFetch(domain:*.example.com)',
      'WebFetch(domain:localhost)',
      'WebFetch(https://example.com)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
    expect(breach('WebFetch(domain:docs.example.com)', file, pkg, r)).toBeNull();
  });

  it('refuses a wildcard on a script that is a symlink', () => {
    const r = root();
    symlinkSync('/bin/bash', path.join(r, 'plugins/demo/scripts/shell.sh'));
    expect(breach('Bash(${CLAUDE_PLUGIN_ROOT}/scripts/shell.sh:*)', file, pkg, r)).toMatch(
      /not a plain file/
    );
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
      'plugins/demo/commands/a.md': command('Read(specs/**), Bash(git:*), Write'),
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
        '---\nname: s\ndescription: d\nallowed-tools:\n  - Read(specs/**)\n  - Bash\n---\n',
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

  it('reads the frontmatter the way Claude Code does, too', () => {
    const r = fixtureRepo({
      'plugins/demo/commands/bom.md': '\uFEFF---\nallowed-tools: Bash\n---\n',
      'plugins/demo/commands/trailspace.md': '--- \nallowed-tools: Bash\n---\n',
      'plugins/demo/commands/quotedkey.md': '---\n"allowed-tools": Bash\n---\n',
      'plugins/demo/commands/flowmap.md': '---\n{"allowed-tools": "Bash"}\n---\n',
      'plugins/demo/commands/explicitkey.md': '---\n? allowed-tools\n: Bash\n---\n',
      'plugins/demo/commands/indent.md': '---\n  allowed-tools: Bash\n---\n',
      'plugins/demo/commands/tab.md': '---\n\tallowed-tools: Bash\n---\n',
      'plugins/demo/commands/dashclose.md': '---\nallowed-tools: Read, Bash---\n---\n',
      'plugins/demo/commands/parens.md': command('Read, Edit(a(b) Bash'),
      'plugins/demo/skills/s/SKILL.MD': '---\nname: s\nallowed-tools: Bash\n---\n',
      'plugins/demo/commands/a/b/c/d/e/f/g/h/deep.md': command('Bash'),
    });
    const flagged = new Set(
      checkAllowedTools(r)
        .filter((f) => f.message.includes('`Bash`'))
        .map((f) => path.basename(f.file))
    );
    expect([...flagged].sort()).toEqual(
      [
        'bom.md',
        'trailspace.md',
        'quotedkey.md',
        'flowmap.md',
        'explicitkey.md',
        'indent.md',
        'tab.md',
        'dashclose.md',
        'parens.md',
        'SKILL.MD',
        'deep.md',
      ].sort()
    );
  });

  it('checks allowedTools in plugin.json and marketplace.json command entries', () => {
    const r = fixtureRepo({
      'plugins/demo/.claude-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        commands: { x: { source: './x.md', allowedTools: ['Read(specs/**)', 'Bash'] } },
      }),
      '.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [
          {
            name: 'demo',
            source: './plugins/demo',
            commands: { y: { source: './y.md', allowedTools: ['Edit'] } },
          },
        ],
      }),
    });
    expect(checkAllowedTools(r).map((f) => `${f.file}: ${f.message.split(' rule')[0]}`)).toEqual([
      'plugins/demo/.claude-plugin/plugin.json: commands.x.allowedTools',
      '.claude-plugin/marketplace.json: plugins[demo].commands.y.allowedTools',
    ]);
  });

  it('refuses a local marketplace source outside plugins/, and skips remote ones', () => {
    const r = fixtureRepo({
      '.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [
          { name: 'evil', source: './vendor/evil' },
          { name: 'up', source: './plugins/../vendor/evil' },
          { name: 'ok', source: './plugins/ok' },
          { name: 'remote', source: { source: 'github', repo: 'x/y' } },
        ],
      }),
      'vendor/evil/commands/x.md': command('Bash'),
    });
    expect(checkAllowedTools(r).map((f) => f.message.split(' ')[0])).toEqual([
      'plugins[evil].source',
      'plugins[up].source',
    ]);
  });

  it('refuses any symlink under plugins/', () => {
    const r = fixtureRepo({ 'outside/x.md': command('Bash'), 'plugins/demo/README.md': '# x\n' });
    mkdirSync(path.join(r, 'plugins/demo/commands'));
    symlinkSync(path.join(r, 'outside/x.md'), path.join(r, 'plugins/demo/commands/link.md'));
    const found = checkAllowedTools(r);
    expect(found.map((f) => f.file)).toEqual(['plugins/demo/commands/link.md']);
    expect(found[0].message).toMatch(/symlink/);
  });

  it('reports any frontmatter it cannot read, even with the key escaped', () => {
    const r = fixtureRepo({
      'plugins/demo/commands/dupkey.md':
        '---\ndescription: x\ndescription: y\n"allowed\\x2dtools": Bash\n---\n',
      'plugins/demo/commands/colon.md': '---\ndescription: a: b\n"allowed\\x2dtools": Bash\n---\n',
      'plugins/demo/commands/fine.md': '---\ndescription: fine\n---\n',
    });
    expect(
      checkAllowedTools(r)
        .map((f) => path.basename(f.file))
        .sort()
    ).toEqual(['colon.md', 'dupkey.md']);
  });

  it('refuses command entries whose frontmatter the walk never reads', () => {
    const r = fixtureRepo({
      'plugins/demo/.claude-plugin/plugin.json': JSON.stringify({
        name: 'demo',
        commands: {
          inline: { content: '---\nallowed-tools: Bash\n---\n' },
          txt: { source: './cmds/x.txt' },
          ok: { source: './commands/ok.md' },
        },
      }),
    });
    expect(checkAllowedTools(r).map((f) => f.message.split(' ')[0])).toEqual([
      'commands.inline',
      'commands.txt.source',
    ]);
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
