/**
 * The permission floor for every package's `allowed-tools` (DOR-3044).
 *
 * A command's or skill's `allowed-tools` runs without asking, so a broad rule
 * there is a grant to whatever the agent is steered into. Measured on Claude
 * Code 2.1.300: a bare `Write` or `Edit` writes anywhere on disk,
 * `Bash(node:*)` runs `node -e`, and `Bash(git log:*)` writes files with
 * `--output`. Flow narrowed its own rules in 0.56.0 (#115) and pins them in
 * `plugins/flow/engine-tests/allowed-tools.test.ts`; this check holds every
 * package in the marketplace to the same floor, so the next package can't
 * ship what flow took out.
 *
 * The floor:
 *
 * - No bare `Bash`, `Write`, `Edit` or `NotebookEdit`, and no lowercase tool
 *   names (they are a different, unmatched spelling, not a scoped rule).
 * - No MCP wildcard (`mcp__server__*`): name each tool.
 * - File writes are `Edit(<path>)`, which also governs `Write`. The path stays
 *   inside the project, and out of `.git` and `.claude`. Writing anywhere in
 *   the project (`Edit(./**)`) needs an entry in {@link PROJECT_WRITERS}.
 * - A `Bash` rule is an exact command, or a prefix (`:*`) that names one of the
 *   package's own scripts by `${CLAUDE_PLUGIN_ROOT}`, so its arguments reach
 *   that script and never an interpreter. The script has to exist.
 *
 * Read-only tools (`Read`, `Grep`, `Glob`, ...) and exact commands pass: this
 * floor is about grants that reach past what the author named.
 *
 * @module allowed-tools
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  NonMappingFrontmatterError,
  UnsupportedFrontmatterError,
  parseFrontmatter,
} from '@dorkos/skills/frontmatter';
import { PLUGINS_DIR } from './versions.ts';
import type { Finding } from './validate.ts';

/** How deep to descend under `plugins/` looking for Markdown files. */
const MAX_DEPTH = 8;

/**
 * Files that may write anywhere inside the project, because changing the
 * project's code is their job. Repo-relative path → the one rule allowed.
 * Adding a line here is a security decision: it shows up in review as its own
 * diff, which is the point.
 */
export const PROJECT_WRITERS: ReadonlyMap<string, string> = new Map([
  ['plugins/flow/commands/init.md', 'Edit(./**)'],
  ['plugins/flow/commands/execute.md', 'Edit(./**)'],
  ['plugins/flow/commands/verify.md', 'Edit(./**)'],
]);

/**
 * The one shape a `Bash` wildcard may have: one of the package's own scripts,
 * by plugin root, optionally with one fixed subcommand. Group 1 or 2 is the
 * script's path inside the package. Every path segment is `[\w-]+`, so `..`
 * and other tricks can't appear.
 */
const SCRIPT_PREFIX =
  /^(?:node --experimental-strip-types "\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.ts)"(?: [a-z-]+)?|"?\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.sh)"?):\*$/;

/**
 * Split an `allowed-tools` value into rules: on commas or whitespace between
 * rules, never inside a rule's parentheses. A YAML list is taken item by item.
 *
 * @param value - Whatever sat under the `allowed-tools` key.
 */
export function splitRules(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => splitRules(item));
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  let depth = 0;
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
  };
  for (const c of value) {
    if (c === '(') depth += 1;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === ',' || /\s/.test(c))) flush();
    else current += c;
  }
  flush();
  return out;
}

/**
 * Why a rule breaks the floor, or null when it holds.
 *
 * @param rule - One rule, e.g. `Bash(git status)`.
 * @param file - Repo-relative path of the file that declares it.
 * @param pkgDir - Repo-relative path of the package the file belongs to.
 * @param repoRoot - Absolute path to the repository root, to check scripts exist.
 */
