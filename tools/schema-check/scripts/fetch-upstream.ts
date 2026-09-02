/**
 * Downloads the DorkOS schema sources this gate validates against.
 *
 * `@dorkos/skills` and `@dorkos/marketplace` are private workspace packages —
 * they are not on npm and cannot be installed. The dorkos repo is public, so
 * this script fetches the handful of schema modules we need straight from it,
 * at the immutable commit pinned in `upstream.json`, and drops them under
 * `.upstream/` with their original paths intact so their relative imports
 * (`./duration.js`) still resolve. The two bare `@dorkos/*` specifiers those
 * files use are mapped by `tsconfig.json`'s `paths`.
 *
 * The result is real upstream code, not a copy of it: this repo can be wrong
 * about which COMMIT of the schema it validates against, but never about what
 * that schema says.
 *
 * Run via `npm run fetch:upstream`; `check`, `test` and `typecheck` all run it
 * first. It is idempotent — a `.upstream/` already stamped with the pinned ref
 * and holding every pinned file is left alone.
 *
 * @module fetch-upstream
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shape of `upstream.json`. */
export interface UpstreamPin {
  /** `owner/name` of the public GitHub repository the sources come from. */
  repo: string;
  /** Full 40-character commit SHA. A branch or tag would not be reproducible. */
  ref: string;
  /** Repo-relative paths to download, in dependency order (order is cosmetic). */
  files: string[];
}

/** Absolute path to `tools/schema-check/`. */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/** Absolute path to the gitignored directory the pinned sources land in. */
export const upstreamDir = path.join(packageRoot, '.upstream');

/** File recording which ref `.upstream/` currently holds. */
const stampPath = path.join(upstreamDir, '.ref');

/**
 * Read and check the pin.
 *
 * @returns The parsed `upstream.json`.
 * @throws If `ref` is not a full commit SHA — a branch name would make every
 * run validate against different code and quietly change what CI enforces.
 */
export function readPin(): UpstreamPin {
  const pin = JSON.parse(
    readFileSync(path.join(packageRoot, 'upstream.json'), 'utf8')
  ) as UpstreamPin;
  if (!/^[0-9a-f]{40}$/.test(pin.ref)) {
    throw new Error(
      `upstream.json "ref" must be a full 40-character commit SHA, got "${pin.ref}". ` +
        'A branch or tag moves, which would make this gate enforce something different every run.'
    );
  }
  return pin;
}

/**
 * Whether `.upstream/` already holds exactly this pin.
 *
 * @param pin - The pin to check against.
 */
function isCurrent(pin: UpstreamPin): boolean {
  if (!existsSync(stampPath) || readFileSync(stampPath, 'utf8').trim() !== pin.ref) return false;
  return pin.files.every((file) => existsSync(path.join(upstreamDir, file)));
}

/**
 * Download every pinned file into `.upstream/`, replacing whatever was there.
 *
 * @param pin - The pin to materialize.
 */
async function download(pin: UpstreamPin): Promise<void> {
  rmSync(upstreamDir, { recursive: true, force: true });
  for (const file of pin.files) {
    const url = `https://raw.githubusercontent.com/${pin.repo}/${pin.ref}/${file}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Could not download ${file} from ${pin.repo}@${pin.ref} (HTTP ${response.status}). ` +
          'If the file moved upstream, update "files" in upstream.json and the "paths" in tsconfig.json.'
      );
    }
    const target = path.join(upstreamDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, await response.text());
  }
  writeFileSync(stampPath, `${pin.ref}\n`);
}

/**
 * Make sure `.upstream/` holds the pinned sources, downloading them if not.
 *
 * @returns The pin that is now on disk.
 */
export async function ensureUpstream(): Promise<UpstreamPin> {
  const pin = readPin();
  if (!isCurrent(pin)) await download(pin);
  return pin;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const pin = await ensureUpstream();
  console.log(
    `DorkOS schemas ready: ${pin.repo}@${pin.ref.slice(0, 12)} (${pin.files.length} files)`
  );
}
