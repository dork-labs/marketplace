/**
 * The one reader of the `agent:provenance` signature (`docs/provenance.md`
 * §11): it turns a body's last line into a {@link Signature}, the same shape
 * for a version 1 line and a version 2 line, so whatever routes on a
 * signature reads one set of fields. Dependency-free (no imports at all), so
 * the engine's comment rules and the CLI can both read it before
 * `npm install`.
 *
 * What it decides, each pinned by `engine-tests/signature-line.test.ts`:
 *
 * - **Absent, never half-trusted.** A last line that is not a signature, JSON
 *   that does not parse, JSON that is not an object, or a `v` that is not a
 *   positive whole number reads as no signature at all. A missing `v` is 1.
 * - **One field at a time otherwise.** A known field with the wrong type or
 *   shape is left out and the rest of the line stands, as if the writer had
 *   omitted it. Every field a reader can lose this way only ever moves a
 *   router toward its safe path: no chat means route as unsigned, no `host`
 *   means it never matches.
 * - **Fields by version.** Version 1 names its chat by `sessionId`; version 2
 *   by `chat` (`dork:chat:<id>`). Either way {@link Signature.chat} is the
 *   bare id. A `host` counts only when it is an install reference, so an
 *   older line's hostname is never surfaced. `resumeUrl` and `instanceId` are
 *   never read. A version newer than 2 is read as version 2: the fields this
 *   reader knows, the rest ignored.
 *
 * Anyone can paste a signature, so it never proves who wrote a body and never
 * grants a right to deliver (`docs/provenance.md` §13).
 *
 * @module @dorkos/flow/signature-line
 */

/** The two names a signature line is read under: the emitted one, then the legacy one. */
export const SIGNATURE_NAMES = ['agent:provenance', 'flow:provenance'] as const;

/** One of {@link SIGNATURE_NAMES}. */
export type SignatureName = (typeof SIGNATURE_NAMES)[number];

/** A whole provenance line under either accepted name, its name and JSON captured. */
const SIGNATURE_LINE = /^<!--\s*(agent:provenance|flow:provenance)\s+(\{.*\})\s*-->$/;

/** An id inside a reference: 1 to 64 letters, digits, `-` or `_` (the `dork:` grammar). */
const ID = '[A-Za-z0-9_-]{1,64}';

/** A bare chat id, as a version 1 `sessionId` carries it. */
const BARE_ID = new RegExp(`^${ID}$`);

/** `dork:<kind>:<id>` for one kind, the id captured. */
const reference = (kind: string): RegExp => new RegExp(`^dork:${kind}:(${ID})$`);

const CHAT_REF = reference('chat');
const AGENT_REF = reference('agent');
const SPACE_REF = reference('space');
const TURN_REF = reference('turn');

/** An install reference: the prefix and 32 lowercase hex characters, never a hostname. */
const HOST_REF = /^dork:host:[0-9a-f]{32}$/;

/**
 * An address, `dork:<space>/<handle>[/<name>]`: a 2 to 32 character org slug,
 * a 2 to 32 character handle, and an optional 1 to 23 character conversation
 * name, all lowercase, as the `dork:` grammar defines them.
 */
const ADDRESS =
  /^dork:[a-z0-9][a-z0-9-]{0,30}[a-z0-9]\/[a-z0-9][a-z0-9_-]{0,30}[a-z0-9](?:\/[a-z0-9](?:[a-z0-9-]{0,21}[a-z0-9])?)?$/;

/** A harness: `claude-code`, `codex`, `opencode` or `other:<name>`, lowercase. */
const HARNESS = /^(?:other:)?[a-z0-9][a-z0-9._-]{0,31}$/;

/** A surface: `dorkos`, `bare-cli`, `ci`, or a newer word of the same shape. */
const SURFACE = /^[a-z][a-z0-9-]{0,31}$/;

/** An account handle: short, and never an email (no `@` can match). */
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;

/** A signature, read the same way whichever version wrote it. Unknown or malformed fields are absent. */
export interface Signature {
  /** The name the line was written under; `flow:provenance` is the legacy one. */
  name: SignatureName;
  /** The version the line declares; 1 when it declares none. */
  v: number;
  /** The harness that wrote it (`claude-code`, `codex`, `opencode`, `other:<name>`). */
  harness?: string;
  /** Where it was driven from (`dorkos`, `bare-cli`, `ci`). */
  surface?: string;
  /** The harness account handle, never an email. */
  account?: string;
  /**
   * The chat's bare id: a version 1 `sessionId`, or the id in a version 2
   * `chat`. On a public body it may be only the first 8 characters: match it
   * with {@link matchLocalChat}, never as a whole id.
   */
  chat?: string;
  /** The agent, as `dork:agent:<id>` (version 2). */
  agent?: string;
  /** The space the chat belongs to, as `dork:space:<id>` (version 2). */
  space?: string;
  /** The install, as `dork:host:<32 hex>`; never a hostname. */
  host?: string;
  /** The turn that wrote it, as `dork:turn:<id>` (version 2). */
  turn?: string;
  /** The agent's address, as `dork:<space>/<handle>[/<name>]` (version 2). */
  address?: string;
}

