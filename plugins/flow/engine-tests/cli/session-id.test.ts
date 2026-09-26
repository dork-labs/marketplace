/**
 * `runtimeSession` (`scripts/cli/session-id.ts`): the runtime a `flow` command
 * runs under (from the shared `runtime-detect.ts`) and that runtime's own
 * session id, one case per runtime. It feeds `flow claim`'s session id and
 * `FlowRun.runtime` (spec `flow-cli-core` §1.3, §6).
 */

import { describe, expect, it } from 'vitest';
import { runtimeSession } from '../../scripts/cli/session-id.ts';

describe('runtimeSession', () => {
  // Purpose: Claude Code marks every command with CLAUDECODE=1 and gives its
  // session id in CLAUDE_CODE_SESSION_ID.
  it('reads Claude Code', () => {
    expect(runtimeSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-1' })).toEqual({
      runtime: 'claude-code',
      sessionId: 'cc-1',
    });
    expect(runtimeSession({ CLAUDECODE: '1' })).toEqual({
      runtime: 'claude-code',
      sessionId: null,
    });
  });

  // Purpose: Codex sets CODEX_THREAD_ID for every command it runs; the thread id
  // is its session id.
  it('reads Codex', () => {
    expect(runtimeSession({ CODEX_THREAD_ID: 'thread-1' })).toEqual({
      runtime: 'codex',
      sessionId: 'thread-1',
    });
  });

  // Purpose: OpenCode marks its commands with OPENCODE=1 but puts no session id
  // in their environment, so the id stays unknown rather than guessed.
  it('reads OpenCode, with no session id', () => {
    expect(runtimeSession({ OPENCODE: '1', OPENCODE_PID: '42' })).toEqual({
      runtime: 'opencode',
      sessionId: null,
    });
  });

  // Purpose: nothing set, or only empty values, is no runtime at all, and a
  // stray session variable alone never identifies a runtime.
  it('finds nothing outside a runtime', () => {
    expect(runtimeSession({})).toEqual({ runtime: null, sessionId: null });
    expect(runtimeSession({ CLAUDECODE: '0', CLAUDE_CODE_SESSION_ID: 'x' })).toEqual({
      runtime: null,
      sessionId: null,
    });
  });

  // Purpose: a runtime started from inside another inherits the outer one's
  // variables; the id comes from the runtime detectRuntime picks (the most
  // specific marker), never from the outer runtime.
  it('takes the session id of the runtime detectRuntime picks', () => {
    expect(
      runtimeSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer', CODEX_THREAD_ID: 't' })
    ).toEqual({ runtime: 'codex', sessionId: 't' });
  });
});
