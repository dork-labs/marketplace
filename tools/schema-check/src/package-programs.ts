/**
 * The floor for what a package runs on its own: hooks and MCP servers
 * (DOR-3311, Security's follow-up to #123).
 *
 * `allowed-tools` only says what an agent may do without asking. A plugin's
 * hooks run on events, and its MCP servers start with Claude Code, with no
 * permission check at all. So the same allow-list stance applies: a hook or a
 * server passes only when it runs one of the package's own scripts, and
 * anything else is refused until this check is changed in review.
 *
 * - **Hooks**, from `hooks/hooks.json`, plugin.json's `hooks` (a path, an
 *   inline value, or a list), a marketplace entry's `hooks`, and the `hooks`
 *   in any skill or command frontmatter. Only `command` hooks pass, and only
 *   in the shape {@link hookBreach} allows. `http`, `prompt`, `agent` and
 *   `mcp_tool` hooks are refused: they send data out or decide for the person,
 *   and this check can't vet them.
 * - **MCP servers**, from `.mcp.json`, plugin.json's `mcpServers` and a
 *   marketplace entry's `mcpServers`: a local server that runs the package's
 *   own script, with no `env`, `cwd`, URL or helper (see {@link serverBreach}).
 *
 * Every declaration that can't be read is an error, never skipped: "declares
 * something this check can't read" must not look like "declares nothing".
 *
 * - **Language servers, monitors, `bin/` programs and plugin settings** (which
 *   can set a `subagentStatusLine` command) are refused outright
 *   until someone reviews what shape is safe (no package ships one yet).
 *
 * @module package-programs
 */

import path from 'node:path';
import { frontmatterValues, scriptBreach, walkPlugins } from './allowed-tools.ts';
import {
  declarations,
  hookDeclarations,
  isRecord,
  pluginJson,
  readJson,
  serverDeclarations,
  serverMap,
  sourceDir,
  type Declaration,
} from './declarations.ts';
import { PLUGINS_DIR, pluginDirs } from './versions.ts';
import type { Finding } from './validate.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';

/**
 * The only folder changes a hook may make before its script: to the project
 * root, worked out the two ways the packages here do it. Each is an exact
 * string, because a `$(...)` in any other prefix could run anything.
 */
const PROJECT_CD: readonly string[] = [
  'cd "$(git rev-parse --show-toplevel)" && ',
  'cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" && ',
];

/** One path inside the package: `[\w-]+` segments, so no `..`, globs or spaces. */
const IN_PACKAGE = String.raw`(?:[\w-]+\/)*[\w-]+`;

/**
 * A hook command after its folder change: node on one of the package's own
 * scripts, or one of its shell scripts, by `${CLAUDE_PLUGIN_ROOT}`, quoted or
 * not, then fixed lowercase words or flags. Group 1 or 2 is the script.
 */
const HOOK_SCRIPT = new RegExp(
  String.raw`^(?:node (?:--experimental-strip-types )?"?\$\{CLAUDE_PLUGIN_ROOT\}\/(${IN_PACKAGE}\.(?:mjs|cjs|js|ts))"?|"?\$\{CLAUDE_PLUGIN_ROOT\}\/(${IN_PACKAGE}\.sh)"?)(?: (?:--)?[a-z][a-z-]*)*$`
);

/**
 * Why a hook command is too broad, or null when it runs one of the package's
 * own scripts.
 *
 * @param command - The hook's `command` string.
 * @param pkgDir - Repo-relative package folder.
 * @param repoRoot - Absolute path to the repository root, to check the script exists.
 */
