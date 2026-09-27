/**
 * One live case's sandbox, and the fences around the child that runs in it
 * (spec `specs/flow-self-improvement` §1, tier `live`, DOR-2390).
 *
 * A sandbox is a new temp folder holding:
 *
 * - `plugin/`: a copy of the flow root, which the child gets as its
 *   `--plugin-dir`, with its own copy of the runtime packages (`zod`). The
 *   breach check reads a stream, and a `node` program can write past it
 *   (`execSync` with a `cd`, a path built with `path.join`), so the child
 *   never gets a path into the operator's checkout, and nothing in the copy
 *   links back to it (a link would let `<link>/..` reach the checkout):
 *   whatever it writes into the plugin lands in this copy and is deleted
 *   with the sandbox.
 * - `project/`: a git repo with the case's fixture files and a committed
 *   `.agents/flow/config.json` that selects the `fake` tracker over the `cli`
 *   transport. `.agents/flow/adapters/fake/` is a LINK to the copy's
 *   `adapters/reference/fake/`, never a copy of its own: its `adapter.ts`
 *   imports from the plugin by relative path, and Node follows the link to
 *   the copy's file. That is the path `resolveAdapter` reads first, so an
 *   agent reading the adapter skill and the `flow` command both reach the fake.
 * - `store/backlog.json`: a copy of the case's backlog, which
 *   `FLOW_FAKE_BACKLOG` names. It sits OUTSIDE the project on purpose: the
 *   only way into the tracker is the `flow` command, and an agent that reads
 *   or edits the store by hand fails the breach check.
 * - `mcp.json`: an MCP config with no servers, for `--strict-mcp-config`.
 *
 * This module also builds the child's environment ({@link childEnv}). The
 * breach check that reads the stream afterwards is `breach.ts`.
 *
 * Dependency-free (node builtins only).
 *
 * @module @dorkos/flow/selftest/live/sandbox
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { childRuntimeEnv } from '../../runtime-detect.ts';
import { FAKE_BACKLOG_ENV, type FakeBacklog } from '../../tracker/fake.ts';
import { API_KEY_VAR, LIVE_FLAG, OAUTH_TOKEN_VAR, type LiveCredential } from './gate.ts';

/** A case's sandbox on disk. */
export interface Sandbox {
  /** The temp folder holding everything below (its realpath). */
  root: string;
  /** The git project the child runs in (its realpath). */
  dir: string;
  /** The copy of the flow root the child gets as `--plugin-dir`. */
  pluginDir: string;
  /** The fake tracker's store, outside the project. */
  backlogFile: string;
  /** The empty MCP config. */
  mcpConfig: string;
  /** Delete the whole sandbox. */
  cleanup(): void;
}

/** The committed config every sandbox gets. */
export const SANDBOX_CONFIG = {
  tracker: 'fake',
  connection: { transport: 'cli' },
  identity: { agent: 'auto' },
} as const;

