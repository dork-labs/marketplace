/* global console, process */
// Marketplace only. A plugin's test folders are exempt from the security list,
// but a plugin's manifests can point a hook, command, MCP or LSP server at a
// script inside one, and then a PR that edits only that script would need no
// review (Security, 2026-10-30). So: when any string in a plugin's manifests
// mentions `tests` or `engine-tests` as a path segment, that plugin loses its
// test-folder exemptions. Coarse on purpose: parsing the shell in hook commands
// misses forms like `${CLAUDE_PLUGIN_ROOT:-.}/tests` or `\tests\`; a mention
// cannot hide.
//
// The verifier runs this from the base commit's checkout, so the manifests are
// the base commit's. Its output is the workflow's SECURITY_PATH_PATTERN plus one
// alternative per plugin that loses its exemptions. It exits non-zero on any
// manifest it cannot read, and the verifier step fails with it.
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
 * Plugins whose base-commit manifests mention a test folder.
 *
 * @param {string} root - The checkout (the base commit).
 * @returns {string[]} Plugin folder names, sorted. A mention that also climbs
 *   out of its plugin (`..`) cannot be pinned to one plugin, so it counts for
 *   every plugin.
 */
export function pluginsPointingAtTests(root) {
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  const names = readdirSync(pluginsDir).filter((n) => statSync(join(pluginsDir, n)).isDirectory());
  const hit = new Set();
  for (const name of names) {
    const plugin = posix.join('plugins', name);
    const queue = MANIFESTS.map((m) => posix.join(plugin, m));
    const seen = new Set();
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const file = join(root, rel);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      // A manifest that does not parse fails the run: never guess at a partial list.
      const json = JSON.parse(readFileSync(file, 'utf8'));
      for (const text of strings(json)) {
        if (MENTIONS_TESTS.test(text)) {
          if (/(^|[/\\])\.\.([/\\]|$)/.test(text)) return names.sort();
          hit.add(name);
        }
        queue.push(...namedJson(text, plugin));
      }
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
