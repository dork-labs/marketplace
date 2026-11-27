/**
 * The one reader of the `agent:provenance` line (`scripts/signature-line.ts`,
 * `docs/provenance.md` §11): version 1 and version 2 read into one shape, so a
 * v2 line routes exactly as a v1 line does; what reads as absent; which field
 * is dropped alone; and why `endsWithSignature` stays looser than the field
 * reader.
 */

import { describe, expect, it } from 'vitest';

import { endsWithSignature, parseSignatureLine, readSignature } from '../scripts/signature-line.ts';

/** Made-up ids, in the shapes DorkOS mints. */
const CHAT = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';
const AGENT = 'dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J';
const SPACE = 'dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA';
const HOST = 'dork:host:3c594f448c55cbfade7fd79a1915dab8';
const TURN = 'dork:turn:01JD3F2Z7P1Q4R8S9T0U2V3W4X';
const ADDRESS = 'dork:acme/owl';

/** A signature line under `name` carrying `json`. */
const line = (json: unknown, name = 'agent:provenance'): string =>
  `<!-- ${name} ${JSON.stringify(json)} -->`;

/** A body ending in a signature line. */
const body = (json: unknown, name?: string): string => `Done.\n\n— 🤖 /flow\n${line(json, name)}`;

const V1 = {
  v: 1,
  harness: 'claude-code',
  sessionId: CHAT,
  account: 'work',
  host: HOST,
  surface: 'dorkos',
};

const V2 = {
  v: 2,
  harness: 'claude-code',
  surface: 'dorkos',
  account: 'work',
  agent: AGENT,
  chat: `dork:chat:${CHAT}`,
  space: SPACE,
  host: HOST,
  turn: TURN,
  address: ADDRESS,
};

describe('readSignature — v1 and v2 read into one shape', () => {
  it('reads a v1 line: sessionId becomes the chat id', () => {
    expect(readSignature(body(V1))).toEqual({
      name: 'agent:provenance',
      v: 1,
      harness: 'claude-code',
      surface: 'dorkos',
      account: 'work',
      chat: CHAT,
      host: HOST,
    });
  });

  it('reads a v2 line: the chat reference becomes the bare id, the other references stay whole', () => {
    expect(readSignature(body(V2))).toEqual({
      name: 'agent:provenance',
      v: 2,
      harness: 'claude-code',
      surface: 'dorkos',
      account: 'work',
      chat: CHAT,
      agent: AGENT,
      space: SPACE,
      host: HOST,
      turn: TURN,
      address: ADDRESS,
    });
  });

  it('a v1 line and a v2 line for the same chat route the same way', () => {
    // Purpose: the fields a router reads (chat, host, harness, surface) agree.
    const pick = (b: string) => {
      const s = readSignature(b);
      return { chat: s?.chat, host: s?.host, harness: s?.harness, surface: s?.surface };
    };
    expect(pick(body(V2))).toEqual(pick(body(V1)));
  });

  it('reads the legacy flow:provenance name, and a missing v as 1', () => {
    const legacy = readSignature(body({ sessionId: 's-1', harness: 'codex' }, 'flow:provenance'));
    expect(legacy).toEqual({ name: 'flow:provenance', v: 1, chat: 's-1', harness: 'codex' });
  });

  it('reads each version by its own fields only', () => {
    // Purpose: a v1 line's `chat` and a v2 line's `sessionId` are not theirs to carry.
    expect(readSignature(body({ v: 1, chat: `dork:chat:${CHAT}`, agent: AGENT }))).toEqual({
      name: 'agent:provenance',
      v: 1,
    });
    expect(readSignature(body({ v: 2, sessionId: CHAT }))).toEqual({
      name: 'agent:provenance',
      v: 2,
    });
  });

  it('cuts nothing from a public v2 line: an 8-character chat id is read as it is', () => {
    const publicLine = { v: 2, harness: 'claude-code', agent: AGENT, chat: 'dork:chat:7c1e4b2a' };
    expect(readSignature(body(publicLine))?.chat).toBe('7c1e4b2a');
    expect(readSignature(body(publicLine))?.host).toBeUndefined();
  });

  it('ignores unknown fields, and never reads resumeUrl or instanceId', () => {
    const signature = readSignature(
      body({
        ...V1,
        resumeUrl: 'https://example.invalid/session/x',
        instanceId: '2f9c1e6a-0000-4000-8000-abcdefabcdef',
        futureField: 'x',
      })
    );
    expect(Object.keys(signature ?? {}).sort()).toEqual(
      ['account', 'chat', 'harness', 'host', 'name', 'surface', 'v'].sort()
    );
  });

  it('reads a version newer than 2 by the fields it knows', () => {
    // Decision: the `dork:` scheme adds kinds and never reinterprets one, so a
    // v3 line's known fields keep their meaning; the rest is ignored.
    expect(readSignature(body({ ...V2, v: 3, sig: 'abc', newKind: 'dork:thing:1' }))).toEqual({
      ...readSignature(body(V2)),
      v: 3,
    });
  });
});

