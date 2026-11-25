/**
 * The `agent:provenance` line the write verbs sign with (`docs/provenance.md`,
 * task 3.3): what is derived, what is left out, and how a signed body is
 * compared with an earlier post.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProvenance,
  hostRefFor,
  provenanceLine,
  readInstallId,
  signBody,
  trackerVisibility,
  unsignedBody,
} from '../../scripts/cli/provenance.ts';
import { withoutAgent } from '../../scripts/runtime-detect.ts';
import { readSignature } from '../../scripts/signature-line.ts';

/** A made-up install id. */
const INSTALL_ID = '4f7c2c6e-1b0a-4c2a-9a1e-8d3b7f6e5c21';

/** Its reference: `dork:host:` and 32 hex characters of a salted SHA-256, pinned. */
const HOST_REF = 'dork:host:3c594f448c55cbfade7fd79a1915dab8';

/** Made-up ids, in the shapes DorkOS mints. */
const CHAT = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';
const AGENT_ID = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const AGENT = `dork:agent:${AGENT_ID}`;
const SPACE = 'dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA';

/** A run record with every field flow signs with, plus local-only ones. */
const RECORD = {
  v: 2,
  harness: 'claude-code',
  sessionId: 'runtime-session-1',
  account: 'work',
  host: HOST_REF,
  surface: 'dorkos',
  chat: CHAT,
  agent: AGENT,
  space: SPACE,
  instanceId: INSTALL_ID,
  resumeUrl: 'https://example.invalid/r/x',
  worktree: '/Users/someone/w',
  branch: 'topic',
  agentId: 'worker-1',
} as const;

/** The line a private target gets for {@link RECORD}. */
const PRIVATE_LINE = `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"work","agent":"${AGENT}","chat":"dork:chat:${CHAT}","space":"${SPACE}","host":"${HOST_REF}"} -->`;

/** The line a public target gets for {@link RECORD}. */
const PUBLIC_LINE = `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"work","agent":"${AGENT}","chat":"dork:chat:7c1e4b2a","space":"${SPACE}"} -->`;

describe('buildProvenance', () => {
  it('derives the Claude Code harness, account, install, session and surface', () => {
    // Purpose: every field comes from something this process can see; the host
    // is the install reference, never a machine name (DOR-5047).
    expect(
      buildProvenance({
        env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/Users/x/.claude-alt' },
        sessionId: 's-1',
        launcher: 'cmux',
        installId: INSTALL_ID,
      })
    ).toEqual({
      v: 2,
      harness: 'claude-code',
      sessionId: 's-1',
      account: 'claude-alt',
      host: HOST_REF,
      surface: 'bare-cli',
    });
  });

  it('records the DorkOS chat, agent and space a turn names, as DorkOS does', () => {
    // Purpose: DorkOS sets these in every turn; a bare id becomes a reference
    // and a whole reference is kept as given. The run's resume handle stays
    // its own session id.
    expect(
      buildProvenance({
        env: {
          CLAUDECODE: '1',
          DORKOS_SESSION_ID: CHAT,
          DORKOS_AGENT_ID: AGENT_ID,
          DORKOS_SPACE_ID: SPACE,
        },
        sessionId: 's-1',
      })
    ).toEqual({
      v: 2,
      harness: 'claude-code',
      sessionId: 's-1',
      account: 'claude',
      surface: 'dorkos',
      chat: CHAT,
      agent: `dork:agent:${AGENT_ID}`,
      space: SPACE,
    });
  });

  it('names no DorkOS chat, agent or space for a verb a person clicked', () => {
    // Purpose: DorkOS runs a clicked `flow answer` with the agent's variables
    // removed (`withoutAgent`); the person's words must not sign as that chat.
    const env = {
      CLAUDECODE: '1',
      DORKOS_SESSION_ID: CHAT,
      DORKOS_AGENT_ID: AGENT_ID,
      DORKOS_SPACE_ID: SPACE,
      PATH: '/usr/bin',
    };
    const block = buildProvenance({ env: withoutAgent(env) });
    expect(block).toEqual({ v: 2, surface: 'bare-cli' });
  });

  it('decides the surface as DorkOS does: a DorkOS turn, then CI=true, else bare-cli', () => {
    const surface = (env: Record<string, string>, launcher?: string) =>
      buildProvenance({ env, launcher }).surface;
    expect(surface({ DORKOS_SESSION_ID: CHAT, CI: 'true' })).toBe('dorkos');
    expect(surface({}, 'dorkos')).toBe('dorkos');
    expect(surface({ CI: 'true' }, 'cmux')).toBe('ci');
    // Only `true` counts as CI, as DorkOS's builder reads it.
    expect(surface({ CI: '1' })).toBe('bare-cli');
    expect(surface({ DORKOS_SESSION_ID: '' })).toBe('bare-cli');
    expect(surface({})).toBe('bare-cli');
  });

  it('leaves host out without an install, and never takes a hostname for one', () => {
    // Purpose: a machine with no DorkOS install signs no host; a value that is
    // not a UUID (a hostname passed by mistake) is dropped, not sent.
    expect(buildProvenance({ env: { CLAUDECODE: '1' } }).host).toBeUndefined();
    expect(
      buildProvenance({ env: { CLAUDECODE: '1' }, installId: 'Jane-Doe-MacBook-Pro.local' }).host
    ).toBeUndefined();
  });

  it('defaults the account to claude and marks CI', () => {
    // Purpose: an unset CLAUDE_CONFIG_DIR is the default "claude" account; CI wins the surface.
    expect(buildProvenance({ env: { CLAUDECODE: '1', CI: 'true' } })).toEqual({
      v: 2,
      harness: 'claude-code',
      account: 'claude',
      surface: 'ci',
    });
  });

  it('signs the account handle without its leading dot (DOR-2469)', () => {
    // Purpose: `~/.claude-alt` signs as `claude-alt`, and an explicit `~/.claude`
    // as `claude`, the same handle an unset CLAUDE_CONFIG_DIR signs with.
    const account = (dir: string) =>
      buildProvenance({ env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: dir } }).account;
    expect(account('/Users/x/.claude-work')).toBe('claude-work');
    expect(account('/Users/x/.claude')).toBe('claude');
    expect(account('/Users/x/work')).toBe('work');
    // Only one dot goes; a folder that is nothing but a dot signs no account.
    expect(account('/Users/x/..alt')).toBe('.alt');
    expect(account('/Users/x/.')).toBe('x');
    expect(account('/.')).toBeUndefined();
  });

  it('never carries an email in account', () => {
    // Purpose: provenance lands on public threads; an address is dropped whole.
    const block = buildProvenance({
      env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/x/me@example.com' },
    });
    expect(block.account).toBeUndefined();
  });

  it('leaves out what it cannot tell', () => {
    // Purpose: omit, never fabricate; an unknown harness has no account either.
    expect(buildProvenance({ env: {} })).toEqual({ v: 2, surface: 'bare-cli' });
  });
});

