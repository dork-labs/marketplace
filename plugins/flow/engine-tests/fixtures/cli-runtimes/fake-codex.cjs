// A fake headless `codex` for engine-tests/launchers/cli-runtime-harness.ts.
// The harness writes it to a temp bin folder as `codex`, behind a shebang
// naming this Node and a `FAKE_DIR` constant naming the folder its state lives in.
//
//   --version                       prints a version, exits 0
//   exec [flags] PROMPT             a new thread: mints a thread id
//   exec [flags] resume ID PROMPT   the same thread again
//
// Each run records its argv, env, cwd and pid to FAKE_DIR/runs.jsonl, then
// (unless FAKE_DIR/next-script.json scripts it `silent`) prints the
// `thread.started` and `turn.started` events `codex exec --json` prints, and
// writes a rollout under <CODEX_HOME>/sessions/YYYY/MM/DD with a session_meta
// line and a token_count line carrying `rate_limits` (plan "pro"), as codex-cli
// writes them. `other-account` writes the rollout under a stranger's home.
// Last it touches FAKE_DIR/ready-<pid>, and waits: SIGTERM exits 143, SIGUSR1
// exits 1, SIGUSR2 exits 0.
/* global FAKE_DIR */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('codex-cli 0.145.0\n');
  process.exit(0);
}
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const resumeAt = argv.indexOf('resume');
const resumeId = resumeAt < 0 ? undefined : argv[resumeAt + 1];
const threadId = resumeId ?? crypto.randomUUID();

const scriptFile = path.join(FAKE_DIR, 'next-script.json');
let script = { confirm: 'confirmed' };
try {
  script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  fs.rmSync(scriptFile);
} catch {
  // No script: confirmed.
}

fs.appendFileSync(
  path.join(FAKE_DIR, 'runs.jsonl'),
  `${JSON.stringify({
    kind: resumeId === undefined ? 'start' : 'resume',
    sessionId: threadId,
    cwd: flag('-C') ?? null,
    spawnCwd: process.cwd(),
    configDir: process.env.CODEX_HOME,
    message: argv[argv.length - 1],
    argv,
    env: { ...process.env },
    pid: process.pid,
  })}\n`
);

if (script.confirm !== 'silent') {
  const out = (event) => fs.writeSync(1, `${JSON.stringify(event)}\n`);
  out({ type: 'thread.started', thread_id: threadId });
  out({ type: 'turn.started' });
  const home =
    script.confirm === 'other-account'
      ? path.join(FAKE_DIR, 'someone-else')
      : process.env.CODEX_HOME;
  const dir = path.join(home, 'sessions', '2026', '09', '26');
  fs.mkdirSync(dir, { recursive: true });
  const rollout = path.join(dir, `rollout-2026-09-26T18-00-00-${threadId}.jsonl`);
  const line = (payload, type) =>
    `${JSON.stringify({ timestamp: '2026-09-26T18:00:00.000Z', type, payload })}\n`;
  fs.appendFileSync(
    rollout,
    line({ id: threadId, session_id: threadId, cwd: flag('-C'), source: 'exec' }, 'session_meta') +
      line(
        {
          type: 'token_count',
          info: null,
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 12, window_minutes: 300, resets_at: 1790000000 },
            secondary: { used_percent: 30, window_minutes: 10080, resets_at: 1790500000 },
            credits: { has_credits: false, unlimited: false, balance: '0' },
            plan_type: 'pro',
            rate_limit_reached_type: null,
          },
        },
        'event_msg'
      )
  );
}

fs.writeFileSync(path.join(FAKE_DIR, `ready-${process.pid}`), '');
process.on('SIGTERM', () => process.exit(143));
process.on('SIGUSR1', () => process.exit(1));
process.on('SIGUSR2', () => process.exit(0));
setInterval(() => undefined, 1 << 30);
