// A fake headless `opencode` for engine-tests/launchers/cli-runtime-harness.ts.
// The harness writes it to a temp bin folder as `opencode`, behind a shebang
// naming this Node and a `FAKE_DIR` constant naming the folder its state lives in.
//
//   --version                          prints a version, exits 0
//   run [flags] MESSAGE                a new session: mints a `ses_` id
//   run [flags] --session ID MESSAGE   the same session again
//   export ID                          prints the session as `opencode export`
//                                      does ({ info, messages: [{ info, parts }] }),
//                                      or exits 1 when it does not know the id
//
// A run bills the provider of its `-m provider/model`, else the default in
// FAKE_DIR/default-provider; `other-account` (FAKE_DIR/next-script.json) bills
// "someone-else" instead. Unless scripted `silent`, it records the session's
// user and assistant messages (with `model.providerID` / `providerID`, as
// OpenCode stores them) for `export`, and prints a `step_start` event the way
// `opencode run --format json` prints every event:
// `{ type, timestamp, sessionID, part }`.
//
// Each run records its argv, env, cwd, pid and provider to FAKE_DIR/runs.jsonl,
// touches FAKE_DIR/ready-<pid>, and waits: SIGTERM exits 143, SIGUSR1 exits 1,
// SIGUSR2 exits 0.
/* global FAKE_DIR */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const sessions = path.join(FAKE_DIR, 'sessions');
if (argv[0] === '--version') {
  process.stdout.write('1.18.31\n');
  process.exit(0);
}
if (argv[0] === 'export') {
  process.stderr.write(`Exporting session: ${argv[1]}\n`);
  try {
    process.stdout.write(fs.readFileSync(path.join(sessions, `${argv[1]}.json`), 'utf8'));
    process.exit(0);
  } catch {
    process.stderr.write(`Session not found: ${argv[1]}\n`);
    process.exit(1);
  }
}

const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const resumeId = flag('--session');
const sessionId = resumeId ?? `ses_${crypto.randomBytes(8).toString('hex')}`;
const model = flag('-m');

const scriptFile = path.join(FAKE_DIR, 'next-script.json');
let script = { confirm: 'confirmed' };
try {
  script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  fs.rmSync(scriptFile);
} catch {
  // No script: confirmed.
}
let fallback = 'opencode';
try {
  fallback = fs.readFileSync(path.join(FAKE_DIR, 'default-provider'), 'utf8').trim();
} catch {
  // No default written.
}
const provider =
  script.confirm === 'other-account'
    ? 'someone-else'
    : model !== undefined
      ? model.slice(0, model.indexOf('/'))
      : fallback;

fs.appendFileSync(
  path.join(FAKE_DIR, 'runs.jsonl'),
  `${JSON.stringify({
    kind: resumeId === undefined ? 'start' : 'resume',
    sessionId,
    cwd: process.cwd(),
    provider,
    message: argv[argv.length - 1],
    argv,
    env: { ...process.env },
    pid: process.pid,
  })}\n`
);

if (script.confirm !== 'silent') {
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, `${sessionId}.json`);
  let doc = { info: { id: sessionId, directory: process.cwd() }, messages: [] };
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A new session.
  }
  const modelID = model === undefined ? 'default-model' : model.slice(model.indexOf('/') + 1);
  doc.messages.push(
    {
      info: { role: 'user', sessionID: sessionId, model: { providerID: provider, modelID } },
      parts: [],
    },
    { info: { role: 'assistant', sessionID: sessionId, providerID: provider, modelID }, parts: [] }
  );
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  fs.writeSync(
    1,
    `${JSON.stringify({
      type: 'step_start',
      timestamp: Date.now(),
      sessionID: sessionId,
      part: { type: 'step-start', sessionID: sessionId },
    })}\n`
  );
}

fs.writeFileSync(path.join(FAKE_DIR, `ready-${process.pid}`), '');
process.on('SIGTERM', () => process.exit(143));
process.on('SIGUSR1', () => process.exit(1));
process.on('SIGUSR2', () => process.exit(0));
setInterval(() => undefined, 1 << 30);
