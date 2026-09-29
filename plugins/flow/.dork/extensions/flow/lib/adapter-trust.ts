/**
 * Whether flow may run a project's own tracker adapter (spec
 * `flow-multiproject` §2.2).
 *
 * The adapter flow ships runs on its own. A project's own adapter
 * (`<root>/.agents/flow/adapters/<tracker>/adapter.ts`) is code committed to
 * that repo, so flow runs it (to read "Up next", or to post a person's answer)
 * only after a person allowed it once. The allow covers every file in the
 * adapter's folder: it is kept in the extension's storage by root and the
 * SHA-256 of all of them, so a change to any file asks again, and an adapter
 * that loads code from outside its folder is never vouched for. Only the
 * person-only route records one: trusting a new code source is a person's
 * call (N11).
 *
 * @module @dorkos/flow/extension/adapter-trust
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_CONFIG_DIR } from '../../../../scripts/config-names.ts';
import type { SharedStorage } from './shared-storage.ts';

/** The storage key: each root's allowed adapter hash. */
export const ADAPTER_TRUST_KEY = 'adapterTrust';

/**
 * The file a project's own adapter runs from.
 *
 * @param root - The project's main checkout.
 * @param tracker - flow's tracker id.
 * @returns Its path.
 */
export function ownAdapterFile(root: string, tracker: string): string {
  return path.join(root, PROJECT_CONFIG_DIR, 'adapters', tracker, 'adapter.ts');
}

/** The most files an adapter's folder may hold for flow to vouch for it. */
const MAX_FILES = 200;

/** Every file under `dir`, relative, sorted; `null` past {@link MAX_FILES} or unreadable. */
function filesUnder(dir: string): string[] | null {
  const found: string[] = [];
  const walk = (at: string): boolean => {
    for (const entry of readdirSync(path.join(dir, at), { withFileTypes: true })) {
      const rel = path.join(at, entry.name);
      if (entry.isDirectory()) {
        if (!walk(rel)) return false;
      } else {
        found.push(rel);
        if (found.length > MAX_FILES) return false;
      }
    }
    return true;
  };
  try {
    return walk('') ? found.sort() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a source file loads code from outside its adapter's folder with a
 * relative import. Such code would run unseen by the allow, so flow refuses
 * to vouch for the adapter. `import type` is erased and allowed.
 */
function reachesOutside(dir: string, file: string, source: string): boolean {
  const pattern =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?['"](\.[^'"]*)['"]|import\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) continue;
    const spec = match[2] ?? match[3];
    const target = path.resolve(path.dirname(path.join(dir, file)), spec);
    const inside = path.relative(dir, target);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return true;
  }
  return false;
}

/**
 * The SHA-256 of a project's own adapter: every file in its folder, by name
 * and contents, so a change to any of them asks again. `null` when the folder
 * cannot be read, holds too many files, or loads code from outside itself.
 *
 * @param root - The project's main checkout.
 * @param tracker - flow's tracker id.
 * @returns The hash.
 */
export function adapterHash(root: string, tracker: string): string | null {
  const dir = path.dirname(ownAdapterFile(root, tracker));
  const files = filesUnder(dir);
  if (files === null || !files.includes('adapter.ts')) return null;
  const hash = createHash('sha256');
  try {
    for (const file of files) {
      const body = readFileSync(path.join(dir, file));
      if (/\.(?:[cm]?[jt]sx?)$/.test(file) && reachesOutside(dir, file, body.toString('utf8'))) {
        return null;
      }
      hash.update(`${file}\0${body.length}\0`).update(body);
    }
  } catch {
    return null;
  }
  return hash.digest('hex');
}

/** Remembers which projects' own adapters a person allowed. */
export class AdapterTrust {
  private allowed: Record<string, string> | null = null;

  /**
   * @param storage - The extension's storage.
   */
  constructor(private readonly storage: SharedStorage) {}

  /** The stored allows, read once. */
  private async read(): Promise<Record<string, string>> {
    if (this.allowed === null) {
      const stored = await this.storage.get(ADAPTER_TRUST_KEY);
      const list: Record<string, string> = {};
      if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        for (const [root, hash] of Object.entries(stored)) {
          if (typeof hash === 'string') list[root] = hash;
        }
      }
      this.allowed ??= list;
    }
    return this.allowed;
  }

  /**
   * Whether a person allowed this exact adapter file.
   *
   * @param root - The project's main checkout.
   * @param tracker - flow's tracker id.
   * @returns True when the file's hash is the one allowed.
   */
  async isAllowed(root: string, tracker: string): Promise<boolean> {
    const hash = adapterHash(root, tracker);
    return hash !== null && (await this.read())[root] === hash;
  }

  /**
   * Allow a project's own adapter as it is now. Called only from the
   * person-only route.
   *
   * @param root - The project's main checkout.
   * @param tracker - flow's tracker id.
   * @returns False when there is no adapter file to allow.
   */
  async allow(root: string, tracker: string): Promise<boolean> {
    const hash = adapterHash(root, tracker);
    if (hash === null) return false;
    await this.read();
    const next = await this.storage.update(ADAPTER_TRUST_KEY, (current) => ({
      ...(typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as Record<string, string>)
        : {}),
      [root]: hash,
    }));
    this.allowed = next;
    return true;
  }
}
