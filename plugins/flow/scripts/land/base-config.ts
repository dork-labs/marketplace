/**
 * The `land` config the arm guard obeys, read from the committed config on
 * the repository's default branch on `origin` (DOR-3262, DOR-3256), never from
 * the PR's branch, the working tree or `config.local.json`. A PR that edits
 * `land.preArm` is still held to the default branch's entries; its own take
 * effect only once it has merged.
 *
 * The branch is fetched first, so the read is the remote's, not a stale local ref.
 * The commit it read is returned, so a refusal can name it.
 *
 * @module @dorkos/flow/land/base-config
 */

import { LandSchema, type LandConfig } from '../config-schema.ts';
import { CONFIG_FILE, PROJECT_CONFIG_DIR } from '../config-names.ts';
import type { ProcessRunner } from '../cli/context.ts';
import { isBranchName, isFullSha } from './validate.ts';

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 120_000;

/** The committed config's path in the repository. */
export const COMMITTED_CONFIG_PATH = `${PROJECT_CONFIG_DIR}/${CONFIG_FILE}`;

/** What {@link readBaseLand} found. */
export type BaseLand =
  | { ok: true; land: LandConfig; baseSha: string; committed: boolean }
  | { ok: false; detail: string };

/**
 * Read `land` from the committed config on `origin/<base>`.
 *
 * @param runProcess - Runs git with no shell.
 * @param worktree - A checkout of the repository.
 * @param base - The repository's default branch, as the forge names it.
 * @returns The block (the defaults when `base` has no committed config), or why it could not be read.
 */
export async function readBaseLand(
  runProcess: ProcessRunner,
  worktree: string,
  base: string
): Promise<BaseLand> {
  // It goes into a refspec: a name git would read as anything else refuses.
  if (!isBranchName(base)) {
    return { ok: false, detail: `"${base}" is not a branch name flow will fetch` };
  }
  const git = (args: string[]) =>
    // --no-replace-objects: a local `git replace` must not stand in for the
    // config main really has.
    runProcess('git', ['--no-replace-objects', ...args], {
      cwd: worktree,
      timeoutMs: GIT_TIMEOUT_MS,
    }).catch((error: unknown) => ({
      code: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }));
  const ref = `refs/remotes/origin/${base}`;
  const fetched = await git([
    'fetch',
    '--quiet',
    '--no-tags',
    'origin',
    `+refs/heads/${base}:${ref}`,
  ]);
  if (fetched.code !== 0) {
    return {
      ok: false,
      detail: `could not fetch ${base} from origin to read its flow config: ${fetched.stderr.trim() || `git exited ${fetched.code}`}`,
    };
  }
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const baseSha = resolved.stdout.trim();
  if (resolved.code !== 0 || !isFullSha(baseSha)) {
    return { ok: false, detail: `origin has no ${base} branch to read flow's config from` };
  }
  const listed = await git(['ls-tree', '--name-only', baseSha, '--', COMMITTED_CONFIG_PATH]);
  if (listed.code !== 0) {
    return {
      ok: false,
      detail: `could not list ${COMMITTED_CONFIG_PATH} at ${baseSha.slice(0, 7)}`,
    };
  }
  if (listed.stdout.trim() === '') {
    return { ok: true, land: LandSchema.parse({}), baseSha, committed: false };
  }
  const shown = await git(['show', `${baseSha}:${COMMITTED_CONFIG_PATH}`]);
  if (shown.code !== 0) {
    return {
      ok: false,
      detail: `could not read ${COMMITTED_CONFIG_PATH} at ${baseSha.slice(0, 7)}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(shown.stdout) as unknown;
  } catch {
    return {
      ok: false,
      detail: `${COMMITTED_CONFIG_PATH} on ${base} (${baseSha.slice(0, 7)}) is not valid JSON`,
    };
  }
  const block =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).land
      : undefined;
  const parsed = LandSchema.safeParse(block ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      detail: `land in ${COMMITTED_CONFIG_PATH} on ${base} (${baseSha.slice(0, 7)}) is invalid: ${issue ? `${['land', ...issue.path].join('.')}: ${issue.message}` : 'unknown error'}`,
    };
  }
  return { ok: true, land: parsed.data, baseSha, committed: true };
}