export function hookBreach(command: string, pkgDir: string, repoRoot: string): string | null {
  const prefix = PROJECT_CD.find((p) => command.startsWith(p)) ?? '';
  const rest = command.slice(prefix.length);
  const script = HOOK_SCRIPT.exec(rest);
  // A quote on one side only would leave the shell reading on past the script.
  if (!script || (rest.match(/"/g) ?? []).length % 2 !== 0) {
    return 'a hook runs with no permission check, so it may only run one of the package\'s own scripts by ${CLAUDE_PLUGIN_ROOT}, as node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs"';
  }
  return scriptBreach(pkgDir, script[1] ?? script[2], repoRoot);
}

/** A script inside the package, by plugin root, for an MCP server: node's argument or the command itself. */
const SERVER_SCRIPT = new RegExp(
  String.raw`^\$\{CLAUDE_PLUGIN_ROOT\}\/(${IN_PACKAGE}(?:\.[a-z]+)?)$`
);

/** An argument after a server's script: a plain word or flag, never a path or a variable. */
const SERVER_ARG = /^(?:--?[a-z][a-z0-9-]*(?:=[\w.-]+)?|[A-Za-z0-9][\w.-]*)$/;

/**
 * Why an MCP server is too broad, or null when it runs one of the package's
 * own scripts locally.
 *
 * @param name - The server's name in its map.
 * @param server - Its declaration.
 * @param pkgDir - Repo-relative package folder.
 * @param repoRoot - Absolute path to the repository root.
 */
export function serverBreach(
  name: string,
  server: unknown,
  pkgDir: string,
  repoRoot: string
): string | null {
  if (!isRecord(server)) return 'it is not an object this check can read';
  if (server.type !== undefined && server.type !== 'stdio') {
    return 'it connects to a remote server, which this check cannot vet';
  }
  const extra = Object.keys(server).filter((k) => !['type', 'command', 'args'].includes(k));
  if (extra.length > 0) {
    return `it sets ${extra.join(', ')}, which can change what runs or where it connects`;
  }
  const args = server.args ?? [];
  if (
    typeof server.command !== 'string' ||
    !Array.isArray(args) ||
    !args.every((a) => typeof a === 'string')
  ) {
    return 'its command and args are not strings this check can read';
  }
  let rest = args as string[];
  let script: string | undefined;
  if (server.command === 'node') {
    if (rest[0] === '--experimental-strip-types') rest = rest.slice(1);
    script = SERVER_SCRIPT.exec(rest[0] ?? '')?.[1];
    if (script && !/\.(mjs|cjs|js|ts)$/.test(script)) script = undefined;
    rest = rest.slice(1);
  } else {
    script = SERVER_SCRIPT.exec(server.command)?.[1];
  }
  if (!script) {
    return `MCP server ${name} has to run one of the package's own scripts by \${CLAUDE_PLUGIN_ROOT}, as node with "\${CLAUDE_PLUGIN_ROOT}/server.mjs"`;
  }
  const bad = rest.find((a) => !SERVER_ARG.test(a));
  if (bad !== undefined) {
    return `its argument ${JSON.stringify(bad)} is not a plain word or flag`;
  }
  return scriptBreach(pkgDir, script, repoRoot);
}

/** Findings for every hook in one parsed declaration. */
function checkHooks(raw: unknown, file: string, pkgDir: string, repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  const unreadable = (what: string): void => {
    findings.push({
      file,
      message: `${what} cannot be read as hooks, so what it runs can't be checked.`,
    });
  };
  // Both `{ hooks: {…} }` (settings-style) and a bare `{ Event: […] }` object.
  // Never both at once: in frontmatter and inline plugin.json, Claude Code
  // reads the outer keys as events and ignores `hooks`, so unwrapping would
  // skip the events that run (DOR-3311 review).
  // A `description` beside `hooks` is what Claude Code's own docs show.
  const others = isRecord(raw)
    ? Object.keys(raw).filter((k) => k !== 'hooks' && k !== 'description')
    : [];
  if (isRecord(raw) && 'hooks' in raw && others.length > 0) {
    unreadable('A declaration with a hooks key beside other events');
    return findings;
  }
  const events = isRecord(raw) && 'hooks' in raw ? raw.hooks : raw;
  if (!isRecord(events)) {
    unreadable('The declaration');
    return findings;
  }
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      unreadable(`The ${event} entry`);
      continue;
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        unreadable(`A ${event} group`);
        continue;
      }
      for (const hook of group.hooks) {
        if (!isRecord(hook) || (hook.type !== undefined && hook.type !== 'command')) {
          const type = isRecord(hook) ? String(hook.type) : typeof hook;
          findings.push({
            file,
            message: `A ${event} hook of type ${type} runs with no permission check, and this check can't vet it; only command hooks that run the package's own scripts pass.`,
          });
          continue;
        }
        if (typeof hook.command !== 'string') {
          unreadable(`A ${event} hook`);
          continue;
        }
        const why = hookBreach(hook.command, pkgDir, repoRoot);
        if (why) {
          findings.push({
            file,
            message: `The ${event} hook \`${hook.command}\` is too broad: ${why}.`,
          });
        }
      }
    }
  }
  return findings;
}

