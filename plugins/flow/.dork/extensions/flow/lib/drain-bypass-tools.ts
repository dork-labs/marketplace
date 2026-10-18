/**
 * The two agent tools behind a person's grant for unattended bypass (DOR-3062).
 *
 * - `set_drain_bypass` is declared `destructive` in `extension.json`, so DorkOS
 *   runs it only after a person grants the approval card, bound to this exact
 *   input (the project's root and on/off). It records or removes the grant in
 *   the extension's storage, outside every project.
 * - `get_drain_bypass` is `observe`: whether a grant holds for a project now,
 *   and why not.
 *
 * The flow CLI reads the same stored grant from DorkOS's data folder
 * (`scripts/drain-bypass.ts`); no flow verb writes it.
 *
 * @module @dorkos/flow/extension/drain-bypass-tools
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';

import {
  DRAIN_BYPASS_KEY,
  GRANT_DAYS,
  grantProblem,
  makeGrant,
  type BypassGrant,
} from '../../../../scripts/drain-bypass.ts';
import { canonicalProjectRoot } from '../../../../scripts/main-checkout.ts';
import type { StorageView } from './shared-storage.ts';

/** The tool input both tools take. */
interface ProjectInput {
  project: string;
  allow?: boolean;
}

/**
 * The project's canonical root, refusing anything but the exact root folder,
 * so the approval card always names the folder the grant is for.
 *
 * @throws {Error} For a relative path, a missing folder, a subfolder or a worktree.
 */
export function exactRoot(project: string): string {
  if (!path.isAbsolute(project))
    throw new Error(`project must be an absolute path, not ${project}`);
  let real: string;
  try {
    real = realpathSync(project);
  } catch {
    throw new Error(`no folder at ${project}`);
  }
  const root = canonicalProjectRoot(real, { timeoutMs: 10_000 });
  if (root !== real) {
    throw new Error(`${project} is not a project's main checkout; its root is ${root}`);
  }
  return root;
}

/** The stored grants, by root. */
async function grants(storage: StorageView): Promise<Record<string, BypassGrant>> {
  const data = (await storage.loadData()) as Record<string, unknown> | null;
  const value = data?.[DRAIN_BYPASS_KEY];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, BypassGrant>) }
    : {};
}

/**
 * `set_drain_bypass`: record a grant (allow true) or remove it (allow false).
 * DorkOS calls this only after a person granted the approval.
 *
 * @param storage - The extension's storage view.
 * @param input - `{ project, allow }`, already checked against the schema.
 * @param now - The time now.
 */
export async function setDrainBypass(
  storage: StorageView,
  input: unknown,
  now: Date
): Promise<Record<string, unknown>> {
  const { project, allow } = input as ProjectInput;
  const root = exactRoot(project);
  const next = await grants(storage);
  if (allow === true) {
    next[root] = makeGrant(root, now);
  } else {
    delete next[root];
  }
  await storage.saveData({ [DRAIN_BYPASS_KEY]: next });
  if (allow !== true) return { project: root, allowed: false };
  const expires = new Date(now.getTime() + GRANT_DAYS * 24 * 60 * 60 * 1000);
  return {
    project: root,
    allowed: true,
    expiresAt: expires.toISOString(),
    note: `Unattended flow sessions in this project may start with every approval bypassed until ${expires.toISOString()}, or until .agents/flow/config.json or config.local.json changes, whichever comes first.`,
  };
}

/**
 * `get_drain_bypass`: whether a grant holds for a project now.
 *
 * @param storage - The extension's storage view.
 * @param input - `{ project }`.
 * @param now - The time now.
 */
export async function getDrainBypass(
  storage: StorageView,
  input: unknown,
  now: Date
): Promise<Record<string, unknown>> {
  const { project } = input as ProjectInput;
  const root = exactRoot(project);
  const grant = (await grants(storage))[root];
  if (grant === undefined) return { project: root, allowed: false, reason: 'no grant' };
  const problem = grantProblem(grant, root, now);
  return problem === null
    ? { project: root, allowed: true, grantedAt: grant.grantedAt }
    : { project: root, allowed: false, reason: problem };
}
