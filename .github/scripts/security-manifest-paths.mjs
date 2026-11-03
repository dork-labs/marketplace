/* global console, process */
// Marketplace only. A plugin's test folders are exempt from the security list,
// but a plugin's manifests, or its entry in the catalog, can point a hook, command,
// MCP or LSP server at a script inside one, and then a PR that edits only that
// script would need no review (Security, 2026-10-30). So: when any such string
// mentions `tests` or `engine-tests` as a path segment, that plugin loses its
// test-folder exemptions. Coarse on purpose: parsing the shell in hook commands
// misses forms like `${CLAUDE_PLUGIN_ROOT:-.}/tests` or `\tests\`. A name built at
// run time (`te*/x.sh`) is no mention, but the reviewer of that manifest sees it.
//
// The verifier and main's verdict both run this from a trusted checkout, so the
// manifests are the base commit's. A pointer and a test edit queued together are
// both judged from the base list. Its output is the workflow's SECURITY_PATH_PATTERN
// plus one alternative per plugin that loses its exemptions. It exits non-zero on
// any manifest it cannot read, and the verifier step fails with it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { posix, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The manifests in each plugin folder; any JSON file one of them names is read too. */
const MANIFESTS = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  '.mcp.json',
  '.lsp.json',
  '.dork/manifest.json',
];

/** `tests` or `engine-tests` as a whole word: a path segment, `cd …/tests && …`, or prose. */
const MENTIONS_TESTS = /(^|[^\w-])(engine-)?te[sſ]ts(?![\w-])/iu;

/** `..` as a path step: `../w`, `cd ..`, `${ROOT}/..`, not `a..b` or `...`. */
const CLIMBS = /(?<![\w.-])\.\.(?![\w.-])/;

/** The catalog, whose entries can declare hooks and servers of their own. */
const CATALOG = '.claude-plugin/marketplace.json';

const ROOT_VARS = /\$\{?CLAUDE_PLUGIN_ROOT[^}/\\\s]*\}?/g;

/** Every string anywhere in a parsed JSON value, keys included. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      strings(v, out);
    }
  return out;
}

/** JSON files a manifest string names, inside plugins/. */
function namedJson(text, plugin) {
  const out = [];
  for (const token of text.replace(ROOT_VARS, '.').split(/[\s"'`=:;|&<>(){},]+/)) {
    if (!/\.json$/i.test(token)) continue;
    const path = posix.normalize(posix.join(plugin, token.replace(/\\/g, '/')));
    if (path.startsWith('plugins/')) out.push(path);
  }
  return out;
}

/**
 * Each catalog entry's strings, by the plugin folder its `source` names. An entry
 * whose source is not a plugin folder here cannot be pinned to one: `unpinned`.
 */
function catalogStrings(root) {
  const file = join(root, CATALOG);
  const byPlugin = new Map();
  const unpinned = [];
  if (!existsSync(file)) return { byPlugin, unpinned };
  for (const entry of JSON.parse(readFileSync(file, 'utf8')).plugins ?? []) {
    const source = typeof entry?.source === 'string' ? posix.normalize(entry.source) : '';
    const name = /^plugins\/([^/]+)\/?$/.exec(source)?.[1];
    if (name) byPlugin.set(name, [...(byPlugin.get(name) ?? []), ...strings(entry)]);
    else unpinned.push(...strings(entry));
  }
  return { byPlugin, unpinned };
}

/**
 * Plugins whose base-commit manifests or catalog entries mention a test folder.
 *
 * @param {string} root - The checkout (the base commit).
 * @returns {string[]} Plugin folder names, sorted. A plugin that mentions a test
 *   folder and also climbs out of its folder (`..`), in any of its strings, cannot
 *   be pinned to itself, so it counts for every plugin. So does a mention in a
 *   catalog entry whose source is not a plugin folder.
 */
export function pluginsPointingAtTests(root) {
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const names = readdirSync(pluginsDir).filter((n) => statSync(join(pluginsDir, n)).isDirectory());
  const { byPlugin, unpinned } = catalogStrings(root);
  if (unpinned.some((text) => MENTIONS_TESTS.test(text))) return names.sort();
  const hit = new Set();
  for (const name of names) {
    const plugin = posix.join('plugins', name);
    const texts = [...(byPlugin.get(name) ?? [])];
    const queue = [
      ...MANIFESTS.map((m) => posix.join(plugin, m)),
      ...texts.flatMap((text) => namedJson(text, plugin)),
    ];
    const seen = new Set();
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const file = join(root, rel);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      // A manifest that does not parse fails the run: never guess at a partial list.
      const found = strings(JSON.parse(readFileSync(file, 'utf8')));
      texts.push(...found);
      queue.push(...found.flatMap((text) => namedJson(text, plugin)));
    }
    if (texts.some((text) => MENTIONS_TESTS.test(text))) {
      if (texts.some((text) => CLIMBS.test(text))) return names.sort();
      hit.add(name);
    }
  }
  return [...hit].sort();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The workflow's pattern, plus each listed plugin's test folders.
 *
 * @param {string} pattern - SECURITY_PATH_PATTERN from the base commit.
 * @param {string[]} plugins - From {@link pluginsPointingAtTests}.
 */
export function withManifestPaths(pattern, plugins) {
  const extra = plugins.map(
    (name) => `^plugins/${escape(name)}/(?:(?:engine-)?tests|skills/[^/]+/tests)/`
  );
  return extra.length ? `${pattern}|${extra.join('|')}` : pattern;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.SECURITY_PATH_PATTERN) throw new Error('Security path list missing');
    const out = withManifestPaths(
      process.env.SECURITY_PATH_PATTERN,
      pluginsPointingAtTests(process.cwd())
    );
    if (/[\r\n]/.test(out)) throw new Error('Security path list must be one line');
    console.log(out);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
