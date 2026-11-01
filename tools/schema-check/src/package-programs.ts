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
 * - **Language servers, monitors and `bin/` programs** are refused outright
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
  type Declaration,
} from './declarations.ts';
import { PLUGINS_DIR, pluginDirs } from './versions.ts';
import type { Finding } from './validate.ts';
import { existsSync, readFileSync } from 'node:fs';

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
  if (isRecord(raw) && 'hooks' in raw && Object.keys(raw).length > 1) {
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
  return findings;
}

/**
 * Check every hook and MCP server every package declares.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns One finding per hook or server that breaks the floor, and per declaration that can't be read.
 */
export function checkPackagePrograms(repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  for (const name of pluginDirs(repoRoot)) {
    const pkgDir = path.posix.join(PLUGINS_DIR, name);
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
    const pkgDir = /^(?:\.\/)?(plugins\/[\w-][\w.-]*)\/?$/.exec(source)?.[1] ?? '';
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
