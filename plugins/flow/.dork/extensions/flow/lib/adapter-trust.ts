/**
 * Whether flow may run a project's own tracker adapter (spec
 * `flow-multiproject` §2.2).
 *
 * The adapter flow ships runs on its own. A project's own adapter
 * (`<root>/.agents/flow/adapters/<tracker>/adapter.ts`) is code committed to
 * that repo, so flow runs it (to read "Up next", or to post a person's answer)
 * only after a person allowed that exact file once. The allow is kept in the
 * extension's storage by root and the file's SHA-256, so a changed adapter
 * asks again. Only the person-only route records one.
 *
 * @module @dorkos/flow/extension/adapter-trust
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

/**
 * The SHA-256 of a project's own adapter, or `null` when it cannot be read.
 *
 * @param root - The project's main checkout.
 * @param tracker - flow's tracker id.
 * @returns The hash.
 */
export function adapterHash(root: string, tracker: string): string | null {
  try {
    return createHash('sha256')
      .update(readFileSync(ownAdapterFile(root, tracker)))
      .digest('hex');
  } catch {
    return null;
  }
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