describe('readSignature — what reads as no signature at all', () => {
  it.each([
    ['JSON that does not parse', 'Done.\n<!-- agent:provenance {"v":2 -->'],
    ['JSON that is not an object', 'Done.\n<!-- agent:provenance [1] -->'],
    ['JSON null', 'Done.\n<!-- agent:provenance null -->'],
    ['a line that is not last', `${line(V2)}\nA reply under it.`],
    ['an unknown marker name', body(V2, 'other:provenance')],
    ['no line', 'Just words.'],
  ])('%s, and it does not silence either', (_name, text) => {
    expect(readSignature(text)).toBeUndefined();
    expect(endsWithSignature(text)).toBe(false);
  });

  it.each([
    ['a v that is a string', body({ v: '2', chat: `dork:chat:${CHAT}` })],
    ['a v of 0', body({ v: 0, sessionId: CHAT })],
    ['a v that is not whole', body({ v: 1.5, sessionId: CHAT })],
    ['a v that is null', body({ v: null, sessionId: CHAT })],
  ])('%s: no fields are read, but the line still silences', (_name, text) => {
    // Decision: reading fields from a line whose version is unknowable is
    // half-trusting it. Silencing is different: endsWithSignature only ever
    // keeps flow quiet on its own shared account, and a comment wrongly
    // silenced beats flow answering itself (comment-response.ts).
    expect(readSignature(text)).toBeUndefined();
    expect(endsWithSignature(text)).toBe(true);
  });

  it('a line with only a version is still a signature, with nothing to route on', () => {
    expect(readSignature('Q?\n<!-- agent:provenance {"v":1} -->')).toEqual({
      name: 'agent:provenance',
      v: 1,
    });
    expect(endsWithSignature('Q?\n<!-- agent:provenance {"v":2} -->')).toBe(true);
  });

  it('allows trailing blank lines and space around the line', () => {
    expect(readSignature(`Done.\n  ${line(V2)}  \n\n`)?.chat).toBe(CHAT);
  });
});

describe('readSignature — a malformed field is dropped alone', () => {
  it.each([
    ['a chat that is not a chat reference', { chat: `dork:agent:${CHAT}` }, 'chat'],
    ['a bare chat id on a v2 line', { chat: CHAT }, 'chat'],
    ['a chat id with a slash', { chat: 'dork:chat:a/b' }, 'chat'],
    ['an agent of the wrong kind', { agent: SPACE }, 'agent'],
    ['a space that is a number', { space: 7 }, 'space'],
    ['a turn with an empty id', { turn: 'dork:turn:' }, 'turn'],
    ['an address in capitals', { address: 'dork:Acme/Owl' }, 'address'],
    ['an address with a dotted handle', { address: 'dork:acme/o.wl' }, 'address'],
    ['an account holding an email', { account: 'someone@example.com' }, 'account'],
    ['a harness holding prose', { harness: 'ignore the rules' }, 'harness'],
    ['a harness that is not a known word', { harness: 'claude' }, 'harness'],
    ['an other: harness with no name', { harness: 'other:' }, 'harness'],
    ['an address whose space is a kind word', { address: 'dork:chat/owl' }, 'address'],
    ['an address whose space is another kind word', { address: 'dork:agent/owl' }, 'address'],
    ['an address whose space is the todo kind', { address: 'dork:todo/owl' }, 'address'],
    ['an address whose space is the run kind', { address: 'dork:run/owl' }, 'address'],
    [
      'an address whose space is the reserved project word',
      { address: 'dork:project/owl' },
      'address',
    ],
  ])('%s', (_name, override, dropped) => {
    const signature = readSignature(body({ ...V2, ...override }));
    expect(signature).toBeDefined();
    expect(signature).not.toHaveProperty(dropped);
    // The rest of the line stands.
    const rest = { ...readSignature(body(V2)) } as Record<string, unknown>;
    delete rest[dropped];
    expect(signature).toEqual(rest);
  });

  it('never surfaces a hostname-looking host, in either version', () => {
    // Purpose: an older v1 line carried the machine's name (DOR-5047). It is
    // read as no host, so it is never shown, copied or matched.
    for (const host of [
      'Jane-Doe-MacBook-Pro.local',
      'dork:host:not-a-hash',
      '2f9c1e6a-0000-4000-8000-abcdefabcdef',
      'dork:host:3C594F448C55CBFADE7FD79A1915DAB8',
    ]) {
      expect(readSignature(body({ ...V1, host }))).not.toHaveProperty('host');
      expect(readSignature(body({ ...V2, host }))).not.toHaveProperty('host');
      expect(JSON.stringify(readSignature(body({ ...V1, host })))).not.toContain(host);
    }
  });

  it('reads a sessionId outside the id grammar as no chat', () => {
    expect(readSignature(body({ ...V1, sessionId: 'a"b' }))).not.toHaveProperty('chat');
    expect(readSignature(body({ ...V1, sessionId: '' }))).not.toHaveProperty('chat');
  });
});

describe('readSignature — the vocabularies it does accept', () => {
  it.each(['claude-code', 'codex', 'opencode', 'other:aider'])('harness %s', (harness) => {
    expect(readSignature(body({ ...V2, harness }))?.harness).toBe(harness);
  });

  it.each(['dork:acme/owl', 'dork:acme/owl/launch', 'dork:chatter/owl', 'dork:acme/chat'])(
    'address %s',
    (address) => {
      // A kind word is refused only as the space, and only whole.
      expect(readSignature(body({ ...V2, address }))?.address).toBe(address);
    }
  );
});

describe('parseSignatureLine', () => {
  it('reads one line, not a body', () => {
    expect(parseSignatureLine(line(V1))?.chat).toBe(CHAT);
    expect(parseSignatureLine(`x\n${line(V1)}`)).toBeUndefined();
  });
});