/** Findings for every server in one parsed declaration. */
function checkServers(raw: unknown, file: string, pkgDir: string, repoRoot: string): Finding[] {
  const map = serverMap(raw);
  if (!map) {
    return [
      { file, message: "It cannot be read as MCP servers, so what they run can't be checked." },
    ];
  }
  const findings: Finding[] = [];
  for (const [name, server] of Object.entries(map)) {
    const why = serverBreach(name, server, pkgDir, repoRoot);
    if (why) findings.push({ file, message: `The MCP server \`${name}\` is too broad: ${why}.` });
  }
  return findings;
}

/** Findings for a list of declarations, one checker per kind. */
function checkAll(
  found: Declaration[],
  check: (raw: unknown, file: string) => Finding[]
): Finding[] {
  return found.flatMap((d) =>
    'error' in d
      ? [
          {
            file: d.file,
            message: `A declaration cannot be read (${d.error}), so what it runs can't be checked.`,
          },
        ]
      : check(d.value, d.file)
  );
}

/**
 * The files and folders Claude Code finds a package's parts by. Each is opened
 * by exact name here, and CI runs on Linux, where `.MCP.json` is a different
 * file; on a Mac's case-blind disk Claude Code opens it as `.mcp.json`.
 */
const KNOWN_PATHS: ReadonlySet<string> = new Set([
  '.claude-plugin',
  '.claude-plugin/plugin.json',
  '.mcp.json',
  '.lsp.json',
  'hooks',
  'hooks/hooks.json',
  'monitors',
  'monitors/monitors.json',
  'bin',
  'settings.json',
  'skills',
  'commands',
  'agents',
  'output-styles',
]);

/**
 * Fold a name at least as broadly as a case-blind disk compares it. NFKC
 * equates more than APFS does (`ª` and `a`), so this refuses a few names a
 * Mac would keep apart; never the other way.
 */
const fold = (name: string): string => name.normalize('NFKC').toLowerCase();

/**
 * List a repo-relative folder, or nothing when it isn't a real one. A symlink
 * is never followed (two self-links would never finish); walkPlugins refuses
 * every symlink, and reports a folder it can't read.
 */
function listDir(repoRoot: string): (rel: string) => string[] {
  return (rel) => {
    try {
      const abs = path.join(repoRoot, rel);
      return lstatSync(abs).isDirectory() ? readdirSync(abs) : [];
    } catch {
      return [];
    }
  };
}

/**
 * Findings for two names in one folder anywhere under `plugins/` that a
 * case-blind disk can't tell apart, and for any of {@link KNOWN_PATHS} spelled
 * in other capitals. Either way CI, on Linux, checks one file while Claude
 * Code on a Mac opens another: plugin.json can name a declaration at any path
 * (DOR-3311 review).
 *
 * @param list - Lists a repo-relative folder's names; empty for a file.
 */
export function caseVariants(list: (rel: string) => string[]): Finding[] {
  const findings: Finding[] = [];
  const twinOf = (seen: Map<string, string>, name: string, child: string): boolean => {
    const twin = seen.get(fold(name));
    seen.set(fold(name), name);
    if (twin === undefined) return false;
    findings.push({
      file: child,
      message: `It differs from ${twin} only in capitals, so a case-blind disk sees one file where CI checks two.`,
    });
    return true;
  };
  const misspelled = (child: string, known: string): void => {
    findings.push({
      file: child,
      message: `Claude Code on a case-blind disk opens it as ${known}, which this check reads by that exact name; spell it ${known}.`,
    });
  };

  // The repo root and .claude-plugin/: a Mac merges `Plugins/` into `plugins/`
  // on checkout, so a package could ship files from a folder no walk reads.
  const top = (rel: string, known: ReadonlySet<string>): void => {
    const seen = new Map<string, string>();
    for (const name of [...list(rel)].sort()) {
      const child = rel === '' ? name : `${rel}/${name}`;
      if (name === '.git') continue;
      twinOf(seen, name, child);
      if (!known.has(fold(name))) continue;
      if (name !== fold(name)) misspelled(child, fold(name));
      else if (name === '.claude-plugin') top(child, ROOT_MANIFESTS);
      else if (name === PLUGINS_DIR) walk(child);
    }
  };

  const walk = (rel: string): void => {
    const seen = new Map<string, string>();
    for (const name of [...list(rel)].sort()) {
      const child = `${rel}/${name}`;
      const segments = child.split('/');
      // plugins/<pkg>/node_modules is npm's; committed files there are refused
      // by committedNodeModules instead. Skipped before twinOf, so a
      // `Node_modules` beside it isn't a twin here; nodeModulesPaths folds
      // case, so no component path can reach either spelling.
      if (name === '.git' || (segments.length === 3 && name === 'node_modules')) continue;
      const inPackage = segments.slice(2).join('/');
      if (
        !twinOf(seen, name, child) &&
        KNOWN_PATHS.has(fold(inPackage)) &&
        inPackage !== fold(inPackage)
      ) {
        misspelled(child, fold(inPackage));
        continue;
      }
      walk(child);
    }
  };
  top('', ROOT_NAMES);
  return findings;
}

