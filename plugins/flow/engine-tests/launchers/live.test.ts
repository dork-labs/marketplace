/**
 * Live launcher smoke (spec `flow-handoff-dispatch` §2.7, task 2.4): one REAL
 * Claude Code session per host, on a named account, in a temp git repo.
 *
 * It spends a few tokens of a real subscription, so it is skipped unless
 * `FLOW_LAUNCHER_LIVE=1` is set, read at module scope so no other file's env
 * stubbing can arm it. It never runs in CI or plain `npm test`.
 *
 * - `FLOW_LAUNCHER_LIVE_ACCOUNT=<id>`: a Claude Code registry id, or `default`
 *   for this computer's own sign-in. The account must be `main` or `rotation`
 *   in `<dorkHome>/flow/fleet.json`; anything else (kept-out, unlisted) is
 *   refused before a session starts.
 * - `FLOW_LAUNCHER_LIVE_HOSTS=cli,cmux,dorkos` (default: all three). A host
 *   whose probe fails is skipped with its reason, never swapped for another.
 *
 * Each case starts a session with the prompt "Reply with the single word
 * ready, then stop.", proves it billed the named account (the launcher's own
 * check), waits for it to settle, stops it, and prints the evidence line.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDorkHome } from '../../scripts/fleet/accounts.ts';
import { realLauncher } from '../../scripts/launchers/real.ts';
import type { HostName, LaunchAccount, SessionState } from '../../scripts/launchers/types.ts';

const LIVE = process.env.FLOW_LAUNCHER_LIVE === '1';
const ACCOUNT_ID = process.env.FLOW_LAUNCHER_LIVE_ACCOUNT ?? '';
const HOSTS = (process.env.FLOW_LAUNCHER_LIVE_HOSTS ?? 'cli,cmux,dorkos')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean) as HostName[];

/** Accounts this smoke may never touch, whatever fleet.json says. */
const NEVER = ['.claude-ab1'];

/** The named account, refused unless the operator gave it a spending role. */
function liveAccount(): LaunchAccount {
  const dorkHome = resolveDorkHome(process.env, os.homedir());
  const fleetFile = path.join(dorkHome, 'flow', 'fleet.json');
  const fleet = existsSync(fleetFile)
    ? (JSON.parse(readFileSync(fleetFile, 'utf8')) as {
        accounts?: Record<string, { role?: string }>;
      })
    : {};
  const role = fleet.accounts?.[`claude-code:${ACCOUNT_ID}`]?.role;
  if (role !== 'main' && role !== 'rotation') {
    throw new Error(
      `claude-code:${ACCOUNT_ID} is ${role ?? 'unlisted'} in fleet.json; the live smoke runs only on a main or rotation account`
    );
  }
  let accountPath: string;
  if (ACCOUNT_ID === 'default') {
    accountPath = path.join(os.homedir(), '.claude');
  } else {
    const config = JSON.parse(readFileSync(path.join(dorkHome, 'config.json'), 'utf8')) as {
      runtimes?: { claudeCode?: { accounts?: { id: string; path: string }[] } };
    };
    const row = config.runtimes?.claudeCode?.accounts?.find((a) => a.id === ACCOUNT_ID);
    if (!row) throw new Error(`claude-code:${ACCOUNT_ID} is not registered`);
    accountPath = row.path;
  }
  if (NEVER.includes(path.basename(accountPath))) {
    throw new Error(`${accountPath} is never used by flow`);
  }
  return { runtime: 'claude-code', id: ACCOUNT_ID, path: accountPath };
}

/** Wait until the session is no longer busy, or the deadline passes. */
async function settle(
  state: () => Promise<SessionState>,
  deadlineMs: number
): Promise<SessionState> {
  let last = await state();
  while (last.kind === 'busy' && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    last = await state();
  }
  return last;
}

describe.skipIf(!LIVE)('live launcher smoke (FLOW_LAUNCHER_LIVE=1)', () => {
  for (const host of HOSTS) {
    // Purpose: DOR-2372's "each launcher starts a real official session on the
    // named account in the named worktree". The launcher's own proof (transcript
    // under the account dir and apiKeySource on cli; the session's reported
    // account on DorkOS) throws wrong-account if it did not.
    it(`${host}: starts a real Claude Code session on the named account`, async () => {
      const account = liveAccount();
      const launcher = realLauncher(host, process.env, os.homedir());
      const probe = await launcher.probe();
      if (!probe.ok) {
        console.log(`[live] ${host}: skipped, ${probe.reason}`);
        return;
      }
      // Inside <dorkHome>/workspaces, where the drain puts worktrees: DorkOS
      // refuses sessions outside the directories it serves (OUTSIDE_BOUNDARY).
      const parent = path.join(
        resolveDorkHome(process.env, os.homedir()),
        'workspaces',
        '.flow-live'
      );
      mkdirSync(parent, { recursive: true });
      const repo = mkdtempSync(path.join(parent, `${host}-`));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        const promptFile = path.join(repo, 'prompt.md');
        writeFileSync(promptFile, 'Reply with the single word ready, then stop.\n');
        const handle = await launcher.start({
          role: 'worker',
          runtime: 'claude-code',
          identifier: 'LIVE-1',
          account,
          cwd: repo,
          promptFile,
          sessionId: randomUUID(),
          permissionMode: 'default',
          title: `flow live smoke (${host})`,
        });
        const final = await settle(() => launcher.state(handle), Date.now() + 180_000);
        const stopped = await launcher.stop(handle);
        console.log(
          `[live] ${host}: account=${account.id} session=${handle.sessionId} cwd=${handle.cwd} config=${handle.configDir ?? account.path} state=${final.kind} stop=${stopped}`
        );
        expect(handle.account).toBe(account.id);
        expect(handle.cwd).toBe(repo);
        expect(final.kind).not.toBe('busy');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }, 300_000);
  }
});
