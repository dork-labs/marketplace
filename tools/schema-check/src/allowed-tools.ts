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
 * **It is an allow-list, not a deny-list.** A rule passes only when it matches
 * one of the shapes below; anything else, including a shape nobody thought of,
 * is refused:
 *
 * - A bare tool name (`Read`, `Grep`), except the ones that are a whole shell
 *   or every file write: {@link UNSCOPED}.
 * - One MCP tool, `mcp__<server>__<tool>`. A bare server, or any `*`, is every
 *   tool on it.
 * - `Edit(<path>)`, which also governs `Write`, on a path that starts with a
 *   literal folder and never names `.git` or `.claude` (see `editBreach`).
 *   `Edit(./**)` only for the files in {@link PROJECT_WRITERS}.
 * - `Bash(<exact command>)`, or a `:*` prefix on one of the package's own
 *   scripts by `${CLAUDE_PLUGIN_ROOT}`, so its arguments reach that script and
 *   never an interpreter. The script has to be a real file in the package.
 * - Any other exact `Bash(<command>)` starts with a word on
 *   {@link SAFE_COMMANDS} (commands that only read or print), unless the exact
 *   rule is on {@link REVIEWED_COMMANDS}. It can't chain, pipe, redirect or
 *   substitute, and every argument gets the same checks as a read path.
 * - `Read`/`Grep`/`Glob(<path>)` only inside the project, starting with a
 *   literal folder: never `/`, `//`, `~`, `..`, a variable or a leading
 *   wildcard, and never a secret folder or file by name (`.ssh`, `.aws`,
 *   `.config`, `.dork`, `.git`, `.claude*`, `.env*`, `id_rsa`, `*.pem`;
 *   DOR-3299).
 * - `WebFetch(domain:<literal host>)`, never bare and never a wildcard host.
 * - `<Tool>(<spec>)` for any other tool.
 *
 * **It reads what Claude Code reads.** Claude Code cuts frontmatter at the
 * first `---` anywhere (after a BOM) and splits rules with an on/off
 * parenthesis flag; DorkOS's own reader cuts at a line. Every file is read both
 * ways and both readings must pass, and rules are split both ways too. Grants
 * in a `plugin.json` or `marketplace.json` command entry (`allowedTools`) are
 * checked as well. Symlinks anywhere under `plugins/` are refused, since a link
 * can point the check and Claude Code at different files.
 *
 * Deliberately outside the floor: `Read`, `Grep`, `Glob` and `Agent`/`Task`
 * pass bare. They don't write, run or send anything themselves. A bare
 * `WebFetch` no longer passes: it can send what an agent read to any host.
 *
 * @module allowed-tools
 */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';
import { PLUGINS_DIR, pluginDirs } from './versions.ts';
import type { Finding } from './validate.ts';

/**
 * Tools that, bare, run anything or write anywhere. `MultiEdit` is an older
 * name Claude Code still knows; `PowerShell` is a shell like `Bash`.
 */
