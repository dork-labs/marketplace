import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVersionBumps } from '../src/bump.ts';

const REASON = 'Claude Code and DorkOS only deliver a change to people when the version goes up.';

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

/** A real, throwaway git repository. No mocks: the check shells out to git. */
class Repo {
  readonly root: string;

  constructor() {
    this.root = mkdtempSync(path.join(tmpdir(), 'schema-check-bump-'));
    scratchDirs.push(this.root);
    this.git('init', '-q', '-b', 'main');
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8' }).trim();
  }

  /** Write files (objects become JSON). */
  write(files: Record<string, unknown>): this {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(this.root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(
        abs,
        typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
        'utf8'
      );
    }
    return this;
  }

  /** Write `.claude-plugin/marketplace.json` listing each `name -> dir` entry. */
  marketplace(entries: Record<string, string>): this {
    return this.write({
      '.claude-plugin/marketplace.json': {
        name: 'fixture',
        plugins: Object.entries(entries).map(([name, dir]) => ({
          name,
          source: `./plugins/${dir}`,
        })),
      },
    });
  }

  /** A plugin directory with a plugin.json (and optional version) plus a README. */
  plugin(dir: string, version: string | null, name = dir): this {
    return this.write({
      [`plugins/${dir}/.claude-plugin/plugin.json`]:
        version === null ? { name } : { name, version },
      [`plugins/${dir}/README.md`]: `# ${name}\n`,
    });
  }

  remove(rel: string): this {
    rmSync(path.join(this.root, rel), { recursive: true, force: true });
    return this;
  }

  move(from: string, to: string): this {
    this.git('mv', from, to);
    return this;
  }

  commit(message = 'change'): string {
    this.git('add', '-A');
    this.git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message
    );
    return this.git('rev-parse', 'HEAD');
  }
}

/** A base commit with one package `a` at `version` (`null`: plugin.json declares none). */
function baseWithA(version: string | null = '0.1.0'): { repo: Repo; base: string } {
  const repo = new Repo().marketplace({ a: 'a' }).plugin('a', version);
  return { repo, base: repo.commit('base') };
}

const errors = (findings: ReturnType<typeof checkVersionBumps>) =>
  findings.filter((f) => f.level === 'error');

