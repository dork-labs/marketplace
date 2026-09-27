// A fake interactive `claude` for engine-tests/launchers/cmux.test.ts. The
// harness writes it to the temp bin folder as `claude`, behind a shebang naming
// this Node and a `FAKE_DIR` constant.
//
// Like Claude Code, it writes <CLAUDE_CONFIG_DIR>/sessions/<pid>.json (status
// idle) at startup; then it registers its argv, env and cwd with the fake cmux
// and waits to be signalled. Everything a message does to it (busy, the
// transcript) the fake cmux's `send` writes.
/* global FAKE_DIR */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const sessionId = flag('--resume') ?? flag('--session-id');
// Claude Code's own resolution: the variable, else $HOME/.claude.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, '.claude');
const register = () =>
  fs.appendFileSync(
    path.join(FAKE_DIR, 'claudes.jsonl'),
    `${JSON.stringify({ pid: process.pid, ppid: process.ppid, argv, env: { ...process.env }, cwd: process.cwd() })}\n`
  );
const writeSession = () => {
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), status: 'idle' })
  );
};
let control = {};
try {
  control = JSON.parse(fs.readFileSync(path.join(FAKE_DIR, 'control.json'), 'utf8'));
} catch {
  // No control file: a plain start.
}
if (control.trustPrompt) {
  // Like Claude Code in a folder it has not seen: the workspace-trust dialog
  // shows first, and the session file appears only once it is accepted.
  register();
  const trusted = path.join(FAKE_DIR, `trusted-${process.pid}`);
  const wait = setInterval(() => {
    if (!fs.existsSync(trusted)) return;
    clearInterval(wait);
    writeSession();
  }, 50);
} else {
  writeSession();
  register();
}
process.on('SIGTERM', () => process.exit(143));
setInterval(() => undefined, 1 << 30);
