/**
 * Where a package declares the programs Claude Code starts on its own: hooks
 * and MCP servers (DOR-3311). Shared by the hook and server floor
 * (`package-programs.ts`) and by the MCP grant check in `allowed-tools.ts`,
 * which needs to know which servers are a package's own.
 *
 * The shapes follow DorkOS's install preview
 * (`apps/server/src/services/marketplace/lib/declarations/` in dork-labs/dorkos):
 * a default file, plus whatever the plugin.json field adds, as a path, an
 * inline value, or a list of either.
 *
 * @module declarations
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The package folder a marketplace entry's `source` points at, or ''. */
export function sourceDir(source: unknown): string {
  if (typeof source !== 'string') return '';
  const match = /^(?:\.\/)?(plugins\/[\w-][\w.-]*)\/?$/.exec(source);
  return match ? match[1] : '';
}

/** A plain object, as opposed to an array, `null` or a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a JSON file, or undefined when it is missing or unreadable (other checks report that). */
export function readJson(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The package's plugin.json, when it has a readable one. */
export function pluginJson(repoRoot: string, pkgDir: string): Record<string, unknown> | undefined {
  const value = readJson(path.join(repoRoot, pkgDir, '.claude-plugin/plugin.json'));
  return isRecord(value) ? value : undefined;
}

/**
 * The name Claude Code knows the package by, or null when its folder,
 * plugin.json's `name` and every marketplace entry pointing at it don't all
 * agree. A package that names itself after another one could otherwise claim
 * that one's MCP tools and commands as its own.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param pkgDir - Repo-relative package folder, e.g. `plugins/flow`.
 */
export function packageName(repoRoot: string, pkgDir: string): string | null {
  const folder = path.posix.basename(pkgDir);
  const names = new Set<unknown>([folder]);
  const manifest = pluginJson(repoRoot, pkgDir);
  if (manifest && 'name' in manifest) names.add(manifest.name);
  const marketplace = readJson(path.join(repoRoot, '.claude-plugin/marketplace.json'));
  const entries =
    isRecord(marketplace) && Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.source !== 'string') continue;
    if (sourceDir(entry.source) === pkgDir) names.add(entry.name);
  }
  return names.size === 1 ? folder : null;
}

/** One declaration, read: its repo-relative file and value, or why it can't be read. */
export type Declaration = { file: string; value: unknown } | { file: string; error: string };

/**
 * Every declaration of one kind in a package: the default file when it
 * exists, then each path or inline value the manifest field adds. A path the
 * field names must stay inside the package and exist.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param pkgDir - Repo-relative package folder, e.g. `plugins/flow`.
 * @param defaultPath - The package-relative default file, e.g. `hooks/hooks.json`.
 * @param field - The manifest field's value, when present.
 * @param manifestFile - Repo-relative file the field sits in, for inline values.
 */
export function declarations(
  repoRoot: string,
  pkgDir: string,
  defaultPath: string | null,
  field: unknown,
  manifestFile: string
): Declaration[] {
  const out: Declaration[] = [];
  const read = (rel: string, required: boolean): void => {
    const normal = path.posix.normalize(rel.replace(/^\.\//, ''));
    if (path.posix.isAbsolute(rel) || normal === '..' || normal.startsWith('../')) {
      out.push({ file: manifestFile, error: `${JSON.stringify(rel)} is outside the package` });
      return;
    }
    const file = path.posix.join(pkgDir, normal);
    let text: string;
    try {
      text = readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      if (required) out.push({ file: manifestFile, error: `${JSON.stringify(rel)} can't be read` });
      return;
    }
    try {
      out.push({ file, value: JSON.parse(text) });
    } catch {
      out.push({ file, error: 'it is not valid JSON' });
    }
  };
  const items = field === undefined ? [] : Array.isArray(field) ? field : [field];
  const named = items.filter((i): i is string => typeof i === 'string');
  const sameAsDefault = (rel: string): boolean =>
    defaultPath !== null &&
    path.posix.normalize(rel.replace(/^\.\//, '')) === path.posix.normalize(defaultPath);
  if (defaultPath !== null && !named.some(sameAsDefault)) read(defaultPath, false);
  for (const item of items) {
    if (typeof item === 'string') read(item, true);
    else out.push({ file: manifestFile, value: item });
  }
  return out;
}

/** A server map, unwrapped from `{ mcpServers: … }` when it is wrapped. */
export function serverMap(value: unknown): Record<string, unknown> | undefined {
  const map = isRecord(value) && 'mcpServers' in value ? value.mcpServers : value;
  return isRecord(map) ? map : undefined;
}

/** Every MCP server declaration in a package's own folder: `.mcp.json` and plugin.json's `mcpServers`. */
export function serverDeclarations(repoRoot: string, pkgDir: string): Declaration[] {
  return declarations(
    repoRoot,
    pkgDir,
    '.mcp.json',
    pluginJson(repoRoot, pkgDir)?.mcpServers,
    `${pkgDir}/.claude-plugin/plugin.json`
  );
}

/** Every hook declaration in a package's own folder: `hooks/hooks.json` and plugin.json's `hooks`. */
export function hookDeclarations(repoRoot: string, pkgDir: string): Declaration[] {
  return declarations(
    repoRoot,
    pkgDir,
    'hooks/hooks.json',
    pluginJson(repoRoot, pkgDir)?.hooks,
    `${pkgDir}/.claude-plugin/plugin.json`
  );
}

/**
 * The tool-name prefixes of the MCP servers a package ships. Claude Code names
 * a plugin server's tools `mcp__plugin_<plugin>_<server>__<tool>`. Only names
 * of letters, digits and dashes count: an underscore would let
 * `plugin_a_b_c` mean two different plugin and server pairs.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param pkgDir - Repo-relative package folder.
 */
export function ownServerPrefixes(repoRoot: string, pkgDir: string): string[] {
  if (pkgDir === '') return [];
  const plugin = packageName(repoRoot, pkgDir);
  if (plugin === null || !/^[A-Za-z0-9-]+$/.test(plugin)) return [];
  const prefixes: string[] = [];
  for (const declaration of serverDeclarations(repoRoot, pkgDir)) {
    if (!('value' in declaration)) continue;
    for (const server of Object.keys(serverMap(declaration.value) ?? {})) {
      if (/^[A-Za-z0-9-]+$/.test(server)) prefixes.push(`mcp__plugin_${plugin}_${server}__`);
    }
  }
  return prefixes;
}