describe('hostRefFor', () => {
  it('is a one-way hash of the install id, never the id itself', () => {
    // Purpose: DorkOS's anonymous usage data carries the install id; a signature
    // leaves the machine, so it must not carry that id in any form a reader can
    // match. Every part of the id is absent from the reference.
    const ref = hostRefFor(INSTALL_ID);
    expect(ref).toBe(HOST_REF);
    expect(ref).toMatch(/^dork:host:[0-9a-f]{32}$/);
    for (const part of INSTALL_ID.split('-')) expect(ref).not.toContain(part);
    // Stable per install, whatever the id's case, so a reader can compare its own.
    expect(hostRefFor(INSTALL_ID.toUpperCase())).toBe(ref);
    expect(hostRefFor('11111111-2222-4333-8444-555555555555')).not.toBe(ref);
  });

  it('is undefined without a well-formed install id', () => {
    expect(hostRefFor(undefined)).toBeUndefined();
    expect(hostRefFor('Jane-Doe-MacBook-Pro.local')).toBeUndefined();
  });
});

describe('readInstallId', () => {
  const dirs: string[] = [];
  const tempHome = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'flow-install-id-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reads the UUID DorkOS keeps under DORK_HOME, else ~/.dork', () => {
    // Purpose: the id comes from the file DorkOS writes, from either location.
    const dorkHome = tempHome();
    writeFileSync(path.join(dorkHome, 'telemetry-install-id'), `${INSTALL_ID.toUpperCase()}\n`);
    expect(readInstallId({ DORK_HOME: dorkHome }, '/nowhere')).toBe(INSTALL_ID);
    const osHome = tempHome();
    mkdirSync(path.join(osHome, '.dork'));
    writeFileSync(path.join(osHome, '.dork', 'telemetry-install-id'), INSTALL_ID);
    expect(readInstallId({}, osHome)).toBe(INSTALL_ID);
  });

  it('is undefined when the file is missing or holds something else', () => {
    // Purpose: no install, no host; it never creates the file.
    const dorkHome = tempHome();
    expect(readInstallId({ DORK_HOME: dorkHome }, '/nowhere')).toBeUndefined();
    writeFileSync(path.join(dorkHome, 'telemetry-install-id'), 'not-a-uuid');
    expect(readInstallId({ DORK_HOME: dorkHome }, '/nowhere')).toBeUndefined();
  });
});

