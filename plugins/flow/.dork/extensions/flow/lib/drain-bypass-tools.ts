/**
 * The two agent tools behind a person's grant for unattended bypass (DOR-3062).
 *
 * - `set_drain_bypass` is declared `destructive` in `extension.json`, so DorkOS
 *   runs it only after a person grants the approval card, bound to this exact
 *   input (the project's root and on/off). It records or removes the grant.
 * - `get_drain_bypass` is `observe`: whether a grant holds for a project now,
 *   and why not.
 *
 * The grants live in `drain-bypass.json` in the extension's own files folder
 * (`ctx.filesDir`), never in its general data blob: DorkOS's
 * `PUT /api/extensions/:id/data` writes that blob with no person check, and no
 * DorkOS route writes the files folder. This handler is the file's only writer.
 * The flow CLI reads it (`scripts/drain-bypass.ts`); no flow verb writes it.
 *
 * @module @dorkos/flow/extension/drain-bypass-tools
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  GRANT_DAYS,
  GRANT_FILE,
  grantProblem,
  makeGrant,
  type BypassGrant,
} from '../../../../scripts/drain-bypass.ts';
import { canonicalProjectRoot } from '../../../../scripts/main-checkout.ts';

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
  if (!path.isAbsolute(project)) {
    throw new Error(`project must be an absolute path, not ${project}`);
  }
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

/** The grants file's contents; anything unreadable or not a plain file reads as none. */
function readGrants(file: string): Record<string, BypassGrant> {
  try {
    if (!lstatSync(file).isFile()) return {};
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...(value as Record<string, BypassGrant>) }
      : {};
  } catch {
    return {};
  }
}

/** Write through a temp file and a rename, so the CLI never reads half a file. */
function writeGrants(file: string, grants: Record<string, BypassGrant>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(grants, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** The grants store for one files folder; its changes run one at a time. */
export class GrantStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  /** @param filesDir - The extension's files folder (`ctx.filesDir`). */
  constructor(filesDir: string) {
    this.file = path.join(filesDir, GRANT_FILE);
  }

  /** The grants as stored now. */
  read(): Record<string, BypassGrant> {
    return readGrants(this.file);
  }

  /**
   * Read, change and write inside the queue, so a grant and a revoke made at
   * the same time never undo each other.
   */
  change(fn: (grants: Record<string, BypassGrant>) => void): Promise<void> {
    const run = this.queue.then(() => {
      const grants = readGrants(this.file);
      fn(grants);
      writeGrants(this.file, grants);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

/**
 * `set_drain_bypass`: record a grant (allow true) or remove it (allow false).
 * DorkOS calls this only after a person granted the approval.
 *
 * @param store - The grants store.
 * @param input - `{ project, allow }`, already checked against the schema.
 * @param now - The time now.
 */
export async function setDrainBypass(
  store: GrantStore,
  input: unknown,
  now: Date
): Promise<Record<string, unknown>> {
  const { project, allow } = input as ProjectInput;
  const root = exactRoot(project);
  await store.change((grants) => {
    if (allow === true) grants[root] = makeGrant(root, now);
    else delete grants[root];
  });
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
 * @param store - The grants store.
 * @param input - `{ project }`.
 * @param now - The time now.
 */
export async function getDrainBypass(
  store: GrantStore,
  input: unknown,
  now: Date
): Promise<Record<string, unknown>> {
  const { project } = input as ProjectInput;
  const root = exactRoot(project);
  const grant = store.read()[root];
  if (grant === undefined) return { project: root, allowed: false, reason: 'no grant' };
  const problem = grantProblem(grant, root, now);
  return problem === null
    ? { project: root, allowed: true, grantedAt: grant.grantedAt }
    : { project: root, allowed: false, reason: problem };
}
