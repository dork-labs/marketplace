/**
 * The `agent:provenance` signature the `flow` write verbs stamp (spec
 * `flow-cli-core` §6, `docs/provenance.md`).
 *
 * - {@link buildProvenance} works out what THIS process can determine about
 *   itself: the harness, the session id, the harness account, the DorkOS
 *   install, the surface, and under DorkOS the chat, the agent and the space.
 *   Anything it cannot determine is left out, never guessed. The machine's
 *   hostname is never one of them (DOR-5047): `host` is the install reference
 *   `dork:host:<hash>`, a one-way hash of the DorkOS install id
 *   ({@link hostRefFor}), or absent.
 * - {@link provenanceLine} turns that into the one hidden version 2 line a
 *   signed body ends with, cut for where it is posted
 *   ({@link ProvenanceVisibility}). It follows DorkOS's own builder
 *   (`buildProvenanceV2` in DorkOS's `@dorkos/shared/provenance`) rule for
 *   rule: the same field order, the same public cut, and a field that would
 *   not read back is dropped (`docs/provenance.md` §2, §8).
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
import { parseSignatureLine, type Signature } from '../signature-line.ts';
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

/** The signature version {@link provenanceLine} writes. */
const PROVENANCE_VERSION = 2;

/**
 * The version 2 fields flow writes, in the fixed order every emitter uses
 * (`v`, then these; `docs/provenance.md` §4). Flow knows no turn and no
 * address, so it writes neither.
 */
const LINE_FIELDS = [
  'harness',
  'surface',
  'account',
  'agent',
  'chat',
  'space',
  'host',
] as const satisfies readonly (keyof Signature)[];

/** Fields a public (or unknown) target never carries. */
const PRIVATE_ONLY: ReadonlySet<(typeof LINE_FIELDS)[number]> = new Set(['host']);

/** A bare chat id, as the `dork:` grammar spells an id. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** How many characters of a chat id a public target carries. */
export const PUBLIC_CHAT_ID_LENGTH = 8;

/**
 * Where a signed body is posted. `unknown` is treated as `public`: the
 * fail-safe direction is to carry less (`docs/provenance.md` §8).
 *
 * Flow reads no forge's visibility, so it signs forge text (a PR body, a PR
 * comment) as `public`. Tracker text takes the visibility the tracker's
 * adapter declares ({@link trackerVisibility}).
 */
export type ProvenanceVisibility = 'public' | 'private' | 'unknown';

/**
 * The visibility to sign tracker text with: what the adapter declares, and
 * `unknown` (signed as public) when it declares nothing or anything else.
 *
 * @param adapter - The tracker adapter, or anything carrying its declaration.
 * @returns The visibility for {@link signBody}.
 */
export function trackerVisibility(adapter: { visibility?: unknown }): ProvenanceVisibility {
  return adapter.visibility === 'private' || adapter.visibility === 'public'
    ? adapter.visibility
    : 'unknown';
}

/** What {@link buildProvenance} reads. */
export interface ProvenanceInput {
  /**
   * Environment variables (`CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CI`, and the
   * `DORKOS_SESSION_ID`, `DORKOS_AGENT_ID` and `DORKOS_SPACE_ID` DorkOS sets in
   * every turn).
   */
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

/** An environment variable's value, with an empty one treated as unset. */
function envValue(env: ProvenanceInput['env'], name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Where the run is driven from, as DorkOS's builder decides it: `dorkos`
 * inside a DorkOS turn (DorkOS sets `DORKOS_SESSION_ID`) or under the DorkOS
 * launcher, `ci` when `CI` is `true`, and otherwise `bare-cli`.
 *
 * @param env - Environment variables.
 * @param launcher - The launcher, when known.
 * @returns The surface.
 */
function surfaceFrom(env: ProvenanceInput['env'], launcher?: string): string {
  if (envValue(env, 'DORKOS_SESSION_ID') !== undefined || launcher === 'dorkos') return 'dorkos';
  if (env.CI === 'true') return 'ci';
  return 'bare-cli';
}

/**
 * A bare id as `dork:<kind>:<id>`; a value already in `dork:` form is kept as
 * given. Not checked here: {@link provenanceLine} drops what would not read back.
 *
 * @param kind - The reference kind.
 * @param value - A bare id or a whole reference, when set.
 * @returns The reference, or `undefined`.
 */
function asReference(kind: 'agent' | 'space', value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith('dork:') ? value : `dork:${kind}:${value}`;
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
    v: PROVENANCE_VERSION,
    harness,
    sessionId: input.sessionId,
    account: accountFrom(harness, input.env),
    host: hostRefFor(input.installId),
    surface: surfaceFrom(input.env, input.launcher),
    chat: envValue(input.env, 'DORKOS_SESSION_ID'),
    agent: asReference('agent', envValue(input.env, 'DORKOS_AGENT_ID')),
    space: asReference('space', envValue(input.env, 'DORKOS_SPACE_ID')),
  };
  return Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined)
  ) as FlowRunProvenance;
}