describe('provenanceLine', () => {
  it('writes version 2 in the fixed order, and only the wire fields', () => {
    // Purpose: the order DorkOS's builder writes; worktree, branch, worker id,
    // sessionId, instanceId and resumeUrl never go out.
    expect(provenanceLine(RECORD, 'private')).toBe(PRIVATE_LINE);
  });

  it('cuts the chat to 8 and omits host on a public target', () => {
    // Purpose: a PR body is world-readable; the install reference is for
    // private trackers only, and the chat id is an opaque prefix there.
    expect(provenanceLine(RECORD, 'public')).toBe(PUBLIC_LINE);
  });

  it('treats an unknown visibility as public', () => {
    // Purpose: the fail-safe direction is to carry less.
    expect(provenanceLine(RECORD, 'unknown')).toBe(PUBLIC_LINE);
  });

  it('names the chat by the session id outside DorkOS', () => {
    // Purpose: a bare CLI run has no DorkOS chat; its own session is the chat.
    expect(provenanceLine({ v: 2, harness: 'codex', sessionId: 'thread-1' }, 'private')).toBe(
      '<!-- agent:provenance {"v":2,"harness":"codex","chat":"dork:chat:thread-1"} -->'
    );
    // A short id is kept whole in public: there is nothing to cut.
    expect(provenanceLine({ v: 2, sessionId: 'thread-1' }, 'public')).toBe(
      '<!-- agent:provenance {"v":2,"chat":"dork:chat:thread-1"} -->'
    );
  });

  it('drops a field that would not read back, never repairing it', () => {
    // Purpose: build then read must agree; a malformed value goes, the rest stands.
    const line = (fields: Record<string, string>) =>
      provenanceLine({ v: 2, harness: 'claude-code', ...fields }, 'private');
    const bare = '<!-- agent:provenance {"v":2,"harness":"claude-code"} -->';
    expect(line({ sessionId: 'a"b' })).toBe(bare);
    expect(line({ sessionId: 'a/b' })).toBe(bare);
    expect(line({ chat: `dork:chat:${CHAT}` })).toBe(bare);
    expect(line({ account: 'someone@example.com' })).toBe(bare);
    expect(line({ surface: 'Not A Word' })).toBe(bare);
    expect(line({ agent: AGENT_ID })).toBe(bare);
    expect(line({ agent: SPACE })).toBe(bare);
    expect(line({ space: 'dork:space:' })).toBe(bare);
    expect(provenanceLine({ v: 2, harness: 'claude', sessionId: 's' }, 'private')).toBe(
      '<!-- agent:provenance {"v":2,"chat":"dork:chat:s"} -->'
    );
  });

  it.each([
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ])('drops only the field holding a %s, not the whole line', (_name, separator) => {
    // Purpose: a line separator inside a value breaks the whole line for a
    // reader, so each field is checked on its own and only that one goes.
    const provenance = buildProvenance({
      env: {
        CLAUDECODE: '1',
        DORKOS_SESSION_ID: CHAT,
        DORKOS_AGENT_ID: `${AGENT_ID}${separator}`,
        DORKOS_SPACE_ID: `01JD3F1W2KQ8Z0YV9N6B5T4RMA${separator}`,
      },
    });
    const line = provenanceLine(provenance, 'private');
    expect(line).toBe(
      `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"claude","chat":"dork:chat:${CHAT}"} -->`
    );
    expect(line).not.toContain(separator);
    expect(readSignature(`Done.\n${line}`)?.chat).toBe(CHAT);
  });

  it('never puts a hostname on the wire, only an install reference', () => {
    // Purpose: an older run record may still hold a hostname in `host`; the
    // line drops it (DOR-5047). An install reference goes out as it is.
    expect(
      provenanceLine({ v: 1, sessionId: 's', host: 'Jane-Doe-MacBook-Pro.local' }, 'private')
    ).toBe('<!-- agent:provenance {"v":2,"chat":"dork:chat:s"} -->');
    expect(provenanceLine({ v: 1, host: 'dork:host:not-a-hash' }, 'private')).toBeUndefined();
    // A raw install id is the usage id: never on the wire, even under the prefix.
    expect(provenanceLine({ v: 1, host: INSTALL_ID }, 'private')).toBeUndefined();
    expect(provenanceLine({ v: 1, host: `dork:host:${INSTALL_ID}` }, 'private')).toBeUndefined();
    expect(provenanceLine({ v: 1, instanceId: INSTALL_ID }, 'private')).toBeUndefined();
    expect(provenanceLine({ v: 1, host: HOST_REF }, 'private')).toBe(
      `<!-- agent:provenance {"v":2,"host":"${HOST_REF}"} -->`
    );
    expect(provenanceLine({ v: 1, host: HOST_REF }, 'public')).toBeUndefined();
  });

  it('writes no line when only the version is known', () => {
    // Purpose: an empty stamp looks like provenance and routes nothing.
    expect(provenanceLine({ v: 1 }, 'private')).toBeUndefined();
    expect(provenanceLine({ v: 2 }, 'public')).toBeUndefined();
  });

  it('writes version 2 from a version 1 run record', () => {
    // Purpose: a record an older flow wrote (`v: 1`, a session id) signs as
    // version 2 and reads back as the same chat.
    const line = provenanceLine(
      { v: 1, harness: 'claude-code', sessionId: 's-1', host: HOST_REF },
      'private'
    );
    expect(line).toBe(
      `<!-- agent:provenance {"v":2,"harness":"claude-code","chat":"dork:chat:s-1","host":"${HOST_REF}"} -->`
    );
    expect(readSignature(`Done.\n${line}`)).toEqual({
      name: 'agent:provenance',
      v: 2,
      harness: 'claude-code',
      chat: 's-1',
      host: HOST_REF,
    });
  });
});