export const UNSCOPED: ReadonlySet<string> = new Set([
  'Bash',
  'PowerShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Files that may write anywhere inside the project, because changing the
 * project's code is their job. Repo-relative path → the one rule allowed.
 * Adding a line here is a security decision: it shows up in review as its own
 * diff, which is the point. `Edit(./**)` also reaches `.git` and `.claude`;
 * Claude Code refuses those itself (measured on 2.1.300), and this list is the
 * only place such a rule is allowed.
 */
export const PROJECT_WRITERS: ReadonlyMap<string, string> = new Map([
  ['plugins/flow/commands/init.md', 'Edit(./**)'],
  ['plugins/flow/commands/execute.md', 'Edit(./**)'],
  ['plugins/flow/commands/verify.md', 'Edit(./**)'],
]);

/**
 * The one shape a `Bash` wildcard may have: one of the package's own scripts,
 * by plugin root, optionally with one fixed subcommand. Group 1, 2 or 3 is the
 * script's path inside the package. Every path segment is `[\w-]+`, so `..`
 * and other tricks can't appear, and quotes come in pairs.
 */
const SCRIPT_PREFIX =
  /^(?:node --experimental-strip-types "\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.ts)"(?: [a-z-]+)?|"\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.sh)"|\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.sh)):\*$/;

/** How Claude Code cuts frontmatter: from a leading `---` to the first `---` anywhere. */
const CC_FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;

/** Split on commas or whitespace between rules, counting parentheses by depth. */
function splitByDepth(value: string): string[] {
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
 * Split the way Claude Code does: `(` sets a flag, `)` clears it, and a comma
 * or a space splits only while the flag is clear. `Edit(a(b) Bash` is one rule
 * by depth and two here, the second a bare `Bash`.
 */
function splitByFlag(value: string): string[] {
  const out: string[] = [];
  let inside = false;
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') out.push(current.trim());
    current = '';
  };
  for (const c of value) {
    if (c === '(') inside = true;
    if (c === ')') inside = false;
    if (!inside && (c === ',' || c === ' ')) flush();
    else current += c;
  }
  flush();
  return out;
}

/**
 * Every rule an `allowed-tools` value can mean, under either way of splitting
 * it. A YAML list is taken item by item.
 *
 * @param value - Whatever sat under the `allowed-tools` key.
 */
export function splitRules(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => splitRules(item)))];
  if (value == null) return [];
  const text = String(value);
  return [...new Set([...splitByDepth(text), ...splitByFlag(text)])];
}

/** True when a path segment is a glob, not a literal name. */
const isGlob = (segment: string): boolean => /[*?[\]{}!]/.test(segment);

/**
 * Why an `Edit(...)` path is too broad, or null when it holds. The path has to
 * start with a literal folder, never name `.git` or `.claude`, and spell every
 * dot-folder out, so no glob can reach them.
 */
function editBreach(rule: string, target: string, file: string): string | null {
  if (/^(\.\/)?\*\*$/.test(target)) {
    return PROJECT_WRITERS.get(file) === rule
      ? null
      : 'only files listed in PROJECT_WRITERS (tools/schema-check/src/allowed-tools.ts) may write anywhere in the project';
  }
  if (/[\\%$~]|\.\./.test(target)) {
    return 'the path uses \\, %, $, ~ or .., so it can leave the project';
  }
  const segments = target.replace(/^\.\//, '').split('/');
  if (/\s/.test(target)) return 'the path has whitespace, which gitignore rules drop';
  if (segments.some((segment) => segment === '.' || segment === '')) {
    return 'the path has an empty or . segment';
  }
  if (isGlob(segments[0])) {
    return 'the path has to start with a literal folder, like specs/**';
  }
  for (const segment of segments) {
    if (!segment.startsWith('.')) continue;
    if (isGlob(segment)) return 'a dot-folder in the path has to be spelled out, with no wildcard';
    if (/^\.(git|claude)$/i.test(segment)) return 'it writes into .git or .claude';
  }
  return null;
}

/**
 * First words an exact `Bash(...)` rule may start with: commands that read or
 * print and never run another program. This is an allow-list on purpose. A
 * deny-list of "programs that run programs" (Security's DOR-3294 list) kept
 * leaking: `python3.12`, `gawk`, `caffeinate -i sh`, `xcrun`, `Rscript`. Any
 * other exact command needs an entry in {@link REVIEWED_COMMANDS}, or the
 * package's own script by `${CLAUDE_PLUGIN_ROOT}`.
 */
export const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'date',
  'echo',
  'printf',
  'true',
  'false',
  'uname',
  'whoami',
  'basename',
  'dirname',
  'stat',
  'cmp',
  'cut',
  'tr',
  'grep',
  'shasum',
  'md5',
  'cksum',
  'du',
  'df',
  'id',
  'hostname',
  'sw_vers',
]);

/**
 * Rules a package may hold that the floor otherwise refuses: exact commands
 * whose first word isn't on {@link SAFE_COMMANDS}, and bare reads. Each is reviewed
 * for what it reaches. Package folder → rules.
 * Adding one is a security decision, like {@link PROJECT_WRITERS}.
 *
 * Flow's: read-only git plumbing its verify and execute steps need (they run
 * in the project the person pointed flow at, whose repo config is theirs),
 * `node --version` for init's check, and init's one dependency install, which
 * is exact, `--omit=dev`, and into flow's own folder.
 */