/** The optional fields of a {@link Signature}. */
type SignatureField = Exclude<keyof Signature, 'name' | 'v'>;

/** The string at `key` when it is the object's own and matches `shape`, else `undefined`. */
function field(json: Record<string, unknown>, key: string, shape: RegExp): string | undefined {
  if (!Object.hasOwn(json, key)) return undefined;
  const value = json[key];
  return typeof value === 'string' && shape.test(value) ? value : undefined;
}

/**
 * Read one line as a signature.
 *
 * @param line - One line of a body, surrounding space allowed.
 * @returns The signature, or `undefined` when the line is not one that parses.
 */
export function parseSignatureLine(line: string): Signature | undefined {
  const match = SIGNATURE_LINE.exec(line.trim());
  if (match === null) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(match[2]);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const object = json as Record<string, unknown>;
  const v = Object.hasOwn(object, 'v') ? object.v : 1;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return undefined;

  const fields: Partial<Record<SignatureField, string>> = {
    harness: field(object, 'harness', HARNESS),
    surface: field(object, 'surface', SURFACE),
    account: field(object, 'account', ACCOUNT),
    host: field(object, 'host', HOST_REF),
  };
  if (v === 1) {
    fields.chat = field(object, 'sessionId', BARE_ID);
  } else {
    fields.chat = CHAT_REF.exec(field(object, 'chat', CHAT_REF) ?? '')?.[1];
    fields.agent = field(object, 'agent', AGENT_REF);
    fields.space = field(object, 'space', SPACE_REF);
    fields.turn = field(object, 'turn', TURN_REF);
    fields.address = field(object, 'address', ADDRESS);
  }
  const signature: Signature = { name: match[1] as SignatureName, v };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) signature[key as SignatureField] = value;
  }
  return signature;
}

/**
 * The signature a body ends with (`docs/provenance.md` §2: the LAST non-blank
 * line). A signature anywhere else in the body does not count.
 *
 * @param body - A comment, description or PR body.
 * @returns The signature, or `undefined` when the body does not end in one that parses.
 */
export function readSignature(body: string): Signature | undefined {
  return parseSignatureLine(body.trimEnd().split('\n').at(-1) ?? '');
}

/**
 * Whether the last non-blank line of `body` is a provenance line that parses
 * ({@link readSignature}). Anyone can paste such a line, so on its own it
 * never proves who wrote a comment.
 *
 * @param body - A comment body.
 * @returns `true` when the body ends in a valid signature.
 */
export function endsWithSignature(body: string): boolean {
  return readSignature(body) !== undefined;
}

/**
 * The newest signature in a thread that is not this session's own
 * (`docs/provenance.md` §11): a loop that signs its own replies would
 * otherwise find itself at the top. A signature whose chat id is this
 * session's id, or a prefix of it (a public body's 8 characters), is skipped.
 *
 * @param bodies - The thread's bodies, oldest first.
 * @param ownChat - This session's own chat id, when it has one.
 * @returns The newest signature not this session's own, or `undefined` when there is none.
 */
export function newestOtherSignature(
  bodies: readonly string[],
  ownChat?: string
): Signature | undefined {
  for (let index = bodies.length - 1; index >= 0; index--) {
    const signature = readSignature(bodies[index]);
    if (signature === undefined) continue;
    const own =
      ownChat !== undefined &&
      ownChat !== '' &&
      signature.chat !== undefined &&
      ownChat.startsWith(signature.chat);
    if (!own) return signature;
  }
  return undefined;
}

/**
 * The one local chat a signature's chat id names (`docs/provenance.md` §8 and
 * §11): the local ids it is a prefix of, which must be exactly one. None, or
 * more than one, reads as no chat, so the router takes its unsigned path.
 *
 * @param chat - {@link Signature.chat}.
 * @param localChats - The chat ids this install holds; never ids seen only in threads.
 * @returns The matching local id, or `undefined`.
 */
export function matchLocalChat(
  chat: string | undefined,
  localChats: readonly string[]
): string | undefined {
  if (chat === undefined || chat === '') return undefined;
  const hits = new Set(localChats.filter((id) => id.startsWith(chat)));
  return hits.size === 1 ? [...hits][0] : undefined;
}