describe('signBody and unsignedBody', () => {
  it('never carries the raw install id in a signed body', () => {
    // Purpose: end to end, from the install id on disk to the signed text.
    const body = signBody(
      'Done.',
      '— 🤖 /flow',
      buildProvenance({ env: { CLAUDECODE: '1' }, installId: INSTALL_ID }),
      'private'
    );
    expect(body).toContain(HOST_REF);
    expect(body).not.toContain(INSTALL_ID);
  });

  it('signs a tracker declared private with the whole chat and the install', () => {
    // Purpose: a private tracker keeps what flow has always signed there.
    const visibility = trackerVisibility({ visibility: 'private' });
    expect(signBody('Done.', '— 🤖 /flow', RECORD, visibility)).toBe(
      `Done.\n\n— 🤖 /flow\n${PRIVATE_LINE}`
    );
  });

  it.each<[string, { visibility?: unknown }]>([
    ['declared public', { visibility: 'public' }],
    ['not declared', {}],
    ['declared as something else', { visibility: 'Private' }],
  ])('signs a tracker %s with the public cut: chat to 8, no host', (_name, adapter) => {
    // Purpose: unknown is public; an issue on a public repository is world-readable.
    expect(signBody('Done.', '— 🤖 /flow', RECORD, trackerVisibility(adapter))).toBe(
      `Done.\n\n— 🤖 /flow\n${PUBLIC_LINE}`
    );
  });

  it('ends with the marker and the line, and strips back to the same text', () => {
    // Purpose: two posts of one summary from different sessions compare equal.
    const a = signBody('Done.\n', '— 🤖 /flow', { v: 1, sessionId: 'one' }, 'private');
    const b = signBody('Done.', '— 🤖 /flow', { v: 1, sessionId: 'two' }, 'private');
    expect(a).toBe('Done.\n\n— 🤖 /flow\n<!-- agent:provenance {"v":2,"chat":"dork:chat:one"} -->');
    expect(unsignedBody(a)).toBe(unsignedBody(b));
    expect(unsignedBody(a)).toBe('Done.\n\n— 🤖 /flow');
  });

  it('accepts the legacy marker name when stripping', () => {
    // Purpose: readers accept flow:provenance, so the idempotency check must too.
    expect(unsignedBody('Hi\n<!-- flow:provenance {"sessionId":"x"} -->')).toBe('Hi');
  });

  it('strips a v1 line, so a summary an older flow posted compares equal', () => {
    const v2 = signBody('Done.', '— 🤖 /flow', { v: 2, sessionId: 'one' }, 'private');
    const v1 = 'Done.\n\n— 🤖 /flow\n<!-- agent:provenance {"v":1,"sessionId":"two"} -->';
    expect(unsignedBody(v1)).toBe(unsignedBody(v2));
  });
});

/**
 * The same signature from both sides: each row is an environment flow signs
 * in, the line DorkOS's own builder (`buildProvenanceV2` with the fields its
 * `scripts/provenance/provenance-line.ts` reads from that environment) writes
 * for it, and what DorkOS's reader (`readProvenance`) reads back from that line.
 * Copied from DorkOS at d67b809e9, not imported: this repository builds without
 * DorkOS's code. A rule change on either side fails here until they agree.
 */