export const REVIEWED_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'plugins/flow',
    new Set([
      'Bash(git rev-parse --show-toplevel)',
      'Bash(git rev-parse --git-dir --git-common-dir)',
      'Bash(git rev-parse HEAD)',
      'Bash(git status --porcelain)',
      'Bash(git merge-base HEAD origin/HEAD)',
      'Bash(git log --oneline origin/HEAD..HEAD)',
      'Bash(git diff)',
      'Bash(git diff origin/HEAD...HEAD)',
      'Bash(git diff --stat origin/HEAD...HEAD)',
      'Bash(node --version)',
      'Bash(npm install --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}")',
      // Bare reads, until flow moves to folder-scoped reads (follow-up). In plain
      // Claude Code a bare Read allow reads ~/.ssh with no prompt.
      'Read',
      'Grep',
      'Glob',
    ]),
  ],
]);

/** Tools whose spec is a path they read. */
const READERS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);

/**
 * Dot-folders and files that hold secrets (the DOR-3299 list, as names inside
 * a path). A read rule may never name one.
 */
const SECRET_NAMES =
  /^\.(ssh|aws|gnupg|gpg|config|dork|docker|kube|azure|gcloud|netrc|npmrc|pypirc|pgpass|vault-token|git|git-credentials|envrc|yarnrc(\.yml)?|env(\..*)?|claude.*)$/i;

/** Secret files that don't start with a dot: SSH keys, certificates, cloud credentials. */
const SECRET_FILES =
  /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

/** An exact run of one of the package's own scripts, with fixed lowercase words after it. */
const SCRIPT_EXACT =
  /^(?:node --experimental-strip-types "\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.ts)"|"\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.sh)"|\$\{CLAUDE_PLUGIN_ROOT\}\/((?:[\w-]+\/)*[\w-]+\.sh))(?: [a-z-]+)*$/;

/** Why a script path inside the package is unusable, or null when it is a plain file. */
function scriptBreach(pkgDir: string, rel: string, repoRoot: string): string | null {
  const scriptPath = path.posix.join(pkgDir, rel);
  try {
    return lstatSync(path.join(repoRoot, scriptPath)).isFile()
      ? null
      : `its script ${scriptPath} is not a plain file`;
  } catch {
    return `its script ${scriptPath} does not exist`;
  }
}

/**
 * Why a read rule's path is too broad, or null when it holds: it stays inside
 * the project and never names a secret folder or file.
 */
