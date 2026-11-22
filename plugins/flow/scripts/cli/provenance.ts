/**
 * The `agent:provenance` signature the `flow` write verbs stamp (spec
 * `flow-cli-core` §6, `docs/provenance.md`).
 *
 * - {@link buildProvenance} works out what THIS process can determine about
 *   itself: the harness, the session id, the harness account, the DorkOS
 *   install and the surface. Anything it cannot determine is left out, never
 *   guessed. The machine's hostname is never one of them (DOR-5047): `host` is
 *   the install reference `dork:host:<hash>`, a one-way hash of the DorkOS
 *   install id ({@link hostRefFor}), or absent.
 * - {@link provenanceLine} turns that into the one hidden line a signed body
 *   ends with, carrying only the eight wire fields.
 * - {@link signBody} and {@link unsignedBody} add and strip the marker and the
 *   line, so `flow done` can tell whether a summary is already posted.
 *
 * Dependency-free: node builtins only, so it runs before `npm install`.
 *
 * @module @dorkos/flow/cli/provenance
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { FlowRunProvenance } from '../flow-run.ts';
import { runtimeSession } from './session-id.ts';

/** The marker name every signature is emitted under. */
export const PROVENANCE_MARKER = 'agent:provenance';

/** What a `host` value starts with (`docs/provenance.md` §4). */
export const HOST_REF_PREFIX = 'dork:host:';

/** The file under `<dorkHome>` that holds the DorkOS install id, as DorkOS writes it. */
export const INSTALL_ID_FILE = 'telemetry-install-id';

/** A UUID, the only shape a DorkOS install id takes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the install id is hashed with, so the hash serves this one purpose. */
const HOST_REF_SALT = 'dork:host:v1:';

/** A well-formed `host` value: the prefix and 32 lowercase hex characters. */
const HOST_REF = /^dork:host:[0-9a-f]{32}$/;

/** The launchers `--host` accepts (spec §1.3, `FlowRun.host`). */
export const LAUNCHERS = ['cli', 'dorkos', 'cmux'] as const;

/** One of {@link LAUNCHERS}. */
export type Launcher = (typeof LAUNCHERS)[number];

/** The fields that go on the wire (`docs/provenance.md` §4), in emit order. */
const WIRE_FIELDS = [
  'v',
  'harness',
  'sessionId',
  'account',
  'host',
  'surface',
  'instanceId',
  'resumeUrl',
] as const satisfies readonly (keyof FlowRunProvenance)[];

/** What {@link buildProvenance} reads. */
export interface ProvenanceInput {
  /** Environment variables (`CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CI`). */
  env: Readonly<Record<string, string | undefined>>;
  /** `--session`, else `FLOW_SESSION_ID`, else the runtime's own id; absent when none was given. */
  sessionId?: string;
  /** The launcher this session runs under, when known (`--host` or the run record). */
  launcher?: string;
  /** This DorkOS install's id, from {@link readInstallId}; absent outside DorkOS. */
  installId?: string;
}

/**
 * This DorkOS install's id: the UUID in `<dorkHome>/telemetry-install-id`.
 * Read only, never created: a machine without DorkOS has no install, and its
 * signatures carry no `host`.
 *
 * @param env - Environment variables (`DORK_HOME`).
 * @param osHome - The OS home folder, for the `~/.dork` default.
 * @returns The id, or `undefined` when the file is missing, unreadable or not a UUID.
 */
