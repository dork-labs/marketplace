/**
 * The `agent:provenance` signature the `flow` write verbs stamp (spec
 * `flow-cli-core` §6, `docs/provenance.md`).
 *
 * - {@link buildProvenance} works out what THIS process can determine about
 *   itself: the harness, the session id, the harness account, the machine and
 *   the surface. Anything it cannot determine is left out, never guessed.
 * - {@link provenanceLine} turns that into the one hidden line a signed body
 *   ends with, carrying only the eight wire fields.
 * - {@link signBody} and {@link unsignedBody} add and strip the marker and the
 *   line, so `flow done` can tell whether a summary is already posted.
 *
 * Dependency-free: node builtins only, so it runs before `npm install`.
 *
 * @module @dorkos/flow/cli/provenance
 */

import path from 'node:path';

import type { FlowRunProvenance } from '../flow-run.ts';

/** The marker name every signature is emitted under. */
export const PROVENANCE_MARKER = 'agent:provenance';

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
  /** `--session`, else `FLOW_SESSION_ID`; absent when neither was given. */
  sessionId?: string;
  /** The launcher this session runs under, when known (`--host` or the run record). */
  launcher?: string;
  /** This machine's hostname. */
  hostname: string;
}

/**
 * The harness this process runs under. Only Claude Code marks its child
 * processes (`CLAUDECODE=1`); anything else is left out rather than guessed.
 *
 * @param env - Environment variables.
 * @returns `claude-code`, or `undefined` when the harness cannot be told.
 */
function harnessFrom(env: ProvenanceInput['env']): string | undefined {
  return env.CLAUDECODE === '1' ? 'claude-code' : undefined;
}

/**
 * The harness account handle (`docs/provenance.md` §7): for Claude Code, the
 * basename of `CLAUDE_CONFIG_DIR`, `claude` when it is unset. A value holding
 * an `@` is dropped whole, never cleaned up.
 *
 * @param harness - The harness, from {@link harnessFrom}.
 * @param env - Environment variables.
 * @returns The handle, or `undefined` when it cannot be derived safely.
 */
function accountFrom(harness: string | undefined, env: ProvenanceInput['env']): string | undefined {
  if (harness !== 'claude-code') return undefined;
  const dir = env.CLAUDE_CONFIG_DIR;
  const handle = dir === undefined || dir === '' ? 'claude' : path.basename(path.resolve(dir));
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
 * @param input - The environment, session id, launcher and hostname.
 * @returns The provenance block, with unknown fields left out.
 */
export function buildProvenance(input: ProvenanceInput): FlowRunProvenance {
  const harness = harnessFrom(input.env);
  const block: FlowRunProvenance = {
    v: 1,
    harness,
    sessionId: input.sessionId,
    account: accountFrom(harness, input.env),
    host: input.hostname === '' ? undefined : input.hostname,
    surface: surfaceFrom(input.env, input.launcher),
  };
  return Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined)
  ) as FlowRunProvenance;
}

/**
 * The hidden signature line for a provenance block: the wire fields only (the
 * local-only worktree, branch and worker id never go out), as valid JSON.
 *
 * @param provenance - The block to sign with.
 * @returns The line, or `undefined` when nothing but the version is known
 *   (an empty stamp is worse than none).
 */
export function provenanceLine(provenance: FlowRunProvenance): string | undefined {
  const wire: Record<string, unknown> = {};
  for (const field of WIRE_FIELDS) {
    const value = provenance[field];
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