export function breach(
  rule: string,
  file: string,
  pkgDir: string,
  repoRoot: string
): string | null {
  if (/^(Bash|Write|Edit|NotebookEdit)$/i.test(rule)) {
    return 'it is unscoped, so it allows any command or any file write';
  }
  if (/^(bash|write|edit|notebookedit)\b/.test(rule)) {
    return 'tool names are capitalised (Bash, Edit), so this rule never matches';
  }
  if (/^mcp__.*\*/.test(rule)) return 'MCP wildcards are not allowed; name each tool';
  if (/^(Write|NotebookEdit)\(/.test(rule)) {
    return 'use Edit(<path>), which governs every file write';
  }

  const edit = /^Edit\((.*)\)$/s.exec(rule);
  if (edit) {
    const target = edit[1];
    if (/^[/~]|\$|\.\.|(^|\/)\.claude(\/|$)|(^|\/)\.git(\/|$)/i.test(target)) {
      return 'it writes outside the project, or into .git or .claude';
    }
    if (/^(\.\/)?\*\*$/.test(target) && PROJECT_WRITERS.get(file) !== rule) {
      return 'only files listed in PROJECT_WRITERS (tools/schema-check/src/allowed-tools.ts) may write anywhere in the project';
    }
    return null;
  }

  const bash = /^Bash\((.*)\)$/s.exec(rule);
  if (!bash) return null;
  const body = bash[1];
  if (!body.includes('*')) return null;
  const script = SCRIPT_PREFIX.exec(body);
  if (!script) {
    return "a wildcard is only allowed on one of the package's own scripts, by ${CLAUDE_PLUGIN_ROOT}";
  }
  const scriptPath = path.posix.join(pkgDir, script[1] ?? script[2]);
  if (!existsSync(path.join(repoRoot, scriptPath))) {
    return `its script ${scriptPath} does not exist`;
  }
  return null;
}

/** True when a file opens with frontmatter that mentions `allowed-tools`. */
function declaresAllowedTools(text: string): boolean {
  if (!/^---\r?\n/.test(text)) return false;
  const end = text.indexOf('\n---', 3);
  const head = end === -1 ? text : text.slice(0, end);
  return /^allowed-tools\s*:/m.test(head);
}

/**
 * Every Markdown file under `plugins/` that declares `allowed-tools`, by
 * repo-relative path. Dot folders are walked too (a package may ship
 * `.claude/commands/`); only `node_modules` and `.git` are skipped.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
export function findAllowedToolsFiles(repoRoot: string): string[] {
  const found: string[] = [];
  const walk = (relDir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const absDir = path.join(repoRoot, relDir);
    if (!existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isDirectory()) walk(rel, depth + 1);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.md') &&
        declaresAllowedTools(readFileSync(path.join(repoRoot, rel), 'utf8'))
      ) {
        found.push(rel);
      }
    }
  };
  walk(PLUGINS_DIR, 0);
  return found.sort();
}

/**
 * Check every `allowed-tools` rule in every package against the floor.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns One finding per broad rule, or per file whose rules can't be read.
 */
export function checkAllowedTools(repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of findAllowedToolsFiles(repoRoot)) {
    const pkgDir = file.split('/').slice(0, 2).join('/');
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(readFileSync(path.join(repoRoot, file), 'utf8')).data;
    } catch (cause) {
      const why =
        cause instanceof UnsupportedFrontmatterError || cause instanceof NonMappingFrontmatterError
          ? cause.message
          : (cause as Error).message;
      findings.push({
        file,
        message: `It mentions allowed-tools, but its frontmatter cannot be read, so its rules can't be checked (${why}).`,
      });
      continue;
    }
    if (!('allowed-tools' in data)) continue;
    for (const rule of splitRules(data['allowed-tools'])) {
      const why = breach(rule, file, pkgDir, repoRoot);
      if (why)
        findings.push({ file, message: `allowed-tools rule \`${rule}\` is too broad: ${why}.` });
    }
  }
  return findings;
}