export function readInstallId(
  env: Readonly<Record<string, string | undefined>>,
  osHome: string
): string | undefined {
  // `DORK_HOME`, else `~/.dork`, as `resolveDorkHome` in `../fleet/accounts.ts`;
  // not imported, so this module stays node builtins only.
  const dorkHome =
    env.DORK_HOME !== undefined && env.DORK_HOME !== ''
      ? path.resolve(env.DORK_HOME)
      : path.join(osHome, '.dork');
  try {
    const id = readFileSync(path.join(dorkHome, INSTALL_ID_FILE), 'utf8').trim();
    return UUID.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The install reference a signature carries: `dork:host:` and the first 32 hex
 * characters of a salted SHA-256 of the install id. Never the install id itself:
 * DorkOS's anonymous usage data carries that id, and a signature leaves the
 * machine, so the raw id would tie that data to named projects. The same install
 * always gets the same reference, so a reader compares its own with the line's.
 *
 * @param installId - The install id, from {@link readInstallId}.
 * @returns The reference, or `undefined` when the id is missing or not a UUID.
 */
export function hostRefFor(installId: string | undefined): string | undefined {
  if (installId === undefined || !UUID.test(installId)) return undefined;
  const digest = createHash('sha256')
    .update(HOST_REF_SALT + installId.toLowerCase())
    .digest('hex');
  return `${HOST_REF_PREFIX}${digest.slice(0, 32)}`;
}

/**
 * Whether a `host` value may go on the wire: only a reference shaped like
 * {@link hostRefFor}'s. Anything else (a hostname from an older run record, a
 * raw install id, a launcher name) is dropped, so neither a machine name nor the
 * usage id can leak into a body.
 *
 * @param host - A `host` value.
 * @returns `true` for a well-formed install reference.
 */
export function isHostRef(host: string | undefined): host is string {
  return host !== undefined && HOST_REF.test(host);
}

/**
 * The harness this process runs under, as `../runtime-detect.ts` reads the
 * markers Claude Code, Codex and OpenCode set; anything else is left out rather
 * than guessed.
 *
 * @param env - Environment variables.
 * @returns `claude-code`, `codex` or `opencode`, or `undefined` when the harness cannot be told.
 */
function harnessFrom(env: ProvenanceInput['env']): string | undefined {
  return runtimeSession(env).runtime ?? undefined;
}

/**
 * The harness account handle (`docs/provenance.md` §7): for Claude Code, the
 * basename of `CLAUDE_CONFIG_DIR` without its leading dot (`~/.claude-work`
 * signs `claude-work`, DOR-2469), `claude` when it is unset. A value holding
 * an `@` is dropped whole, never cleaned up.
 *
 * @param harness - The harness, from {@link harnessFrom}.
 * @param env - Environment variables.
 * @returns The handle, or `undefined` when it cannot be derived safely.
 */
function accountFrom(harness: string | undefined, env: ProvenanceInput['env']): string | undefined {
  if (harness !== 'claude-code') return undefined;
  const dir = env.CLAUDE_CONFIG_DIR;
  const handle =
    dir === undefined || dir === ''
      ? 'claude'
      : path.basename(path.resolve(dir)).replace(/^\./, '');
  return handle === '' || handle.includes('@') ? undefined : handle;
}

/**
 * Where the run is driven from: `ci` when `CI` is set, `dorkos` under the
 * DorkOS launcher, `bare-cli` under the other two, else unknown.
 *
 * @param env - Environment variables.
 * @param launcher - The launcher, when known.
 * @returns The surface, or `undefined` when it cannot be told.
 */
function surfaceFrom(env: ProvenanceInput['env'], launcher?: string): string | undefined {
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return 'ci';
  if (launcher === 'dorkos') return 'dorkos';
  if (launcher === 'cli' || launcher === 'cmux') return 'bare-cli';
  return undefined;
}

/**
 * The provenance this process can determine about itself. Every field is
 * optional except `v`; nothing is invented.
 *
 * @param input - The environment, session id, launcher and install id.
 * @returns The provenance block, with unknown fields left out.
 */
export function buildProvenance(input: ProvenanceInput): FlowRunProvenance {
  const harness = harnessFrom(input.env);
  const block: FlowRunProvenance = {
    v: 1,
    harness,
    sessionId: input.sessionId,
    account: accountFrom(harness, input.env),
    host: hostRefFor(input.installId),
    surface: surfaceFrom(input.env, input.launcher),
  };
  return Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined)
  ) as FlowRunProvenance;
}

/**
 * The hidden signature line for a provenance block: the wire fields only (the
 * local-only worktree, branch and worker id never go out), as valid JSON. A
 * `host` that is not an install reference ({@link isHostRef}) is left out, and
 * so is `instanceId`.
 *
 * @param provenance - The block to sign with.
 * @returns The line, or `undefined` when nothing but the version is known
 *   (an empty stamp is worse than none).
 */
export function provenanceLine(provenance: FlowRunProvenance): string | undefined {
  const wire: Record<string, unknown> = {};
  for (const field of WIRE_FIELDS) {
    const value = provenance[field];
    if (field === 'host' && !isHostRef(provenance.host)) continue;
    // The only install UUID DorkOS has is its anonymous usage id (DOR-5047).
    if (field === 'instanceId') continue;
    if (value !== undefined && value !== '') wire[field] = value;
  }
  if (Object.keys(wire).every((key) => key === 'v')) return undefined;
  if (wire.v === undefined) wire.v = 1;
  const ordered = Object.fromEntries(WIRE_FIELDS.filter((f) => f in wire).map((f) => [f, wire[f]]));
  return `<!-- ${PROVENANCE_MARKER} ${JSON.stringify(ordered)} -->`;
}

/**
 * Sign a body for the tracker: the body, a blank line, the identity marker,
 * and the provenance line as the last line when there is one.
 *
 * @param body - The text to post.
 * @param marker - `identity.marker`.
 * @param provenance - The signing session's provenance.
 * @returns The signed body.
 */
export function signBody(body: string, marker: string, provenance: FlowRunProvenance): string {
  const line = provenanceLine(provenance);
  const signed = `${body.trimEnd()}\n\n${marker}`;
  return line === undefined ? signed : `${signed}\n${line}`;
}

/** A trailing signature line under either accepted name. */
const TRAILING_SIGNATURE = /\n?<!--\s*(?:agent|flow):provenance\b[^\n]*-->\s*$/;

/**
 * A body with its trailing provenance line removed, so two posts of the same
 * text from different sessions compare equal ("the same body up to its
 * provenance line").
 *
 * @param body - A comment body.
 * @returns The body without its last signature line, trailing space trimmed.
 */
export function unsignedBody(body: string): string {
  return body.replace(TRAILING_SIGNATURE, '').trimEnd();
}
