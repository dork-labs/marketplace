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
// Any other file the plugin ships counts the same way (Security, 2026-11-03): a
// `package.json` script, a config file, a skill's frontmatter or a script can run
// a test folder as well as a manifest can. It is read as plain text, so a word in
// prose costs that plugin its exemptions too. A test folder's own files and a
// plugin's root README, CHANGELOG, LICENSE and NOTICE run nothing, so they aren't read.
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

/**
 * Leaves its own folder: `..` as a path step (`../w`, `cd ..`, `-C../w`, not `a..b`
 * or `...`), or a path through a `plugins` folder (`plugins/w/…`).
 */
const CLIMBS = /(?<!\.)\.\.(?![\w.-])|(?:^|[/\\\s"'=])plugins[/\\]/;

/** Inside a plugin: the files that can't point at a test folder, so the scan skips them. */
const NOT_SCANNED =
  /^(?:(?:engine-)?tests\/|skills\/[^/]+\/tests\/|(?:README|CHANGELOG)\.md$|LICENSE$|NOTICE$)|(?:^|\/)node_modules\//;

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
 * Whether a plugin's other files mention a test folder, and whether one of them
 * does so on a line that also leaves the plugin's folder. Per line, because any
 * relative import is a `..`, so a climb split across two lines isn't seen.
 * A file it can't read throws, like a manifest that doesn't parse.
 *
 * @param {string} root - The checkout (the base commit).
 * @param {string} plugin - The plugin's folder, relative to the checkout.
 * @returns {{mentions: boolean, leaves: boolean}} What the scan found.
 */
function scanPluginFiles(root, plugin) {
  const found = { mentions: false, leaves: false };
  const walk = (folder) => {
    for (const entry of readdirSync(join(root, plugin, folder), { withFileTypes: true })) {
      const rel = posix.join(folder, entry.name);
      if (NOT_SCANNED.test(entry.isDirectory() ? `${rel}/` : rel)) continue;
      if (entry.isDirectory()) walk(rel);
      if (!entry.isFile()) continue;
      const text = readFileSync(join(root, plugin, rel), 'utf8');
      if (!MENTIONS_TESTS.test(text)) continue;
      found.mentions = true;
      if (text.split('\n').some((line) => MENTIONS_TESTS.test(line) && CLIMBS.test(line)))
        found.leaves = true;
    }
  };
  walk('');
  return found;
}

/**
 * Each catalog entry's strings, by the plugin folder its `source` names, and whether
 * every entry could be pinned to a plugin folder that exists.
 */
function catalogStrings(root, names) {
  const file = join(root, CATALOG);
  const byPlugin = new Map();
  let pinned = true;
  if (!existsSync(file)) return { byPlugin, pinned };
  for (const entry of JSON.parse(readFileSync(file, 'utf8')).plugins ?? []) {
    const source = typeof entry?.source === 'string' ? posix.normalize(entry.source) : '';
    const name = /^plugins\/([^/]+)\/?$/.exec(source)?.[1];
    // Its `source` always names plugins/, which is not the entry leaving its folder.
    const { source: _, ...rest } = entry ?? {};
    if (names.includes(name)) byPlugin.set(name, [...(byPlugin.get(name) ?? []), ...strings(rest)]);
    else pinned = false;
  }
  return { byPlugin, pinned };
}

/**
 * Plugins whose base-commit manifests, catalog entries or other files mention a test folder.
 *
 * @param {string} root - The checkout (the base commit).
 * @returns {string[]} Plugin folder names, sorted. A plugin that mentions a test
 *   folder and also leaves its own folder, in any of its strings, cannot be pinned
 *   to itself, so it counts for every plugin. So does any catalog entry whose source
 *   is not a plugin folder here, mention or not.
 */
export function pluginsPointingAtTests(root) {
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const names = readdirSync(pluginsDir).filter((n) => statSync(join(pluginsDir, n)).isDirectory());
  const { byPlugin, pinned } = catalogStrings(root, names);
  if (!pinned) return names.sort();
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
    const scan = scanPluginFiles(root, plugin);
    if (scan.mentions || texts.some((text) => MENTIONS_TESTS.test(text))) {
      if (scan.leaves || texts.some((text) => CLIMBS.test(text))) return names.sort();
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
