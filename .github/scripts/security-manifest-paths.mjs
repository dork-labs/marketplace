/* global console, process */
// Marketplace only: the files a plugin's manifests point at are security paths
// wherever they sit. A test folder is exempt, but if plugin.json, hooks.json,
// .mcp.json or .dork/manifest.json names a script in it, a later PR that edits
// only that script would otherwise need no review (Security, 2026-10-30).
//
// The verifier runs this from the base commit's checkout, so the manifests are
// the base commit's: a PR cannot point a manifest somewhere and edit the target
// in the same review. Its output is the workflow's SECURITY_PATH_PATTERN with
// one exact-path alternative added per pointed-at file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The manifests in each plugin folder whose strings can name a file. */
const MANIFESTS = ['.claude-plugin/plugin.json', 'hooks/hooks.json', '.mcp.json', '.dork/manifest.json'];

const ROOT_VARS = /\$\{?CLAUDE_PLUGIN_ROOT\}?\//g;

/** Every string anywhere in a parsed JSON value. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

/**
 * Repo-relative paths the base commit's plugin manifests point at.
 *
 * @param {string} root - The checkout (the base commit).
 * @returns {string[]} Sorted, unique paths under plugins/.
 */
export function manifestPaths(root) {
  const found = new Set();
  const pluginsDir = join(root, 'plugins');
  if (!existsSync(pluginsDir)) return [];
  for (const name of readdirSync(pluginsDir)) {
    const plugin = posix.join('plugins', name);
    for (const manifest of MANIFESTS) {
      const file = join(root, plugin, manifest);
      if (!existsSync(file)) continue;
      // A manifest that does not parse fails the run: never guess at a partial list.
      const json = JSON.parse(readFileSync(file, 'utf8'));
      for (const text of strings(json)) {
        // Commands are strings like `node ${CLAUDE_PLUGIN_ROOT}/tests/run.mjs --x`.
        for (const token of text.replace(ROOT_VARS, './').split(/[\s"'=;|&<>()]+/)) {
          if (!token.includes('/') || /[\u0000-\u001f]/.test(token) || /^[a-z]+:/i.test(token)) continue;
          const path = posix.normalize(posix.join(plugin, token.replace(/^\.\//, '')));
          // Any plugin's files: a manifest can point into another plugin (`../x/tests`).
          if (path.startsWith('plugins/')) found.add(path.replace(/\/+$/, ''));
        }
      }
    }
  }
  return [...found].sort();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The workflow's pattern plus an exact alternative (the path, or anything under
 * it if it names a folder) for each pointed-at path it does not already cover.
 *
 * @param {string} pattern - SECURITY_PATH_PATTERN from the base commit.
 * @param {string[]} paths - From {@link manifestPaths}.
 */
export function withManifestPaths(pattern, paths) {
  const base = new RegExp(pattern);
  const extra = paths.filter((p) => !base.test(p)).map((p) => `^${escape(p)}(/|$)`);
  return extra.length ? `${pattern}|${extra.join('|')}` : pattern;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.SECURITY_PATH_PATTERN) throw new Error('Security path list missing');
    const out = withManifestPaths(process.env.SECURITY_PATH_PATTERN, manifestPaths(process.cwd()));
    if (/[\r\n]/.test(out)) throw new Error('Security path list must be one line');
    console.log(out);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