describe('checkVersionBumps', () => {
  it('fails a package that changed without a bump, with the one-sentence reason', () => {
    // The core rule: an unbumped change never reaches anyone who installed the package.
    const { repo, base } = baseWithA();
    const head = repo.write({ 'plugins/a/skill.md': 'new\n' }).commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([
      { pkg: 'a', level: 'error', message: `a changed but its version stayed 0.1.0. ${REASON}` },
    ]);
  });

  it('passes a package whose version went up', () => {
    // 0.1.0 -> 0.1.1 is exactly what the rule asks for.
    const { repo, base } = baseWithA();
    const head = repo.write({ 'plugins/a/skill.md': 'new\n' }).plugin('a', '0.1.1').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('passes a new package', () => {
    // Nobody has it installed yet, so there is nothing to bump past.
    const { repo, base } = baseWithA();
    const head = repo.marketplace({ a: 'a', b: 'b' }).plugin('b', '0.1.0').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('passes a deleted package', () => {
    // A package that is gone has no version left to raise.
    const { repo, base } = baseWithA();
    const head = repo.marketplace({}).remove('plugins/a').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('exempts a package that declares no version at base and head, with a note', () => {
    // Claude Code serves a version-less package by commit, so every change already reaches people.
    const { repo, base } = baseWithA(null);
    const head = repo.write({ 'plugins/a/skill.md': 'new\n' }).commit();
    const findings = checkVersionBumps(repo.root, base, head);
    expect(errors(findings)).toEqual([]);
    expect(findings).toEqual([
      {
        pkg: 'a',
        level: 'note',
        message:
          'a declares no version, so Claude Code serves it by commit and every change already reaches people. Declare a version to opt in to version-based updates.',
      },
    ]);
  });

  it('passes a package that declares its first version', () => {
    // Going from no version to one is opting in, not a regression.
    const { repo, base } = baseWithA(null);
    const head = repo.plugin('a', '0.1.0').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('fails a package whose version was removed', () => {
    // Dropping the version silently moves every install back to by-commit, so it must be deliberate.
    const { repo, base } = baseWithA('0.3.0');
    const head = repo.plugin('a', null).commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([
      { pkg: 'a', level: 'error', message: `a: its version (0.3.0) was removed. ${REASON}` },
    ]);
  });

  it('still needs a bump for a docs-only change', () => {
    // A README or docs/ page ships inside the install, so it counts as a change.
    const { repo, base } = baseWithA();
    const head = repo.write({ 'plugins/a/docs/guide.md': '# Guide\n' }).commit();
    expect(errors(checkVersionBumps(repo.root, base, head))).toHaveLength(1);
  });

  it('fails a version that went down', () => {
    // A lower version never reads as an update to anyone.
    const { repo, base } = baseWithA('0.2.0');
    const head = repo.plugin('a', '0.1.9').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([
      {
        pkg: 'a',
        level: 'error',
        message: `a: its version went down from 0.2.0 to 0.1.9. ${REASON}`,
      },
    ]);
  });

  it('fails a version that is not semver', () => {
    // Without semver on both sides "went up" has no meaning.
    const { repo, base } = baseWithA('0.2.0');
    const head = repo.plugin('a', 'next').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([
      {
        pkg: 'a',
        level: 'error',
        message: `a: version "next" is not semver, so the bump can't be checked. ${REASON}`,
      },
    ]);
  });

  it('matches a moved directory through its marketplace entry: one package, needing a bump', () => {
    // The entry name is the install identity; a move is not a new package.
    const { repo, base } = baseWithA();
    const head = repo.move('plugins/a', 'plugins/a-moved').marketplace({ a: 'a-moved' }).commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([
      { pkg: 'a', level: 'error', message: `a changed but its version stayed 0.1.0. ${REASON}` },
    ]);
  });

  it('passes a moved directory that was bumped', () => {
    // Same move, with the bump: the package's identity carried its version up.
    const { repo, base } = baseWithA();
    repo.move('plugins/a', 'plugins/a-moved').marketplace({ a: 'a-moved' });
    const head = repo.plugin('a-moved', '0.2.0', 'a').commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('treats a renamed entry as a new package plus a deleted one', () => {
    // Anyone who installed `a` sees it vanish; `b` is a fresh install. Neither needs a bump.
    const { repo, base } = baseWithA();
    const head = repo.marketplace({ b: 'a' }).write({ 'plugins/a/skill.md': 'new\n' }).commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('ignores changes outside plugins/', () => {
    // tools/ and .github/ are not packages and never ship in an install, even under a package's name.
    const { repo, base } = baseWithA();
    const head = repo
      .write({ 'tools/a/index.ts': 'export {};\n', '.github/a/x.yml': 'on: push\n' })
      .commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([]);
  });

  it('only counts changes since the merge base', () => {
    // A branch compared against a main that moved on must not inherit main's own changes.
    const { repo, base } = baseWithA();
    repo.git('checkout', '-q', '-b', 'feature');
    const head = repo.write({ 'tools/y.ts': 'export {};\n' }).commit();
    repo.git('checkout', '-q', 'main');
    const mainMoved = repo.write({ 'plugins/a/skill.md': 'on main\n' }).commit();
    expect(base).not.toBe(mainMoved);
    expect(checkVersionBumps(repo.root, mainMoved, head)).toEqual([]);
  });

  it('falls back to the directory name for a changed package no entry lists', () => {
    // An unlisted directory still ships to anyone with it checked out; judge it by its folder.
    const repo = new Repo().marketplace({}).plugin('loose', '1.0.0');
    const base = repo.commit('base');
    const head = repo.write({ 'plugins/loose/x.md': 'x\n' }).commit();
    expect(checkVersionBumps(repo.root, base, head)).toEqual([
      {
        pkg: 'loose',
        level: 'error',
        message: `loose changed but its version stayed 1.0.0. ${REASON}`,
      },
    ]);
  });

  it('uses the manifest version when plugin.json has none', () => {
    // Claude Code's order: plugin.json first, then the manifest.
    const repo = new Repo()
      .marketplace({ a: 'a' })
      .write({ 'plugins/a/.dork/manifest.json': { name: 'a', version: '0.5.0' } });
    const base = repo.commit('base');
    const head = repo.write({ 'plugins/a/x.md': 'x\n' }).commit();
    expect(errors(checkVersionBumps(repo.root, base, head))[0]!.message).toBe(
      `a changed but its version stayed 0.5.0. ${REASON}`
    );
  });
});