describe('agrees with the DorkOS builder and reader', () => {
  const DK_AGENT = 'dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J';
  const DK_SPACE = 'dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA';
  const DORKOS_TURN = {
    CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: '/x/.claude-work',
    CLAUDE_CODE_SESSION_ID: CHAT,
    DORKOS_SESSION_ID: CHAT,
    DORKOS_AGENT_ID: '01KJXYKJYW4N8QGQ5W4GB6YM9J',
    DORKOS_SPACE_ID: '01JD3F1W2KQ8Z0YV9N6B5T4RMA',
  };
  const CODEX_THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  const CLAUDE_SESSION = 'c0ffee00-1111-4222-8333-444455556666';

  it.each<{
    name: string;
    env: Record<string, string>;
    sessionId: string;
    visibility: 'private' | 'public';
    line: string;
    read: Record<string, unknown>;
  }>([
    {
      name: 'a DorkOS turn, private',
      env: DORKOS_TURN,
      sessionId: CHAT,
      visibility: 'private',
      line: `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"claude-work","agent":"${DK_AGENT}","chat":"dork:chat:${CHAT}","space":"${DK_SPACE}","host":"${HOST_REF}"} -->`,
      read: {
        name: 'agent:provenance',
        v: 2,
        harness: 'claude-code',
        surface: 'dorkos',
        account: 'claude-work',
        agent: DK_AGENT,
        chat: CHAT,
        space: DK_SPACE,
        host: HOST_REF,
      },
    },
    {
      name: 'a DorkOS turn, public',
      env: DORKOS_TURN,
      sessionId: CHAT,
      visibility: 'public',
      line: `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"claude-work","agent":"${DK_AGENT}","chat":"dork:chat:7c1e4b2a","space":"${DK_SPACE}"} -->`,
      read: {
        name: 'agent:provenance',
        v: 2,
        harness: 'claude-code',
        surface: 'dorkos',
        account: 'claude-work',
        agent: DK_AGENT,
        chat: '7c1e4b2a',
        space: DK_SPACE,
      },
    },
    {
      name: 'bare Claude Code, public',
      env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION },
      sessionId: CLAUDE_SESSION,
      visibility: 'public',
      line: '<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"bare-cli","account":"claude","chat":"dork:chat:c0ffee00"} -->',
      read: {
        name: 'agent:provenance',
        v: 2,
        harness: 'claude-code',
        surface: 'bare-cli',
        account: 'claude',
        chat: 'c0ffee00',
      },
    },
    {
      name: 'bare Codex, private',
      env: { CODEX_THREAD_ID: CODEX_THREAD },
      sessionId: CODEX_THREAD,
      visibility: 'private',
      line: `<!-- agent:provenance {"v":2,"harness":"codex","surface":"bare-cli","chat":"dork:chat:${CODEX_THREAD}","host":"${HOST_REF}"} -->`,
      read: {
        name: 'agent:provenance',
        v: 2,
        harness: 'codex',
        surface: 'bare-cli',
        chat: CODEX_THREAD,
        host: HOST_REF,
      },
    },
    {
      name: 'CI with an email-shaped config dir, private',
      env: {
        CI: 'true',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'run-42',
        CLAUDE_CONFIG_DIR: '/x/me@example.com',
      },
      sessionId: 'run-42',
      visibility: 'private',
      line: `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"ci","chat":"dork:chat:run-42","host":"${HOST_REF}"} -->`,
      read: {
        name: 'agent:provenance',
        v: 2,
        harness: 'claude-code',
        surface: 'ci',
        chat: 'run-42',
        host: HOST_REF,
      },
    },
    {
      name: 'a space given as a reference and an agent id that is not one, public',
      env: {
        CLAUDECODE: '1',
        DORKOS_SESSION_ID: 'abc',
        DORKOS_AGENT_ID: 'not an id',
        DORKOS_SPACE_ID: DK_SPACE,
      },
      sessionId: 'abc',
      visibility: 'public',
      line: `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"claude","chat":"dork:chat:abc","space":"${DK_SPACE}"} -->`,
      read: {
        name: 'agent:provenance',
        v: 2,
        harness: 'claude-code',
        surface: 'dorkos',
        account: 'claude',
        chat: 'abc',
        space: DK_SPACE,
      },
    },
  ])('$name: the same line, read back the same', ({ env, sessionId, visibility, line, read }) => {
    const provenance = buildProvenance({ env, sessionId, installId: INSTALL_ID });
    expect(provenanceLine(provenance, visibility)).toBe(line);
    expect(readSignature(`Done.\n\n— 🤖 /flow\n${line}`)).toEqual(read);
  });
});
