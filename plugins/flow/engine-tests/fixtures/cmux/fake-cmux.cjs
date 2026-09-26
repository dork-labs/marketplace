// A fake `cmux` for engine-tests/launchers/cmux.test.ts. The harness writes it
// to a temp bin folder as `cmux`, behind a shebang naming this Node and a
// `FAKE_DIR` constant naming the folder its state lives in.
//
// It records every argv to FAKE_DIR/argv.jsonl and plays the four commands the
// launcher uses:
//   identify --json            ok, unless control.json scripts a failure
//   workspace create ...       runs --command through a real /bin/sh (whose env,
//                              like a real cmux shell's, exports credentials and
//                              a CLAUDE_CONFIG_DIR of its own), waits for the
//                              fake claude to register, prints the workspace JSON
//   top ... --format tsv       one row per live process, under its surface (and
//                              again under a status tag, as real cmux prints it)
//   send --surface S -- TEXT   delivers TEXT to the claude on S; a trailing
//                              literal \n submits it, which (unless the session
//                              was scripted silent) flips the session busy and
//                              writes its transcript
//   workspace rename W --title T
/* global FAKE_DIR */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dir = FAKE_DIR;
const argv = process.argv.slice(2);
fs.appendFileSync(
  path.join(dir, 'argv.jsonl'),
  `${JSON.stringify({ bin: process.argv[1], argv })}\n`
);

const statePath = path.join(dir, 'state.json');
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const readLines = (file) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l))
    : [];
const state = readJson(statePath, {
  nextWorkspace: 1,
  nextSurface: 1,
  surfaces: {},
  workspaces: {},
});
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const control = readJson(path.join(dir, 'control.json'), {});
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const fail = (message) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
};

function identify() {
  if (control.identify) {
    process.stderr.write(control.identify.stderr);
    process.exit(control.identify.code);
  }
  process.stdout.write(
    `${JSON.stringify({ socket_path: path.join(dir, 'cmux.sock') }, null, 2)}\n`
  );
}

function createWorkspace() {
  const command = flag('--command');
  const cwd = flag('--cwd') ?? process.cwd();
  const workspace = `workspace:${state.nextWorkspace++}`;
  const surface = `surface:${state.nextSurface++}`;
  state.workspaces[workspace] = { title: flag('--name') ?? '' };
  const script = readJson(path.join(dir, 'next-script.json'), { confirm: 'confirmed' });
  fs.rmSync(path.join(dir, 'next-script.json'), { force: true });
  const entry = { workspace, shellPid: null, claudePid: null, script };
  state.surfaces[surface] = entry;
  if (command !== undefined) {
    const shell = spawn('/bin/sh', ['-c', command], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: `${path.join(dir, '..', 'bin')}:/usr/bin:/bin`,
        HOME: path.join(dir, '..', 'home'),
        CLAUDE_CONFIG_DIR: path.join(dir, 'cmux-shell-default'),
        ANTHROPIC_API_KEY: 'cmux-shell-key',
        ANTHROPIC_AUTH_TOKEN: 'cmux-shell-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'cmux-shell-oauth',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
      },
    });
    shell.unref();
    entry.shellPid = shell.pid;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const reg = readLines(path.join(dir, 'claudes.jsonl')).find(
        (r) => r.pid === shell.pid || r.ppid === shell.pid
      );
      if (reg) {
        entry.claudePid = reg.pid;
        break;
      }
      pause(20);
    }
  }
  save();
  process.stdout.write(
    `${JSON.stringify({ workspace_ref: workspace, workspace_id: `FAKE-${workspace}` }, null, 2)}\n`
  );
}

function top() {
  const rows = [['0.0', '0', '0', 'window', 'window:1', 'total', '']];
  for (const [surface, entry] of Object.entries(state.surfaces)) {
    const tag = `${entry.workspace}:tag:claude_code`;
    rows.push(['0.0', '0', '1', 'workspace', entry.workspace, 'window:1', '']);
    rows.push(['0.0', '0', '1', 'tag', tag, entry.workspace, 'Running']);
    rows.push(['0.0', '0', '1', 'pane', `pane:${surface.split(':')[1]}`, entry.workspace, '']);
    rows.push(['0.0', '0', '1', 'surface', surface, `pane:${surface.split(':')[1]}`, '']);
    if (entry.shellPid !== null && alive(entry.shellPid)) {
      rows.push(['0.0', '0', '1', 'process', String(entry.shellPid), surface, 'sh']);
    }
    if (entry.claudePid !== null && alive(entry.claudePid)) {
      rows.push(['0.0', '0', '1', 'process', String(entry.claudePid), tag, 'claude']);
      if (entry.claudePid !== entry.shellPid) {
        rows.push([
          '0.0',
          '0',
          '1',
          'process',
          String(entry.claudePid),
          String(entry.shellPid),
          'claude',
        ]);
      }
    }
  }
  process.stdout.write(rows.map((r) => r.join('\t')).join('\n') + '\n');
}

function send() {
  const surface = flag('--surface');
  if (surface === undefined) fail('send needs --surface in this fake');
  const entry = state.surfaces[surface];
  if (entry === undefined || entry.claudePid === null) fail(`surface ${surface} not found`);
  const text = argv[argv.length - 1];
  const submitted = text.endsWith('\\n');
  const message = submitted ? text.slice(0, -2) : text;
  fs.appendFileSync(
    path.join(dir, 'deliveries.jsonl'),
    `${JSON.stringify({ surface, pid: entry.claudePid, message, submitted })}\n`
  );
  if (!submitted || entry.script.confirm === 'silent') return;
  const reg = readLines(path.join(dir, 'claudes.jsonl')).find((r) => r.pid === entry.claudePid);
  const configDir = reg.env.CLAUDE_CONFIG_DIR ?? path.join(reg.env.HOME, '.claude');
  const sessionFile = path.join(configDir, 'sessions', `${reg.pid}.json`);
  const session = readJson(sessionFile, {});
  fs.writeFileSync(sessionFile, JSON.stringify({ ...session, status: 'busy' }));
  const home =
    entry.script.confirm === 'other-account' ? path.join(dir, 'other-account') : configDir;
  const projects = path.join(home, 'projects', '-fake-project');
  fs.mkdirSync(projects, { recursive: true });
  fs.appendFileSync(
    path.join(projects, `${session.sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', sessionId: session.sessionId, message })}\n`
  );
}

function rename() {
  const workspace = argv[2];
  if (state.workspaces[workspace] === undefined) fail(`workspace ${workspace} not found`);
  state.workspaces[workspace].title = flag('--title');
  save();
}

if (argv[0] === 'identify') identify();
else if (argv[0] === 'workspace' && argv[1] === 'create') createWorkspace();
else if (argv[0] === 'workspace' && argv[1] === 'rename') rename();
else if (argv[0] === 'top') top();
else if (argv[0] === 'send') send();
else fail(`the fake cmux does not play "${argv.join(' ')}"`);
