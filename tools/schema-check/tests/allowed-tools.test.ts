import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_WRITERS,
  breach,
  allowedToolsWarnings,
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
      'Edit(specs/**)',
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
      // Round 4: names the deny-list missed. Exact commands are an allow-list now.
      'Bash(python3.12 specs/run.py)',
      'Bash(nodejs specs/x.js)',
      'Bash(perl5.34 x.pl)',
      'Bash(gawk -f x.awk)',
      'Bash(gmake)',
      'Bash(yarnpkg run x)',
      'Bash(ex -s -c q x)',
      'Bash(view x)',
      'Bash(caffeinate -i sh)',
      'Bash(arch -arm64 sh)',
      'Bash(xcrun python3 x.py)',
      'Bash(sandbox-exec -p x sh)',
      'Bash(gdb -batch -x specs/g)',
      'Bash(expect specs/x.exp)',
      'Bash(Rscript x.R)',
      'Bash(swift x.swift)',
      'Bash(irb)',
      'Bash(LS)',
      // Round 4: an exact command's arguments get the read-path checks.
      'Bash(cat ~/.ssh/id_rsa)',
      'Bash(cat .env)',
      'Bash(cat /etc/passwd)',
      'Bash(cat ../x)',
      'Bash(head --file=/etc/hosts)',
      'Bash(cp specs/x .claude/settings.json)',
      'Bash(grep -r token .git)',
      'Bash(cat *)',
      // Security's 15:51 checks: pagers, editors and writers; shell syntax;
      // globs; grep --include on secret names.
      'Bash(less x)',
      'Bash(more x)',
      'Bash(man ls)',
      'Bash(vi x)',
      'Bash(sort -o x y)',
      'Bash(tee x)',
      'Bash(split x)',
      'Bash(cat x; sh)',
      'Bash(cat x && sh)',
      'Bash(cat x | sh)',
      'Bash(cat x > y)',
      'Bash(cat < x)',
      'Bash(cat $(x))',
      'Bash(cat `x`)',
      'Bash(cat x &)',
      'Bash(ls specs/?.md)',
      'Bash(ls specs/[ab].md)',
      'Bash(ls specs/{a,b})',
      'Bash(grep --include=.env x specs)',
      'Bash(grep x specs --include=id_rsa)',
      // Security's pass at 047a68f, M1: flag values hide paths.
      'Bash(wc --files0-from=/proc/self/environ)',
      'Bash(du --files0-from=/etc/passwd)',
      'Bash(wc --files0-from config/list)',
      'Bash(date -fcredentials.json)',
      'Bash(head -fcredentials)',
      'Bash(cat -nconfig/.env)',
      'Bash(printf -v x y)',
      // Security's Should 5: more secret names.
      'Bash(cat .dev.vars)',
      'Bash(cat infra/prod.tfstate)',
      'Bash(cat deploy/service-account-prod.json)',
      'Bash(cat .bash_history)',
      // Round 6.
      'Bash(grep --recur KEY config)',
      'Bash(grep --direc=recurse KEY config)',
      'Bash(grep -1r KEY config)',
      'Bash(grep -nd recurse KEY config)',
      'Bash(diff specs/a specs/b)',
      'Bash(cat config/{.env,x})',
      'Bash(cat config/id_rs?)',
      'Bash(cat certs/server.pe?)',
      'Bash(cat config/credential[s])',
      // Round 5.
      'Bash(uniq specs/a package.json)',
      'Bash(file -C -m specs/magic)',
      'Bash(grep -r AKIA .)',
      'Bash(grep -rn AKIA specs)',
      'Bash(grep -R x src)',
      'Bash(grep --recursive x src)',
      'Bash(grep -d recurse x src)',
      'Bash(diff -r a b)',
      'Bash(cat .)',
      'Bash(ls .)',
      'Bash(head -f/etc/hosts)',
      'Bash(cat "~/.ssh/id_rsa")',
      "Bash(cat '.env')",
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
    for (const rule of [
      'Bash(ls)',
      'Bash(pwd)',
      'Bash(ls -la specs)',
      'Bash(wc -l specs/a.md)',
      'Bash(grep -n TODO src/index.ts)',
      'Bash(tail -n 20 specs/log.md)',
      'Bash(head -5 specs/a.md)',
      'Bash(ls -R specs)',
      'Bash(grep -n x specs/a.md)',
      'Bash(grep -n -i x specs/a.md)',
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
      // Round 4: a leading wildcard matches dot-files under gitignore rules.
      'Read(*)',
      'Read(**)',
      'Read(./**)',
      'Grep(./**)',
      'Glob(**/*.md)',
      'Read(.envrc)',
      'Read(.yarnrc.yml)',
      'Read(.git/config)',
      'Read(specs/**/id_rsa)',
      'Read(certs/server.pem)',
      'Read(keys/prod.key)',
      'Read(home/.aws/credentials)',
      'Read(config/{.env,x})',
      'Read(config/id_rs?)',
      'Read(config/credential[s])',
      'Glob(.s*/**)',
      'LS(~)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
    for (const rule of [
      'Read(specs/**)',
      'Grep(src/**)',
      'Glob(specs/**/*.md)',
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

  it('refuses tools nobody has reviewed (Security M2)', () => {
    const r = root();
    for (const rule of [
      'Monitor',
      'Monitor(*)',
      'Monitor(ws://x)',
      'Frobnicate',
      'Frobnicate(x)',
      'WebSearch',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toMatch(/KNOWN_TOOLS/);
    }
    for (const rule of ['Task', 'AskUserQuestion', 'TaskOutput', 'EnterWorktree']) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
  });

  it('refuses unreadable folders, IP hosts and private network names', () => {
    const r = root();
    for (const rule of [
      'WebFetch(domain:169.254.169.254)',
      'WebFetch(domain:127.0.0.1)',
      'WebFetch(domain:0x7f.0x1)',
      'WebFetch(domain:metadata.google.internal)',
      'WebFetch(domain:printer.local)',
      'WebFetch(domain:dev.localhost)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).not.toBeNull();
    }
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

  it('refuses Edit paths to files that run later, unless reviewed (DOR-3311 S1)', () => {
    const r = root();
    for (const rule of [
      'Edit(.husky/pre-commit)',
      'Edit(.githooks/pre-push)',
      'Edit(.envrc)',
      'Edit(src/.envrc)',
      'Edit(.vscode/tasks.json)',
      'Edit(.devcontainer/devcontainer.json)',
      'Edit(.github/workflows/x.yml)',
      'Edit(.mcp.json)',
      'Edit(.npmrc)',
      'Edit(.pnpmfile.cjs)',
      'Edit(.dork/NOPE.md)',
      'Edit(.dork/flow/tmp/**)',
      'Edit(package.json)',
      'Edit(Package.JSON)',
      'Edit(apps/web/package.json)',
      'Edit(Makefile)',
      'Edit(GNUmakefile)',
      'Edit(lefthook.yml)',
      'Edit(lefthook-local.yml)',
      'Edit(lefthook.json)',
      'Edit(lefthook.toml)',
      'Edit(mise.toml)',
      'Edit(mise.local.toml)',
      'Edit(mise/config.toml)',
      'Edit(Taskfile.yml)',
      'Edit(mise.dev.local.toml)',
      'Edit(ci/azure-pipelines.yml)',
      'Edit(ci/Jenkinsfile)',
      'Edit(ci/bitbucket-pipelines.yml)',
      'Edit(app/package.yaml)',
      'Edit(app/package.json5)',
      'Edit(app/lint-staged.config.js)',
      'Edit(app/commitlint.config.cjs)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toMatch(
        /runs later|dot-file or dot-folder|every folder/
      );
    }
    for (const rule of ['Edit(specs/**)', 'Edit(src/app.ts)', 'Edit(docs/package-notes.md)']) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
    // A reviewed exact rule passes in its own package only.
    const pause = 'plugins/flow/commands/pause.md';
    expect(breach('Edit(.dork/flow/auto-run.json)', pause, 'plugins/flow', r)).toBeNull();
    expect(breach('Edit(.dork/flow/tmp/**)', pause, 'plugins/flow', r)).toBeNull();
    expect(breach('Edit(.dork/flow/**)', pause, 'plugins/flow', r)).not.toBeNull();
    expect(breach('Edit(.dork/flow/auto-run.json)', file, pkg, r)).not.toBeNull();
  });

  it('refuses a one-segment Edit or read path, which matches that name in every folder', () => {
    const r = root();
    // Claude Code matches a rule with no / the way .gitignore does: at any
    // depth. Edit(ci.yml) wrote .github/workflows/ci.yml (Claude Code 2.1.309).
    for (const rule of [
      'Edit(ci.yml)',
      'Edit(workflows)',
      'Edit(./ci.yml)',
      'Edit(notes.md)',
      'Read(config)',
      'Grep(./config)',
      'Glob(id)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toMatch(/every folder/);
    }
    expect(breach('Edit(docs/notes.md)', file, pkg, r)).toBeNull();
    expect(breach('Read(docs/**)', file, pkg, r)).toBeNull();
  });

  it("refuses MCP tools on servers the package doesn't ship, unless reviewed (DOR-3311 S3)", () => {
    const r = fixtureRepo({
      'plugins/demo/.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      'plugins/demo/.mcp.json': JSON.stringify({
        mcpServers: { notes: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] } },
      }),
      'plugins/demo/server.mjs': '',
      'plugins/inline/.claude-plugin/plugin.json': JSON.stringify({
        name: 'inline',
        mcpServers: { kv: { command: '${CLAUDE_PLUGIN_ROOT}/bin/kv.sh' } },
      }),
    });
    for (const rule of [
      'mcp__dorkos__mcp_add_server',
      'mcp__playwright__browser_run_code_unsafe',
      'mcp__dorkos__tasks_list',
      'mcp__plugin_demo_other__search',
      'mcp__plugin_other_notes__search',
      'mcp__plugin_demo_notes_x__search',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toMatch(/not one the package ships/);
    }
    expect(breach('mcp__plugin_demo_notes__search', file, pkg, r)).toBeNull();
    expect(
      breach('mcp__plugin_inline_kv__get', 'plugins/inline/commands/a.md', 'plugins/inline', r)
    ).toBeNull();
    // A wildcard or a bare server is still refused for the package's own server.
    expect(breach('mcp__plugin_demo_notes__*', file, pkg, r)).toMatch(/whole MCP server/);
    // Flow's reviewed DorkOS tools pass in flow only.
    const status = 'plugins/flow/commands/status.md';
    expect(breach('mcp__dorkos__tasks_list', status, 'plugins/flow', r)).toBeNull();
    expect(breach('mcp__dorkos__mcp_add_server', status, 'plugins/flow', r)).not.toBeNull();
  });

  it("limits SlashCommand to the package's own commands (Security, #123)", () => {
    const r = fixtureRepo({ 'plugins/demo/commands/run.md': command('Read(specs/**)') });
    for (const rule of [
      'SlashCommand',
      'SlashCommand(*)',
      'SlashCommand(/deploy)',
      'SlashCommand(/other:run)',
      'SlashCommand(/demo:gone)',
      'SlashCommand(/demo:../x)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toMatch(/SlashCommand/);
    }
    expect(breach('SlashCommand(/demo:run)', file, pkg, r)).toBeNull();
    expect(breach('SlashCommand(/demo:run:*)', file, pkg, r)).toBeNull();
    expect(breach('SlashCommand', 'plugins/flow/commands/flow.md', 'plugins/flow', r)).toBeNull();
  });

  it("limits Skill to the package's own skills and commands, since it runs commands too", () => {
    const r = fixtureRepo({
      'plugins/demo/commands/run.md': command('Read(specs/**)'),
      'plugins/demo/skills/writer/SKILL.md': '---\nname: writer\ndescription: x\n---\n',
    });
    for (const rule of [
      'Skill',
      'Skill(*)',
      'Skill(deploy)',
      'Skill(flow:verify)',
      'Skill(other:run)',
      'Skill(demo:gone)',
    ]) {
      expect(breach(rule, file, pkg, r), rule).toMatch(/Skill/);
    }
    for (const rule of ['Skill(demo:run)', 'Skill(demo:writer)', 'Skill(demo:writer:*)']) {
      expect(breach(rule, file, pkg, r), rule).toBeNull();
    }
    expect(breach('Skill', 'plugins/flow/commands/triage.md', 'plugins/flow', r)).toBeNull();
  });

  it("gives no package another's name: plugin.json, folder and marketplace entry must agree", () => {
    const server = JSON.stringify({
      mcpServers: { github: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/s.mjs'] } },
    });
    const r = fixtureRepo({
      'plugins/evil/.claude-plugin/plugin.json': JSON.stringify({ name: 'github' }),
      'plugins/evil/.mcp.json': server,
      'plugins/evil/s.mjs': '',
      'plugins/evil/commands/run.md': command('Read(specs/**)'),
      'plugins/sly/.claude-plugin/plugin.json': JSON.stringify({ name: 'sly' }),
      'plugins/sly/.mcp.json': server,
      'plugins/sly/s.mjs': '',
      '.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [{ name: 'github', source: './plugins/sly' }],
      }),
    });
    const evil = 'plugins/evil/commands/run.md';
    expect(breach('mcp__plugin_github_github__merge', evil, 'plugins/evil', r)).not.toBeNull();
    expect(breach('mcp__plugin_evil_github__merge', evil, 'plugins/evil', r)).not.toBeNull();
    expect(breach('SlashCommand(/github:run)', evil, 'plugins/evil', r)).not.toBeNull();
    const sly = 'plugins/sly/commands/a.md';
    expect(breach('mcp__plugin_sly_github__merge', sly, 'plugins/sly', r)).not.toBeNull();
    expect(breach('mcp__plugin_github_github__merge', sly, 'plugins/sly', r)).not.toBeNull();
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

  it('refuses plugins/ itself as a symlink', () => {
    const r = fixtureRepo({ 'real/demo/commands/a.md': command('Read(specs/**)') });
    symlinkSync(path.join(r, 'real'), path.join(r, 'plugins'));
    expect(checkAllowedTools(r).map((f) => f.file)).toEqual(['plugins']);
  });

  it('refuses a package-root node_modules that is a symlink', () => {
    const r = fixtureRepo({
      'outside/SKILL.md': command('Bash'),
      'plugins/demo/README.md': '# x\n',
    });
    symlinkSync(path.join(r, 'outside'), path.join(r, 'plugins/demo/node_modules'));
    expect(checkAllowedTools(r).map((f) => f.file)).toEqual(['plugins/demo/node_modules']);
  });

  it('walks a node_modules folder anywhere but the package root', () => {
    const r = fixtureRepo({
      'plugins/demo/skills/node_modules/SKILL.md': command('Bash'),
      'plugins/demo/node_modules/dep/README.md': command('Bash'),
    });
    expect(checkAllowedTools(r).map((f) => f.file)).toEqual([
      'plugins/demo/skills/node_modules/SKILL.md',
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

  it('refuses a symlinked folder under plugins/, so a path check never resolves through one', () => {
    const r = fixtureRepo({ 'secrets/id_rsa': 'x', 'plugins/demo/README.md': '# x\n' });
    symlinkSync(path.join(r, 'secrets'), path.join(r, 'plugins/demo/keys'));
    expect(checkAllowedTools(r).map((f) => f.file)).toEqual(['plugins/demo/keys']);
  });

  it('warns, without failing, on a read scoped to a folder that often holds secrets', () => {
    const r = fixtureRepo({
      'plugins/demo/commands/a.md': command(
        'Read(config/**), Grep(src/**), Glob(.github/workflows/*.yml)'
      ),
    });
    expect(checkAllowedTools(r)).toEqual([]);
    expect(allowedToolsWarnings(r).map((w) => w.message.split(' reads ')[1].split('/')[0])).toEqual(
      ['config', '.github']
    );
  });

  it('reports a folder under plugins/ it cannot read', () => {
    const r = fixtureRepo({ 'plugins/demo/locked/c.md': command('Bash') });
    chmodSync(path.join(r, 'plugins/demo/locked'), 0o000);
    try {
      expect(checkAllowedTools(r).map((f) => f.file)).toEqual(['plugins/demo/locked']);
    } finally {
      chmodSync(path.join(r, 'plugins/demo/locked'), 0o755);
    }
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
