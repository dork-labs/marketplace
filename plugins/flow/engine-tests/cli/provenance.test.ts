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
  unsignedBody,
} from '../../scripts/cli/provenance.ts';
import { readSignature } from '../../scripts/signature-line.ts';

/** A made-up install id. */
const INSTALL_ID = '4f7c2c6e-1b0a-4c2a-9a1e-8d3b7f6e5c21';

/** Its reference: `dork:host:` and 32 hex characters of a salted SHA-256, pinned. */
const HOST_REF = 'dork:host:3c594f448c55cbfade7fd79a1915dab8';

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
      v: 1,
      harness: 'claude-code',
      sessionId: 's-1',
      account: 'claude-alt',
      host: HOST_REF,
      surface: 'bare-cli',
    });
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
      v: 1,
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
    expect(buildProvenance({ env: {} })).toEqual({ v: 1 });
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
  it('writes only the wire fields, as valid JSON', () => {
    // Purpose: worktree and branch stay local; a quote in a value must not break the JSON.
    const line = provenanceLine({
      v: 1,
      sessionId: 'a"b',
      worktree: '/Users/someone/w',
      branch: 'b',
    });
    expect(line).toBe('<!-- agent:provenance {"v":1,"sessionId":"a\\"b"} -->');
    const json = /\{.*\}/.exec(line ?? '')?.[0] ?? '';
    expect(JSON.parse(json)).toEqual({ v: 1, sessionId: 'a"b' });
  });

  it('never puts a hostname on the wire, only an install reference', () => {
    // Purpose: an older run record may still hold a hostname in `host`; the
    // line drops it (DOR-5047). An install reference goes out as it is.
    expect(provenanceLine({ v: 1, sessionId: 's', host: 'Jane-Doe-MacBook-Pro.local' })).toBe(
      '<!-- agent:provenance {"v":1,"sessionId":"s"} -->'
    );
    expect(provenanceLine({ v: 1, host: 'dork:host:not-a-hash' })).toBeUndefined();
    // A raw install id is the usage id: never on the wire, even under the prefix.
    expect(provenanceLine({ v: 1, host: INSTALL_ID })).toBeUndefined();
    expect(provenanceLine({ v: 1, host: `dork:host:${INSTALL_ID}` })).toBeUndefined();
    expect(provenanceLine({ v: 1, instanceId: INSTALL_ID })).toBeUndefined();
    expect(provenanceLine({ v: 1, host: HOST_REF })).toBe(
      `<!-- agent:provenance {"v":1,"host":"${HOST_REF}"} -->`
    );
  });

  it('writes no line when only the version is known', () => {
    // Purpose: an empty stamp looks like provenance and routes nothing.
    expect(provenanceLine({ v: 1 })).toBeUndefined();
    expect(provenanceLine({ v: 2 })).toBeUndefined();
  });

  it('still writes a v1 line from a v2 run record (DOR-5047, reader first)', () => {
    // Purpose: a newer flow may leave `v: 2` and v2 fields in the run record.
    // This release writes version 1, so the line keeps `"v":1` and version 1's
    // fields only; it never goes out as a v2 line carrying v1 fields.
    const record = {
      v: 2,
      harness: 'claude-code',
      sessionId: 's-1',
      chat: 'dork:chat:s-1',
      agent: 'dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J',
      space: 'dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA',
      turn: 'dork:turn:01JD3F2Z7P1Q4R8S9T0U2V3W4X',
      address: 'dork:acme/owl',
      host: HOST_REF,
    };
    const line = provenanceLine(record);
    expect(line).toBe(
      `<!-- agent:provenance {"v":1,"harness":"claude-code","sessionId":"s-1","host":"${HOST_REF}"} -->`
    );
    // And the reader reads it back as the same chat.
    expect(readSignature(`Done.\n${line}`)).toEqual({
      name: 'agent:provenance',
      v: 1,
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
      buildProvenance({ env: { CLAUDECODE: '1' }, installId: INSTALL_ID })
    );
    expect(body).toContain(HOST_REF);
    expect(body).not.toContain(INSTALL_ID);
  });

  it('ends with the marker and the line, and strips back to the same text', () => {
    // Purpose: two posts of one summary from different sessions compare equal.
    const a = signBody('Done.\n', '— 🤖 /flow', { v: 1, sessionId: 'one' });
    const b = signBody('Done.', '— 🤖 /flow', { v: 1, sessionId: 'two' });
    expect(a).toBe('Done.\n\n— 🤖 /flow\n<!-- agent:provenance {"v":1,"sessionId":"one"} -->');
    expect(unsignedBody(a)).toBe(unsignedBody(b));
    expect(unsignedBody(a)).toBe('Done.\n\n— 🤖 /flow');
  });

  it('accepts the legacy marker name when stripping', () => {
    // Purpose: readers accept flow:provenance, so the idempotency check must too.
    expect(unsignedBody('Hi\n<!-- flow:provenance {"sessionId":"x"} -->')).toBe('Hi');
  });

  it('strips a v2 line, so a summary posted by a v2 emitter compares equal', () => {
    const v1 = signBody('Done.', '— 🤖 /flow', { v: 1, sessionId: 'one' });
    const v2 = 'Done.\n\n— 🤖 /flow\n<!-- agent:provenance {"v":2,"chat":"dork:chat:two"} -->';
    expect(unsignedBody(v2)).toBe(unsignedBody(v1));
  });
});