/** Run git in a folder with a fixed author, so the host's git config never matters. */
function git(dir: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=selftest@example.test', '-c', 'user.name=flow selftest', ...args],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

/**
 * A dotfile scratch name such as `.dispatch-fixture.tmp.json`, `.x.tmp` or
 * `.tmp-123`: something a test or a tool writes into the checkout for a moment
 * and deletes again. The copy leaves these out, since no case needs them and
 * one can vanish while the copy is running.
 */
const SCRATCH_DOTFILE = /^\.(?:.*\.)?tmp(?:[.-].*)?$/i;

/** `true` when `error` is Node's "no such file or directory". */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Copy `from` to `to`, following every link, skipping any entry `skip` names.
 * An entry that disappears between being listed and being copied (another
 * process in the checkout deleted it: a test's temp file, an editor's swap
 * file) is skipped rather than failing the copy, and so is a link that leads
 * nowhere. Sockets and pipes are skipped too. A link that leads back to a
 * folder already being copied is skipped, so a loop cannot recurse forever.
 *
 * @param from - The file or folder to copy.
 * @param to - Where it goes.
 * @param skip - Leaves out an entry, given its name and full path.
 * @param open - Real paths of the folders being copied above this one.
 */
function copyTree(
  from: string,
  to: string,
  skip: (name: string, full: string) => boolean,
  open: ReadonlySet<string> = new Set()
): void {
  let stats;
  try {
    stats = statSync(from);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (stats.isFile()) {
    try {
      copyFileSync(from, to);
    } catch (error) {
      // Skip only a source that is gone; a missing destination is a real fault.
      if (!isMissing(error) || existsSync(from)) throw error;
    }
    return;
  }
  if (!stats.isDirectory()) return;
  let real: string;
  let names: string[];
  try {
    real = realpathSync(from);
    names = readdirSync(from);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (open.has(real)) return;
  const inside = new Set(open).add(real);
  mkdirSync(to, { recursive: true });
  for (const name of names) {
    const full = path.join(from, name);
    if (skip(name, full)) continue;
    copyTree(full, path.join(to, name), skip, inside);
  }
}

/**
 * Copy the flow root to `into`. Its `node_modules` is left out but for the
 * packages `package.json` lists under `dependencies` (the shipped runtime
 * needs only `zod`, which has no dependencies of its own). The root is copied
 * by its realpath and every link inside it as the file or folder it points
 * to, so nothing in the copy leads back into the checkout. Dotfile scratch
 * files are left out, and a file deleted while the copy runs is skipped: other
 * work in the same checkout (a test run) may be creating and deleting files
 * the whole time.
 *
 * @param flowRoot - The flow root, the operator's checkout.
 * @param into - The folder to create.
 */
export function copyPlugin(flowRoot: string, into: string): void {
  const source = realpathSync(flowRoot);
  const modules = path.join(source, 'node_modules');
  const scratch = (name: string): boolean => SCRATCH_DOTFILE.test(name);
  copyTree(source, into, (name, full) => full === modules || scratch(name));
  const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const from = path.join(modules, name);
    if (existsSync(from)) copyTree(from, path.join(into, 'node_modules', name), scratch);
  }
}

/**
 * Build a case's sandbox.
 *
 * @param options - The flow root (it is copied, never handed to the child),
 *   the case's files (path relative to the project, to contents) and its
 *   backlog.
 * @returns The sandbox; call `cleanup()` when the case is over.
 */
export function makeSandbox(options: {
  flowRoot: string;
  files: Readonly<Record<string, string>>;
  backlog: FakeBacklog;
}): Sandbox {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-live-')));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const pluginDir = path.join(root, 'plugin');
    copyPlugin(options.flowRoot, pluginDir);
    const dir = path.join(root, 'project');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    for (const [rel, text] of Object.entries(options.files)) {
      const file = path.join(dir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const flowDir = path.join(dir, '.agents', 'flow');
    mkdirSync(path.join(flowDir, 'adapters'), { recursive: true });
    writeFileSync(
      path.join(flowDir, 'config.json'),
      `${JSON.stringify(SANDBOX_CONFIG, null, 2)}\n`
    );
    symlinkSync(
      path.join(pluginDir, 'adapters', 'reference', 'fake'),
      path.join(flowDir, 'adapters', 'fake'),
      'dir'
    );
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'selftest sandbox');

    const store = path.join(root, 'store');
    mkdirSync(store);
    const backlogFile = path.join(store, 'backlog.json');
    writeFileSync(backlogFile, `${JSON.stringify(options.backlog, null, 2)}\n`);
    const mcpConfig = path.join(root, 'mcp.json');
    writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: {} })}\n`);
    return { root, dir, pluginDir, backlogFile, mcpConfig, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Variables no live child keeps whatever their name says: the second of the
 * two pinned credentials (the chosen one is put back), the forge's tokens, and
 * the flag itself, so an agent in the child that runs the self-test cannot
 * start a second paid run.
 */
const ALWAYS_STRIPPED: readonly string[] = [
  API_KEY_VAR,
  OAUTH_TOKEN_VAR,
  'GH_TOKEN',
  'GITHUB_TOKEN',
  LIVE_FLAG,
];

/**
 * Whether a variable is stripped from the child: every `*_API_KEY`, every
 * `COMPOSIO_*` and `LINEAR_*`, every `ANTHROPIC_*` (another token, or
 * `ANTHROPIC_BASE_URL` routing the run to a different bill), every
 * `CLAUDE_CODE_USE_*` (Bedrock, Vertex, Foundry), and {@link ALWAYS_STRIPPED}.
 * The one chosen credential is put back afterwards.
 *
 * @param name - The variable's name.
 * @returns `true` when the child must not see it.
 */
export function isStripped(name: string): boolean {
  return (
    name.endsWith('_API_KEY') ||
    name.startsWith('COMPOSIO_') ||
    name.startsWith('LINEAR_') ||
    name.startsWith('ANTHROPIC_') ||
    name.startsWith('CLAUDE_CODE_USE_') ||
    ALWAYS_STRIPPED.includes(name)
  );
}

/**
 * The child's environment: the runner's, marked as a Claude Code child
 * started by the self-test (`childRuntimeEnv`), with every stripped variable
 * removed, then the one credential and the fake's store put back.
 *
 * @param env - The runner's environment.
 * @param credential - The credential this run uses.
 * @param backlogFile - The fake tracker's store.
 * @returns A new environment object.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  credential: LiveCredential,
  backlogFile: string
): Record<string, string> {
  const next = childRuntimeEnv(env, 'claude-code', 'selftest');
  for (const name of Object.keys(next)) if (isStripped(name)) delete next[name];
  return { ...next, ...credential.env, [FAKE_BACKLOG_ENV]: backlogFile };
}
