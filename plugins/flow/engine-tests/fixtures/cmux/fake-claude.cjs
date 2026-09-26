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
fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'sessions', `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), status: 'idle' })
);
fs.appendFileSync(
  path.join(FAKE_DIR, 'claudes.jsonl'),
  `${JSON.stringify({ pid: process.pid, ppid: process.ppid, argv, env: { ...process.env }, cwd: process.cwd() })}\n`
);
process.on('SIGTERM', () => process.exit(143));
setInterval(() => undefined, 1 << 30);
