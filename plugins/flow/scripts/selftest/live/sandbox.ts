/**
 * One live case's sandbox, and the fences around the child that runs in it
 * (spec `specs/flow-self-improvement` §1, tier `live`, DOR-2390).
 *
 * A sandbox is a new temp folder holding:
 *
 * - `project/`: a git repo with the case's fixture files and a committed
 *   `.agents/flow/config.json` that selects the `fake` tracker over the `cli`
 *   transport. `.agents/flow/adapters/fake/` is a LINK to the plugin's
 *   `adapters/reference/fake/`, never a copy: its `adapter.ts` imports from
 *   the plugin by relative path, and Node follows the link to the real file.
 *   That is the path `resolveAdapter` reads first, so an agent reading the
 *   adapter skill and the `flow` command both reach the fake.
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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * Build a case's sandbox.
 *
 * @param options - The flow root, the case's files (path relative to the
 *   project, to contents) and its backlog.
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
      path.join(options.flowRoot, 'adapters', 'reference', 'fake'),
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
    return { root, dir, backlogFile, mcpConfig, cleanup };
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
