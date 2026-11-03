/**
 * The process-ancestry half of the person gate (DOR-3718): which real process
 * chains count as inside an agent. The chains are the shapes read from a live
 * machine, because the check must never refuse a real person: a terminal, an
 * editor's terminal, DorkOS's own terminal, or a click in DorkOS.
 */

import { describe, expect, it } from 'vitest';

import {
  agentInChain,
  callerOf,
  parseProcessTable,
  type ProcessRow,
} from '../../scripts/cli/person-gate.ts';

const APP = '/Applications/DorkOS.app/Contents';
const HELPER = `${APP}/Frameworks/DorkOS Helper.app/Contents/MacOS/DorkOS Helper`;
const SDK_CLAUDE = `${APP}/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
const SDK_CODEX = `${APP}/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`;

const FLOW = 100;

/** A chain from flow upward, one `[exe, args]` per process, ending under launchd. */
function chain(...links: ([string, string?] | string)[]): Map<number, ProcessRow> {
  const rows: ProcessRow[] = [
    { pid: FLOW, ppid: FLOW + 1, tty: '??', exe: 'node', args: 'node flow.ts answer' },
  ];
  links.forEach((link, i) => {
    const [exe, args] = typeof link === 'string' ? [link, link] : link;
    const pid = FLOW + 1 + i;
    rows.push({
      pid,
      ppid: i === links.length - 1 ? 1 : pid + 1,
      tty: '??',
      exe,
      args: args ?? exe,
    });
  });
  return new Map(rows.map((row) => [row.pid, row]));
}

describe('agentInChain', () => {
  it.each<[string, Map<number, ProcessRow>, string]>([
    [
      'Claude Code in DorkOS (the chain read from this machine)',
      chain('/bin/zsh', SDK_CLAUDE, HELPER, `${APP}/MacOS/DorkOS`),
      'claude-code',
    ],
    ['Codex in DorkOS', chain('/bin/zsh', SDK_CODEX, HELPER), 'codex'],
    ["Codex's code-mode host", chain('/bin/sh', `${SDK_CODEX}-code-mode-host`, SDK_CODEX), 'codex'],
    [
      'Claude Code at a terminal',
      chain('zsh', 'claude', 'zsh', 'login', 'Terminal'),
      'claude-code',
    ],
    [
      "Claude Code's native install, whose file is named for its version",
      chain('zsh', ['/Users/x/.local/share/claude/versions/2.1.0', 'claude --resume x']),
      'claude-code',
    ],
    [
      'Claude Code run by node from npm',
      chain('zsh', ['node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js']),
      'claude-code',
    ],
    ['OpenCode', chain('bash', '/opt/homebrew/bin/opencode', 'zsh'), 'opencode'],
    [
      'OpenCode run by node from npm',
      chain('bash', ['node', 'node /usr/lib/node_modules/opencode-ai/bin/opencode']),
      'opencode',
    ],
    [
      'a wrapper between the agent and flow',
      chain('env', 'python3', 'zsh', 'claude'),
      'claude-code',
    ],
    // `sh -c` execs a one-line command, so the agent can be flow's direct parent.
    ['Codex as the direct parent', chain(SDK_CODEX, HELPER), 'codex'],
    [
      'npm-run Claude Code as the direct parent, though it is a node program',
      chain(['node', 'node /x/@anthropic-ai/claude-code/cli.js']),
      'claude-code',
    ],
    // Only `node` and Electron end the walk: DorkOS runs on neither of these.
    [
      'bun as the direct parent, with an agent above',
      chain(['bun', 'bun go.ts'], 'zsh', 'claude'),
      'claude-code',
    ],
    [
      'deno as the direct parent, with an agent above',
      chain(['deno', 'deno run go.ts'], 'zsh', 'claude'),
      'claude-code',
    ],
    // Only a direct parent ends the walk: a server further up never does.
    [
      'a node process above a shell, with an agent above that',
      chain('/bin/zsh', ['node', 'node tool.js'], '/bin/zsh', 'claude'),
      'claude-code',
    ],
  ])('finds %s', (_name, table, agent) => {
    expect(agentInChain(table, FLOW)).toBe(agent);
  });

  it.each<[string, Map<number, ProcessRow>]>([
    [
      'a terminal',
      chain('-zsh', 'login', '/System/Applications/Terminal.app/Contents/MacOS/Terminal'),
    ],
    ['tmux', chain('zsh', 'tmux', 'launchd')],
    [
      "VS Code's terminal",
      chain(
        'zsh',
        '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper',
        '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
      ),
    ],
    ["Cursor's terminal", chain('zsh', 'Cursor Helper', 'Cursor')],
    // Upper case: the desktop app, not the agent it can start.
    [
      'a terminal the Claude desktop app opened',
      chain('zsh', '/Applications/Claude.app/Contents/MacOS/Claude'),
    ],
    // What the Flow extension's verbs look like: flow is DorkOS's direct child.
    ['a click in the Mac app', chain(HELPER, `${APP}/MacOS/DorkOS`)],
    ["DorkOS's own terminal", chain('/bin/zsh', HELPER, `${APP}/MacOS/DorkOS`)],
    [
      'a click in DorkOS started from the dorkos command',
      chain(
        ['node', 'node /usr/local/lib/node_modules/dorkos/dist/bin/cli.js'],
        '-zsh',
        'Terminal'
      ),
    ],
    // DorkOS hosts agents, so an agent above it is not the one acting on a click.
    [
      'a click in a DorkOS an agent started',
      chain(['node', 'node /x/packages/cli/dist/bin/cli.js --no-open'], '/bin/zsh', SDK_CLAUDE),
    ],
    [
      'a click in the Mac app an agent opened',
      chain(HELPER, `${APP}/MacOS/DorkOS`, '/bin/zsh', SDK_CLAUDE),
    ],
    // A click reaches flow directly from the server, whatever started it.
    [
      'a click in a dev server an agent started under tsx',
      chain(
        ['node', 'node --import /x/tsx/loader.mjs src/index.ts'],
        'node',
        '/bin/zsh',
        SDK_CLAUDE
      ),
    ],
    [
      'a click in a server run by a relative path',
      chain(['node', 'node packages/cli/dist/bin/cli.js'], '/bin/zsh', SDK_CLAUDE),
    ],
    [
      'a click in the desktop app in development',
      chain('Electron Helper', 'Electron', 'zsh', 'claude'),
    ],
    // A path with spaces is not cut up into a false name.
    [
      'a program in a folder with a space',
      chain('zsh', ['/Users/x/claude stuff/bin/my term', '/Users/x/claude stuff/bin/my term -l']),
    ],
    // Only the program counts, never what it was given to work on.
    [
      'an argument that names an agent',
      chain('zsh', ['vim', 'vim claude'], ['node', 'node tool.js codex']),
    ],
    ['a folder that names an agent', chain('/Users/x/claude/bin/mytool', '/Users/x/codex/zsh')],
  ])('leaves %s alone', (_name, table) => {
    expect(agentInChain(table, FLOW)).toBeNull();
  });

  // Written down, not wanted: these are why the gate is a guard. A Doe shell has
  // no program of its own to find, and a one-line command runs as DorkOS's direct
  // child, exactly as a click does (`sh -c` execs it). And a process that left
  // the chain by double-forking has launchd for a parent.
  it.each<[string, Map<number, ProcessRow>]>([
    ['a Doe turn', chain(HELPER, `${APP}/MacOS/DorkOS`)],
    ['an orphaned process', chain('launchd')],
    ['an agent going through a small node script', chain(['node', 'node go.js'], 'zsh', 'claude')],
  ])('cannot see %s', (_name, table) => {
    expect(agentInChain(table, FLOW)).toBeNull();
  });

  it('stops at a loop or a missing parent', () => {
    expect(
      agentInChain(
        new Map([
          [FLOW, { pid: FLOW, ppid: 101, tty: '??', exe: 'node', args: 'node' }],
          [101, { pid: 101, ppid: FLOW, tty: '??', exe: 'zsh', args: 'zsh' }],
        ]),
        FLOW
      )
    ).toBeNull();
    expect(agentInChain(new Map(), FLOW)).toBeNull();
  });
});

describe('parseProcessTable', () => {
  it('joins the two reads by pid, keeping a path with spaces whole', () => {
    const table = parseProcessTable(
      ` 100   101 ttys003  node\n  101     1 ??       ${HELPER}\n`,
      ` 100 node flow.ts answer\n  101 ${HELPER} --type=utility\n`
    );
    expect(table.get(100)).toEqual({
      pid: 100,
      ppid: 101,
      tty: 'ttys003',
      exe: 'node',
      args: 'node flow.ts answer',
    });
    expect(table.get(101)?.exe).toBe(HELPER);
    expect(table.get(101)?.args).toBe(`${HELPER} --type=utility`);
  });

  it('skips a line it cannot read', () => {
    expect(parseProcessTable('garbage\n\n', 'garbage\n').size).toBe(0);
  });
});

describe('callerOf', () => {
  it('names the tty and only the last part of the parent, never its arguments', () => {
    const table = new Map<number, ProcessRow>([
      [
        FLOW,
        { pid: FLOW, ppid: 101, tty: 'ttys003', exe: 'node', args: 'node flow.ts --text secret' },
      ],
      [101, { pid: 101, ppid: 1, tty: 'ttys003', exe: '/Users/x/bin/zsh', args: 'zsh -c secret' }],
    ]);
    expect(callerOf(table, FLOW)).toEqual({ tty: 'ttys003', parent: 'zsh', ppid: 101 });
  });

  it('reads no tty as none, and an unreadable table as unknown', () => {
    expect(callerOf(chain(HELPER), FLOW)).toEqual({
      tty: 'none',
      parent: 'DorkOS Helper',
      ppid: 101,
    });
    expect(callerOf(null, FLOW)).toEqual({ tty: 'unknown', parent: 'unknown', ppid: null });
  });
});