/** Repo-root names the checks open by exact spelling. */
const ROOT_NAMES: ReadonlySet<string> = new Set([PLUGINS_DIR, '.claude-plugin']);

/** The marketplace's own manifests in `.claude-plugin/`, opened by exact name. */
const ROOT_MANIFESTS: ReadonlySet<string> = new Set(['marketplace.json', 'dorkos.json']);

/**
 * Findings for files a package ships in its root `node_modules`, the one
 * folder the walk skips as npm's. Claude Code loads skills and commands from
 * there when plugin.json points at it, by any spelling of the path. Only what
 * git tracks ships, so in a git checkout only tracked files count; anywhere
 * else, whatever is on disk does.
 */
function committedNodeModules(repoRoot: string): Finding[] {
  let packages: Set<string>;
  if (existsSync(path.join(repoRoot, '.git'))) {
    const tracked = execFileSync(
      'git',
      // The folder itself too: a symlink or a submodule is one entry.
      [
        '-C',
        repoRoot,
        'ls-files',
        '-z',
        '--',
        ':(glob)plugins/*/node_modules',
        ':(glob)plugins/*/node_modules/**',
      ],
      { encoding: 'utf8' }
    );
    packages = new Set(
      tracked
        .split('\0')
        .filter(Boolean)
        .map((f) => f.split('/').slice(0, 3).join('/'))
    );
  } else {
    packages = new Set(
      pluginDirs(repoRoot)
        .map((name) => `${PLUGINS_DIR}/${name}/node_modules`)
        .filter((dir) => {
          try {
            const stat = lstatSync(path.join(repoRoot, dir));
            return stat.isSymbolicLink() || readdirSync(path.join(repoRoot, dir)).length > 0;
          } catch {
            return false;
          }
        })
    );
  }
  return [...packages].sort().map((file) => ({
    file,
    message:
      'The package ships files in node_modules, which this check never reads; packages install their dependencies instead.',
  }));
}

/** Plugin.json and marketplace-entry fields that name where a package's parts live. */
const COMPONENT_FIELDS = [
  'commands',
  'agents',
  'skills',
  'outputStyles',
  'hooks',
  'mcpServers',
  'lspServers',
];

/** Every path string in a component field: the value, list items, and any `source` inside a map. */
function componentPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(componentPaths);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((entry) =>
    isRecord(entry) && typeof entry.source === 'string' ? [entry.source] : []
  );
}

/**
 * Findings for component paths into the package root's `node_modules`, however
 * spelled (`.//node_modules`, `x/../node_modules`, a command's `source`).
 */
function nodeModulesPaths(fields: Record<string, unknown>, file: string, where: string): Finding[] {
  const findings: Finding[] = [];
  for (const field of COMPONENT_FIELDS) {
    for (const item of componentPaths(fields[field])) {
      const first = path.posix.resolve('/', item.replace(/\\/g, '/')).split('/')[1] ?? '';
      if (fold(first) === 'node_modules') {
        findings.push({
          file,
          message: `${where}${field} names ${JSON.stringify(item)}, inside node_modules, which this check never reads.`,
        });
      }
    }
  }
  return findings;
}

/**
 * Findings for the programs Claude Code starts that this check has no shape
 * for yet: language servers, monitors, and programs in `bin/`, which go on the
 * Bash tool's PATH and can shadow a command the agent runs.
 */