function readBreach(target: string): string | null {
  if (/^[/~]|[\\%$\s]|\.\./.test(target)) {
    return 'the path can leave the project (/, //, ~, $, %, \\, .. or whitespace)';
  }
  if (/[?[\]{}]/.test(target)) {
    return 'the path uses ?, [], or {}, which can match a secret name this check never sees; use * or **';
  }
  const segments = target.replace(/^\.\//, '').split('/');
  if (segments.some((segment) => segment === '.' || segment === '')) {
    return 'the path has an empty or . segment, which means the whole folder';
  }
  if (isGlob(segments[0])) {
    return 'the path has to start with a literal folder, like specs/**; a leading wildcard reaches dot-files';
  }
  for (const segment of segments) {
    if (SECRET_NAMES.test(segment) || SECRET_FILES.test(segment)) {
      return `it reads ${segment}, which holds secrets`;
    }
    if (segment.startsWith('.') && isGlob(segment)) {
      return 'a dot-folder in the path has to be spelled out, with no wildcard';
    }
  }
  return null;
}

/**
 * Why a rule breaks the floor, or null when it holds.
 *
 * @param rule - One rule, e.g. `Bash(git status)`.
 * @param file - Repo-relative path of the file that declares it.
 * @param pkgDir - Repo-relative path of the package the rule belongs to.
 * @param repoRoot - Absolute path to the repository root, to check scripts exist.
 */
export function breach(
  rule: string,
  file: string,
  pkgDir: string,
  repoRoot: string
): string | null {
  if (/^[A-Z][A-Za-z]*$/.test(rule)) {
    if (UNSCOPED.has(rule)) return 'it is unscoped, so it allows any command or any file write';
    if (READERS.has(rule) && !REVIEWED_COMMANDS.get(pkgDir)?.has(rule)) {
      return `a bare ${rule} reads any file, ~/.ssh included; scope it to a folder, as ${rule}(specs/**)`;
    }
    if (rule === 'WebFetch') {
      return 'a bare WebFetch can send anything anywhere; use WebFetch(domain:<host>)';
    }
    return null;
  }
  if (rule.startsWith('mcp__')) {
    return /^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*__[A-Za-z0-9_-]*[A-Za-z0-9-]$/.test(rule)
      ? null
      : 'it names a whole MCP server or a wildcard; name each tool, as mcp__<server>__<tool>';
  }

  const call = /^([A-Z][A-Za-z]*)\(([^()]*)\)$/s.exec(rule);
  if (!call) {
    return 'it is not a rule shape this check knows: Tool, Tool(spec) with no nested parentheses, or mcp__server__tool';
  }
  const [, tool, body] = call;
  if (tool === 'Edit') return editBreach(rule, body, file);
  if (READERS.has(tool)) return readBreach(body);
  if (tool === 'WebFetch') {
    return /^domain:[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(body)
      ? null
      : 'WebFetch has to name one literal host, as WebFetch(domain:<host>)';
  }
  if (tool === 'PowerShell') return 'PowerShell rules are not allowed; use an exact Bash command';
  if (UNSCOPED.has(tool) && tool !== 'Bash') {
    return 'use Edit(<path>), which governs every file write';
  }
  if (tool !== 'Bash') return null;

  if (body.includes('*')) {
    const script = SCRIPT_PREFIX.exec(body);
    if (!script || pkgDir === '') {
      return "a wildcard is only allowed on one of the package's own scripts, by ${CLAUDE_PLUGIN_ROOT}";
    }
    return scriptBreach(pkgDir, script[1] ?? script[2] ?? script[3], repoRoot);
  }

  // An exact command. Its own script by plugin root is fine; otherwise the
  // first word must be on SAFE_COMMANDS and its arguments must stay in bounds.
  const script = SCRIPT_EXACT.exec(body);
  if (script && pkgDir !== '') {
    return scriptBreach(pkgDir, script[1] ?? script[2] ?? script[3], repoRoot);
  }
  if (REVIEWED_COMMANDS.get(pkgDir)?.has(rule)) return null;
  if (/[;&|<>`$\n\r\\]/.test(body)) {
    return 'it chains, pipes, redirects or substitutes, so it is more than one command';
  }
  const first = body.trim().split(/\s+/)[0] ?? '';
  if (first.includes('=')) {
    return 'it sets a variable before the command, which can change what runs';
  }
  if (!/^[A-Za-z0-9][\w.+-]*$/.test(first)) {
    return 'its first word is not a plain command name; use a script by ${CLAUDE_PLUGIN_ROOT}';
  }
  if (!SAFE_COMMANDS.has(first)) {
    return `\`${first}\` is not on SAFE_COMMANDS (commands that only read or print); add the exact rule to REVIEWED_COMMANDS for review, or use a package script`;
  }
  // Its arguments get the same path checks a Read or Edit rule would, flag
  // values included (`--file=/x`, `-f/x`). Quotes would hide a path from the
  // check, so an exact command may not use them.
  if (/["']/.test(body)) return 'it uses quotes, which can hide a path from this check';
  if (/[*?[\]{}]/.test(body))
    return 'it uses a glob, which the shell expands to paths this check never sees';
  // Recursion walks into .env, .git and .claude, whatever folder it starts in.
  // grep takes any unique prefix of a long option (--recur) and digits inside
  // a short cluster (-1r), so it gets no long options and no r, R or d at all.
  if (first === 'grep' && /(^|\s)(--\S*|-[\w]*[rRd][\w]*)(\s|$)/.test(body)) {
    return 'grep may not take long options or -r, -R or -d, since recursion reads secret dot-files';
  }
  for (const arg of body.trim().split(/\s+/).slice(1)) {
    const value = arg.replace(/^-+[A-Za-z-]*=?/, '');
    if (value === '' || /^\d+$/.test(value)) continue;
    const why = readBreach(value);
    if (why) return `its argument ${arg} reaches past the project: ${why}`;
  }
  return null;
}

/** Every `.md` file under `plugins/` (any case), plus every symlink there. */
function walkPlugins(repoRoot: string): { markdown: string[]; symlinks: string[] } {
  const markdown: string[] = [];
  const symlinks: string[] = [];
  const walk = (relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(path.join(repoRoot, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = path.posix.join(relDir, entry.name);
      if (entry.isSymbolicLink()) symlinks.push(rel);
      else if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) markdown.push(rel);
    }
  };
  walk(PLUGINS_DIR);
  return { markdown: markdown.sort(), symlinks: symlinks.sort() };
}

/** What a file's frontmatter says under `allowed-tools`, read one way. */
type Reading = { found: true; value: unknown } | { found: false } | { error: string };

/** Pick `allowed-tools` out of a parsed frontmatter value. */
function pick(data: unknown): Reading {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { found: false };
  return 'allowed-tools' in data
    ? { found: true, value: (data as Record<string, unknown>)['allowed-tools'] }
    : { found: false };
}

/** DorkOS's reader: frontmatter ends at a line that starts with `---`. */
function readAsDorkOS(text: string): Reading {
  try {
    return pick(parseFrontmatter(text).data);
  } catch (cause) {
    return { error: (cause as Error).message };
  }
}

/** Claude Code's reader: strip a BOM, cut at the first `---`, YAML, then YAML with tabs as spaces. */
function readAsClaudeCode(text: string): Reading {
  const block = CC_FRONTMATTER.exec(text.replace(/^﻿/, ''));
  if (!block) return { found: false };
  const detabbed = block[1].replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length));
  for (const source of [block[1], detabbed]) {
    try {
      return pick(yaml.load(source));
    } catch {
      // Try the next form.
    }
  }
  return { error: 'it is not valid YAML' };
}

/** One place that grants tools, and every rule it can mean. */
export interface Grant {
  /** Repo-relative path of the file declaring it. */
  file: string;
  /** The package the rules run in, for checking scripts; '' when unknown. */
  pkgDir: string;
  /** Where in a JSON manifest, e.g. `commands.x.allowedTools`. */
  where?: string;
  rules: string[];
}

/**
 * Grants in a manifest's `commands`, and findings for entries this check can't
 * see into. An entry's `allowedTools` is checked as rules. Inline `content`, or
 * a source that isn't a `.md` file, carries frontmatter the walk never reads, so
 * both are refused.
 */
function manifestGrants(
  file: string,
  pkgDir: string,
  commands: unknown,
  prefix: string
): { grants: Grant[]; findings: Finding[] } {
  const grants: Grant[] = [];
  const findings: Finding[] = [];
  if (commands == null) return { grants, findings };
  const notMarkdown = (where: string, source: unknown): void => {
    if (typeof source === 'string' && /\.md$/i.test(source)) return;
    findings.push({
      file,
      message: `${where} names ${JSON.stringify(source)}, not a .md file, so its frontmatter can't be checked.`,
    });
  };
  if (typeof commands === 'string' || Array.isArray(commands)) {
    for (const source of [commands].flat()) notMarkdown(`${prefix}commands`, source);
    return { grants, findings };
  }
  if (typeof commands !== 'object') return { grants, findings };
  for (const [name, entry] of Object.entries(commands as Record<string, unknown>)) {
    const where = `${prefix}commands.${name}`;
    if (entry === null || typeof entry !== 'object') {
      notMarkdown(where, entry);
      continue;
    }
    const fields = entry as Record<string, unknown>;
    if ('content' in fields) {
      findings.push({
        file,
        message: `${where} has inline content; ship the command as a .md file so its frontmatter is checked.`,
      });
    }
    if ('source' in fields) notMarkdown(`${where}.source`, fields.source);
    if ('allowedTools' in fields) {
      grants.push({
        file,
        pkgDir,
        where: `${where}.allowedTools`,
        rules: splitRules(fields.allowedTools),
      });
    }
  }
  return { grants, findings };
}

/** Read a JSON file, or undefined when it is missing or unreadable (other checks report that). */
function readJson(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The package folder a marketplace entry's `source` points at, or ''. */
function sourceDir(source: unknown): string {
  if (typeof source !== 'string') return '';
  const match = /^(?:\.\/)?(plugins\/[\w-][\w.-]*)\/?$/.exec(source);
  return match ? match[1] : '';
}

/**
 * Every place under `plugins/` (and in the marketplace index) that grants
 * tools, plus findings for what can't be read: symlinks, and frontmatter that
 * mentions `allowed-tools` but won't parse.
 *
 * @param repoRoot - Absolute path to the repository root.
 */
export function collectGrants(repoRoot: string): { grants: Grant[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const grants: Grant[] = [];
  const { markdown, symlinks } = walkPlugins(repoRoot);

  for (const file of symlinks) {
    findings.push({
      file,
      message:
        'It is a symlink. Packages ship real files, so this check and Claude Code read the same thing.',
    });
  }

  for (const file of markdown) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    const readings = [readAsDorkOS(text), readAsClaudeCode(text)];
    const failed = readings.find((r): r is { error: string } => 'error' in r);
    // Any frontmatter that won't parse is an error, mention or not: Claude Code
    // has its own YAML reader and repairs, so a block this check can't read may
    // still be a grant to it (an escaped key, a duplicate key).
    if (failed && /^\uFEFF?---/.test(text)) {
      findings.push({
        file,
        message: `Its frontmatter cannot be read, so any allowed-tools in it can't be checked (${failed.error}).`,
      });
    }
    const rules = readings.flatMap((r) => ('found' in r && r.found ? splitRules(r.value) : []));
    if (rules.length > 0) {
      grants.push({
        file,
        pkgDir: file.split('/').slice(0, 2).join('/'),
        rules: [...new Set(rules)],
      });
    }
  }

  for (const name of pluginDirs(repoRoot)) {
    const pkgDir = path.posix.join(PLUGINS_DIR, name);
    const file = `${pkgDir}/.claude-plugin/plugin.json`;
    const manifest = readJson(path.join(repoRoot, file)) as { commands?: unknown } | undefined;
    const found = manifestGrants(file, pkgDir, manifest?.commands, '');
    grants.push(...found.grants);
    findings.push(...found.findings);
  }
  const marketplaceFile = '.claude-plugin/marketplace.json';
  const marketplace = readJson(path.join(repoRoot, marketplaceFile)) as
    { plugins?: { name?: string; source?: unknown; commands?: unknown }[] } | undefined;
  for (const entry of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
    // A local source outside plugins/ would install a package this walk never
    // reads. Remote sources (an object) aren't in this repo and aren't checked.
    if (typeof entry?.source === 'string' && sourceDir(entry.source) === '') {
      findings.push({
        file: marketplaceFile,
        message: `plugins[${String(entry?.name)}].source is ${JSON.stringify(entry.source)}; a local package lives at ./plugins/<name>, where its grants are checked.`,
      });
    }
    const found = manifestGrants(
      marketplaceFile,
      sourceDir(entry?.source),
      entry?.commands,
      `plugins[${String(entry?.name)}].`
    );
    grants.push(...found.grants);
    findings.push(...found.findings);
  }
  return { grants, findings };
}

/**
 * Check every grant in every package against the floor.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns One finding per broad rule, per file whose grants can't be read, and per symlink.
 */
export function checkAllowedTools(repoRoot: string): Finding[] {
  const { grants, findings } = collectGrants(repoRoot);
  for (const grant of grants) {
    const label = grant.where ? `${grant.where} rule` : 'allowed-tools rule';
    for (const rule of grant.rules) {
      const why = breach(rule, grant.file, grant.pkgDir, repoRoot);
      if (why) {
        findings.push({ file: grant.file, message: `${label} \`${rule}\` is too broad: ${why}.` });
      }
    }
  }
  return findings;
}
