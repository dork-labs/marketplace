/**
 * The `agent:provenance` line the write verbs sign with (`docs/provenance.md`,
 * task 3.3): what is derived, what is left out, and how a signed body is
 * compared with an earlier post.
 */

import { describe, expect, it } from 'vitest';

import {
  buildProvenance,
  provenanceLine,
  signBody,
  unsignedBody,
} from '../../scripts/cli/provenance.ts';

describe('buildProvenance', () => {
  it('derives the Claude Code harness, account, host, session and surface', () => {
    // Purpose: every field comes from something this process can see.
    expect(
      buildProvenance({
        env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/Users/x/.claude-alt' },
        sessionId: 's-1',
        launcher: 'cmux',
        hostname: 'box',
      })
    ).toEqual({
      v: 1,
      harness: 'claude-code',
      sessionId: 's-1',
      account: '.claude-alt',
      host: 'box',
      surface: 'bare-cli',
    });
  });

  it('defaults the account to claude and marks CI', () => {
    // Purpose: an unset CLAUDE_CONFIG_DIR is the default "claude" account; CI wins the surface.
    expect(buildProvenance({ env: { CLAUDECODE: '1', CI: 'true' }, hostname: 'h' })).toEqual({
      v: 1,
      harness: 'claude-code',
      account: 'claude',
      host: 'h',
      surface: 'ci',
    });
  });

  it('never carries an email in account', () => {
    // Purpose: provenance lands on public threads; an address is dropped whole.
    const block = buildProvenance({
      env: { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/x/me@example.com' },
      hostname: 'h',
    });
    expect(block.account).toBeUndefined();
  });

  it('leaves out what it cannot tell', () => {
    // Purpose: omit, never fabricate; an unknown harness has no account either.
    expect(buildProvenance({ env: {}, hostname: '' })).toEqual({ v: 1 });
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

  it('writes no line when only the version is known', () => {
    // Purpose: an empty stamp looks like provenance and routes nothing.
    expect(provenanceLine({ v: 1 })).toBeUndefined();
  });
});

describe('signBody and unsignedBody', () => {
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
});