/** The line for a set of wire fields, `v` first. */
function lineFor(wire: Readonly<Record<string, string>>): string {
  return `<!-- ${PROVENANCE_MARKER} ${JSON.stringify({ v: PROVENANCE_VERSION, ...wire })} -->`;
}

/**
 * The hidden version 2 signature line for a provenance block, as valid JSON
 * in the fixed order `v, harness, surface, account, agent, chat, space, host`.
 *
 * - The chat is the block's DorkOS chat, else its session id, written as
 *   `dork:chat:<id>`. A public or unknown target carries only its first
 *   {@link PUBLIC_CHAT_ID_LENGTH} characters and no `host`.
 * - `host` goes out only as an install reference ({@link isHostRef}), so a
 *   hostname an older run record holds never leaves the machine.
 * - Every field is checked on its own by reading it back through flow's own
 *   reader (`../signature-line.ts`): one that would not read back as written
 *   (an account holding `@`, a malformed reference, a line separator) is
 *   dropped alone, never repaired.
 * - The local-only fields (worktree, branch, worker id) and `sessionId`,
 *   `instanceId` and `resumeUrl` are never written.
 *
 * Whatever `v` the block holds, the line is version 2, built from the fields
 * this module knows.
 *
 * @param provenance - The block to sign with.
 * @param visibility - Where the body is posted.
 * @returns The line, or `undefined` when nothing but the version is known
 *   (an empty stamp is worse than none).
 */
export function provenanceLine(
  provenance: FlowRunProvenance,
  visibility: ProvenanceVisibility
): string | undefined {
  const isPrivate = visibility === 'private';
  const chatId = provenance.chat ?? provenance.sessionId;
  const cutChat =
    chatId !== undefined && CHAT_ID.test(chatId)
      ? isPrivate
        ? chatId
        : chatId.slice(0, PUBLIC_CHAT_ID_LENGTH)
      : undefined;
  const candidate: Partial<Record<(typeof LINE_FIELDS)[number], string>> = {
    harness: provenance.harness,
    surface: provenance.surface,
    account: provenance.account,
    agent: provenance.agent,
    chat: cutChat === undefined ? undefined : `dork:chat:${cutChat}`,
    space: provenance.space,
    host: isHostRef(provenance.host) ? provenance.host : undefined,
  };
  // What each field must read back as: the chat reads back as its bare id.
  const readsAs = { ...candidate, chat: cutChat };
  const wire: Record<string, string> = {};
  for (const field of LINE_FIELDS) {
    const value = candidate[field];
    if (typeof value !== 'string' || value === '') continue;
    if (!isPrivate && PRIVATE_ONLY.has(field)) continue;
    // Each field on its own, as DorkOS's builder checks them: one bad value
    // (a line separator breaks the whole line for a reader) drops only itself.
    if (parseSignatureLine(lineFor({ [field]: value }))?.[field] === readsAs[field]) {
      wire[field] = value;
    }
  }
  return Object.keys(wire).length === 0 ? undefined : lineFor(wire);
}

/**
 * Sign a body for the tracker: the body, a blank line, the identity marker,
 * and the provenance line as the last line when there is one. Only a tracker
 * declared `private` gets the whole chat id and the install reference; any
 * other gets the public cut ({@link trackerVisibility}).
 *
 * @param body - The text to post.
 * @param marker - `identity.marker`.
 * @param provenance - The signing session's provenance.
 * @param visibility - The tracker's, from {@link trackerVisibility}.
 * @returns The signed body.
 */
export function signBody(
  body: string,
  marker: string,
  provenance: FlowRunProvenance,
  visibility: ProvenanceVisibility
): string {
  const line = provenanceLine(provenance, visibility);
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