function unreviewedPrograms(repoRoot: string, pkgDir: string): Finding[] {
  const findings: Finding[] = [];
  const exists = (rel: string): boolean => existsSync(path.join(repoRoot, pkgDir, rel));
  const refuse = (file: string, what: string): void => {
    findings.push({
      file,
      message: `It declares ${what}, which Claude Code starts with no permission check; this check refuses them until one is reviewed.`,
    });
  };
  const manifest = pluginJson(repoRoot, pkgDir);
  const manifestFile = `${pkgDir}/.claude-plugin/plugin.json`;
  if (exists('.lsp.json')) refuse(`${pkgDir}/.lsp.json`, 'language servers');
  if (manifest?.lspServers !== undefined) refuse(manifestFile, 'language servers (lspServers)');
  const experimental = isRecord(manifest?.experimental) ? manifest.experimental : {};
  if (manifest?.monitors !== undefined || experimental.monitors !== undefined) {
    refuse(manifestFile, 'monitors');
  }
  if (exists('monitors/monitors.json')) refuse(`${pkgDir}/monitors/monitors.json`, 'monitors');
  if (exists('bin')) refuse(`${pkgDir}/bin`, 'programs in bin/, which go on the PATH');
  // Plugin settings can set subagentStatusLine, a command Claude Code runs
  // for the agent panel with no permission check (Claude Code 2.1.309).
  if (exists('settings.json')) refuse(`${pkgDir}/settings.json`, 'plugin settings');
  if (manifest?.settings !== undefined) refuse(manifestFile, 'plugin settings (settings)');
  return findings;
}

/**
 * Check every hook and MCP server every package declares.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns One finding per hook or server that breaks the floor, and per declaration that can't be read.
 */
export function checkPackagePrograms(repoRoot: string): Finding[] {
  // The case walk never follows a link, so a linked plugins/ or
  // .claude-plugin/ would look empty to it while everything else reads
  // through; refuse them outright.
  const linked = [PLUGINS_DIR, '.claude-plugin'].filter((dir) => {
    try {
      return lstatSync(path.join(repoRoot, dir)).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (linked.length > 0) {
    return linked.map((file) => ({
      file,
      message:
        'It is a symlink. Packages ship real files, so this check and Claude Code read the same thing.',
    }));
  }
  // Until a package's names are the same on a Mac and on CI, what the rest of
  // this reads for it differs between them, so its findings stop there.
  const variants = caseVariants(listDir(repoRoot));
  const findings: Finding[] = [...variants, ...committedNodeModules(repoRoot)];
  for (const name of pluginDirs(repoRoot)) {
    const pkgDir = path.posix.join(PLUGINS_DIR, name);
    if (variants.some((v) => v.file === pkgDir || v.file.startsWith(`${pkgDir}/`))) continue;
    const manifest = pluginJson(repoRoot, pkgDir);
    if (manifest) {
      findings.push(...nodeModulesPaths(manifest, `${pkgDir}/.claude-plugin/plugin.json`, ''));
    }
    findings.push(...unreviewedPrograms(repoRoot, pkgDir));
    findings.push(
      ...checkAll(serverDeclarations(repoRoot, pkgDir), (raw, file) =>
        checkServers(raw, file, pkgDir, repoRoot)
      ),
      ...checkAll(hookDeclarations(repoRoot, pkgDir), (raw, file) =>
        checkHooks(raw, file, pkgDir, repoRoot)
      )
    );
  }

  // A marketplace entry can declare both inline, or by a path in its package.
  const marketplaceFile = '.claude-plugin/marketplace.json';
  const marketplace = readJson(path.join(repoRoot, marketplaceFile));
  const entries =
    isRecord(marketplace) && Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const source = typeof entry.source === 'string' ? entry.source : '';
    const pkgDir = sourceDir(source);
    findings.push(...nodeModulesPaths(entry, marketplaceFile, `plugins[${String(entry.name)}].`));
    if (entry.lspServers !== undefined) {
      findings.push({
        file: marketplaceFile,
        message: `plugins[${String(entry.name)}].lspServers declares language servers, which Claude Code starts with no permission check; this check refuses them until one is reviewed.`,
      });
    }
    for (const [field, check] of [
      ['mcpServers', checkServers],
      ['hooks', checkHooks],
    ] as const) {
      if (entry[field] === undefined) continue;
      if (pkgDir === '') {
        findings.push({
          file: marketplaceFile,
          message: `plugins[${String(entry.name)}].${field} is declared for a package outside ./plugins/<name>, so it can't be checked.`,
        });
        continue;
      }
      findings.push(
        ...checkAll(
          declarations(repoRoot, pkgDir, null, entry[field], marketplaceFile),
          (raw, file) => check(raw, file, pkgDir, repoRoot)
        )
      );
    }
  }

  // Hooks in a skill's or command's frontmatter run while it is in use.
  for (const file of walkPlugins(repoRoot).markdown) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    const pkgDir = file.split('/').slice(0, 2).join('/');
    const seen = new Set<string>();
    for (const value of frontmatterValues(text, 'hooks')) {
      for (const finding of checkHooks(value, file, pkgDir, repoRoot)) {
        if (!seen.has(finding.message)) findings.push(finding);
        seen.add(finding.message);
      }
    }
  }
  return findings;
}
