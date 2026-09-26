/**
 * The self-test's `live` tier (DOR-2390, spec `specs/flow-self-improvement` §1),
 * WITHOUT a real model: every run here reaches a stub `claude` put first on
 * `PATH`, which records its argv, cwd and environment and prints a canned
 * stream-json. Nothing here spends money, and nothing is written outside the
 * test's own temp folders.
 *
 * What it pins: the gate (no flag, and CI with the flag), a missing credential
 * failing every case, the budget stop, the environment the child gets, the
 * breach check (a composio call, and a path that escapes through a link or
 * macOS's `/private`), the argv fences, the report shape, and the oracles
 * against what the real `flow` verbs leave in the fake's store.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FLOW_ROOT, main } from '../scripts/selftest.ts';
import { LIVE_CASES, type LiveCase, type RunnableCase } from '../scripts/selftest/live/cases.ts';
import { liveRefusal, resolveCredential } from '../scripts/selftest/live/gate.ts';
import { deniedTools, runLive } from '../scripts/selftest/live/run.ts';
import { findBreach } from '../scripts/selftest/live/breach.ts';
import { makeSandbox } from '../scripts/selftest/live/sandbox.ts';
import type { FakeBacklog } from '../scripts/tracker/fake.ts';

/**
 * The stub `claude`: `auth status` answers from STUB_LOGGED_IN; a run records
 * itself and prints a stream. Unless STUB_NO_INIT is set, the stream starts
 * with an init event naming the credential as Claude Code would (the API key
 * when one is in its env, else `none`, or STUB_API_KEY_SOURCE) and the flow
 * commands as loaded.
 */
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.STUB_LOGGED_IN === '1' }));
  process.exit(0);
}
const dir = process.env.STUB_RECORD_DIR;
const n = fs.readdirSync(dir).length + 1;
const link = path.join('.agents', 'flow', 'adapters', 'fake');
fs.writeFileSync(path.join(dir, 'call-' + n + '.json'), JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  env: process.env,
  config: JSON.parse(fs.readFileSync(path.join('.agents', 'flow', 'config.json'), 'utf8')),
  adapterIsLink: fs.lstatSync(link).isSymbolicLink(),
  adapterTarget: fs.realpathSync(link),
}));
const init = process.env.STUB_NO_INIT
  ? ''
  : JSON.stringify({
      type: 'system',
      subtype: 'init',
      apiKeySource: process.env.STUB_API_KEY_SOURCE || (process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none'),
      slash_commands: ['flow:capture', 'flow:decompose', 'flow:done'],
    }) + '\\n';
const events = init + (process.env.STUB_STREAM
  ? fs.readFileSync(process.env.STUB_STREAM, 'utf8')
  : [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } },
      { type: 'result', subtype: 'success', total_cost_usd: Number(process.env.STUB_COST || '0.1'), num_turns: 3 },
    ].map((e) => JSON.stringify(e)).join('\\n') + '\\n');
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR + '\\n');
process.stdout.write(events);
`;

/** Each case spawns git and a child process; 5 s is too tight on a loaded machine. */
const LIVE_TIMEOUT = 60_000;

let tmp: string;
let bin: string;
let records: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'flow-live-test-')));
  bin = path.join(tmp, 'bin');
  records = path.join(tmp, 'records');
  mkdirSync(bin);
  mkdirSync(records);
  writeFileSync(path.join(bin, 'claude'), STUB);
  chmodSync(path.join(bin, 'claude'), 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** An armed environment whose `claude` is the stub, signed in unless told otherwise. */
function armed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: tmp,
    FLOW_SELFTEST_LIVE: '1',
    STUB_RECORD_DIR: records,
    STUB_LOGGED_IN: '1',
    ...extra,
  };
}

/** Every call the stub recorded, in order. */
function calls(): {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  config: Record<string, unknown>;
  adapterIsLink: boolean;
  adapterTarget: string;
}[] {
  return readdirSync(records)
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
    .map((f) => JSON.parse(readFileSync(path.join(records, f), 'utf8')));
}

/** A runnable case with an oracle that always passes. */
function trivial(id: string): RunnableCase {
  return {
    id,
    prompt: `/flow:status ${id}`,
    maxTurns: 5,
    files: { 'README.md': 'hello\n' },
    backlog: { items: [] },
    oracle: () => undefined,
  };
}

/** Write a stream the stub prints instead of its default. */
function stream(events: unknown[]): string {
  const file = path.join(tmp, 'stream.jsonl');
  writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

/** A stream with one tool call and a result. */
function oneCall(name: string, input: Record<string, unknown>, cost = 0.05): unknown[] {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } },
    { type: 'result', subtype: 'success', total_cost_usd: cost, num_turns: 2 },
  ];
}

/** Run the selftest script's `main` with the given env, in a throwaway project. */
async function runMain(argv: string[], env: Record<string, string>) {
  const project = path.join(tmp, 'project');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    env,
    cwd: project,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  return { code, stdout, stderr, project };
}

describe('the live tier gate', { timeout: LIVE_TIMEOUT }, () => {
  it('refuses without FLOW_SELFTEST_LIVE=1, before anything runs, exit 2', async () => {
    // Purpose: a credential alone arms nothing. The key is set and the stub is
    // signed in, and the run still refuses, starting no tier and no child.
    const env = armed({ ANTHROPIC_API_KEY: 'sk-test' });
    delete env.FLOW_SELFTEST_LIVE;
    for (const tier of ['live', 'all']) {
      const run = await runMain(['--tier', tier, '--json'], env);
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/set FLOW_SELFTEST_LIVE=1/);
      expect(JSON.parse(run.stdout)).toMatchObject({ v: 1, ok: false, error: { code: 2 } });
      expect(existsSync(path.join(run.project, '.dork'))).toBe(false);
    }
    expect(calls()).toHaveLength(0);
    expect(liveRefusal({ FLOW_SELFTEST_LIVE: 'true' })).toMatch(/FLOW_SELFTEST_LIVE=1/);
  });

  it('refuses under CI even with the flag and a credential, exit 2', async () => {
    // Purpose: no workflow may spend. CI wins over everything else set.
    const run = await runMain(
      ['--tier', 'all', '--no-save'],
      armed({ CI: 'true', ANTHROPIC_API_KEY: 'sk-test' })
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/never runs in CI/);
    expect(run.stdout).toBe('');
    expect(calls()).toHaveLength(0);
  });

  it('does not run the live tier by default', { timeout: 120_000 }, async () => {
    // Purpose: an armed environment still runs only fast and scenarios unless
    // live is asked for.
    const run = await runMain(['--json', '--no-save'], armed());
    expect(JSON.parse(run.stdout).tiers).toEqual(['fast', 'scenarios']);
    expect(calls()).toHaveLength(0);
  });
});

describe('the live tier runner', { timeout: LIVE_TIMEOUT }, () => {
  it('fails every case that would run when no credential answers, and runs none', async () => {
    // Purpose: no credential is never a pass and never a skip.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({ STUB_LOGGED_IN: '0' }),
      maxUsd: 1,
    });
    expect(result.credentialSource).toBe('none');
    const runnable = LIVE_CASES.filter((c) => c.skip === undefined).map((c) => `live/${c.id}`);
    expect(runnable.length).toBeGreaterThan(0);
    for (const check of result.checks.filter((c) => runnable.includes(c.id))) {
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/^no credential/);
    }
    expect(result.checks.filter((c) => c.status === 'pass')).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it('stops starting cases once the spend reaches the ceiling, passing what is left', async () => {
    // Purpose: the ceiling is a hard stop between cases, and each child is
    // told only what remains.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({ STUB_COST: '0.6' }),
      maxUsd: 1,
      cases: [trivial('a'), trivial('b'), trivial('c')],
    });
    expect(result.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'skip']);
    expect(result.checks[2].detail).toMatch(/^budget reached/);
    expect(result.spentUsd).toBeCloseTo(1.2);
    const budgets = calls().map((c) => c.argv[c.argv.indexOf('--max-budget-usd') + 1]);
    expect(budgets).toEqual(['1', '0.4']);
  });

  it('hands the child one credential and no tracker or second key', async () => {
    // Purpose: the child cannot reach a real tracker with a leftover token,
    // cannot bill a second account, and cannot arm another live run.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({
        ANTHROPIC_API_KEY: 'sk-chosen',
        CLAUDE_CODE_OAUTH_TOKEN: 'second-credential',
        OPENAI_API_KEY: 'sk-other',
        COMPOSIO_API_KEY: 'c-key',
        COMPOSIO_USER_ID: 'c-user',
        LINEAR_API_TOKEN: 'lin',
        GH_TOKEN: 'gh',
        CLAUDECODE: '1',
        ANTHROPIC_BASE_URL: 'https://proxy.example.test',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
      }),
      maxUsd: 1,
      cases: [trivial('env')],
    });
    expect(result.credentialSource).toBe('anthropic-api-key');
    const { env } = calls()[0];
    expect(env.ANTHROPIC_API_KEY).toBe('sk-chosen');
    const leaked = Object.keys(env).filter(
      (k) =>
        (k.endsWith('_API_KEY') && k !== 'ANTHROPIC_API_KEY') ||
        k.startsWith('COMPOSIO_') ||
        k.startsWith('LINEAR_') ||
        k.startsWith('CLAUDE_CODE_USE_') ||
        [
          'CLAUDE_CODE_OAUTH_TOKEN',
          'GH_TOKEN',
          'FLOW_SELFTEST_LIVE',
          'CLAUDECODE',
          'ANTHROPIC_BASE_URL',
        ].includes(k)
    );
    expect(leaked).toEqual([]);
    expect(env.FLOW_RUNTIME).toBe('claude-code');
    expect(env.FLOW_HARNESS).toBe('selftest');
    expect(env.FLOW_FAKE_BACKLOG).toMatch(/store[/\\]backlog\.json$/);
  });

  it('keeps the OAuth token when it is the credential, and strips an API key then', async () => {
    // Purpose: the order is API key, then token; whichever answered is the only one kept.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', OPENROUTER_API_KEY: 'or' }),
      maxUsd: 1,
      cases: [trivial('oauth')],
    });
    expect(result.credentialSource).toBe('claude-oauth-token');
    const { env } = calls()[0];
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(resolveCredential({}, () => true)?.source).toBe('local-claude-login');
    expect(resolveCredential({ ANTHROPIC_API_KEY: ' ' }, () => false)).toBeUndefined();
  });

  it('runs the child fenced: plugin dir, no MCP, dontAsk, the budget, the sandbox as cwd', async () => {
    // Purpose: the fences are argv; a dropped flag would let the child reach
    // an MCP tracker, prompt, or spend without a cap.
    await runLive({ flowRoot: FLOW_ROOT, env: armed(), maxUsd: 0.75, cases: [trivial('argv')] });
    const [call] = calls();
    const { argv } = call;
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    expect(argv[0]).toBe('-p');
    expect(argv).toContain('--strict-mcp-config');
    expect(after('--setting-sources')).toBe('project,local');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--max-budget-usd')).toBe('0.75');
    expect(after('--plugin-dir')).toBe(FLOW_ROOT);
    expect(after('--output-format')).toBe('stream-json');
    expect(argv).toContain('--verbose');
    expect(after('--max-turns')).toBe('5');
    expect(
      argv.slice(argv.indexOf('--allowed-tools') + 1, argv.indexOf('--disallowed-tools'))
    ).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash(node *)', 'Bash(git *)']);
    const denied = argv.slice(argv.indexOf('--disallowed-tools') + 1);
    expect(denied).toContain(`Edit(/${FLOW_ROOT}/**)`);
    expect(denied).toContain(`Write(/${FLOW_ROOT}/**)`);
    expect(denied).toContain('Edit(.agents/flow/adapters/fake/**)');
    expect(call.config).toMatchObject({ tracker: 'fake', connection: { transport: 'cli' } });
    expect(call.adapterIsLink).toBe(true);
    expect(call.adapterTarget).toBe(
      realpathSync(path.join(FLOW_ROOT, 'adapters', 'reference', 'fake'))
    );
    expect(path.basename(call.cwd)).toBe('project');
    expect(existsSync(call.cwd)).toBe(false); // the sandbox is deleted afterwards
  });

  it('fails a case as a breach when the stream shows a composio call, whatever the oracle says', async () => {
    // Purpose: the oracle passes here; the breach check alone must fail it.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({
        STUB_STREAM: stream(oneCall('Bash', { command: 'composio execute LINEAR_LIST_ISSUES' })),
      }),
      maxUsd: 1,
      cases: [trivial('breach')],
    });
    expect(result.checks[0].status).toBe('fail');
    expect(result.checks[0].detail).toMatch(/^breach: Bash ran a command naming composio/);
    expect(result.checks[0].costUsd).toBeCloseTo(0.05);
  });

  it('reports a run with no result event as a failure, not a pass', async () => {
    // Purpose: a child that died mid-run proves nothing, whatever the store says.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({ STUB_STREAM: stream([]) }),
      maxUsd: 1,
      cases: [trivial('crash')],
    });
    expect(result.checks[0].status).toBe('fail');
    expect(result.checks[0].detail).toMatch(/^did not finish/);
  });

  it('says a run with no result did not finish, with its stderr, before any credential mismatch', async () => {
    // Purpose: a crash that also skipped init must read as a crash, not as a
    // wrong credential; its stderr is the clue.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({
        STUB_STREAM: stream([]),
        STUB_NO_INIT: '1',
        STUB_STDERR: 'boom: out of memory',
      }),
      maxUsd: 1,
      cases: [trivial('crash')],
    });
    expect(result.checks[0].detail).toMatch(
      /^did not finish \(exit 0; .*\); stderr: boom: out of memory$/
    );
    expect(result.checks[0].detail).not.toMatch(/apiKeySource/);
  });

  it('charges a run that reported no cost everything it was allowed, and stops there', async () => {
    // Purpose: an unfinished run (timeout, crash, no result) may have spent up
    // to its --max-budget-usd; counting it as $0 lets the total pass the cap.
    const result = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({ STUB_STREAM: stream([]) }),
      maxUsd: 0.8,
      cases: [trivial('a'), trivial('b')],
    });
    expect(result.checks[0]).toMatchObject({ status: 'fail', costUsd: 0.8 });
    expect(result.checks[0].detail).toMatch(/\$0\.8000 charged, none reported/);
    expect(result.checks[1].status).toBe('skip');
    expect(result.checks[1].detail).toMatch(/^budget reached/);
    expect(result.spentUsd).toBeCloseTo(0.8);
    expect(calls()).toHaveLength(1);
  });

  it('fails a case when the session says a different credential paid than the report names', async () => {
    // Purpose: the report's credentialSource must be the bill that was
    // reached. An apiKeyHelper or another route shows up in init's apiKeySource.
    for (const [extra, source] of [
      [{ STUB_API_KEY_SOURCE: 'apiKeyHelper' }, 'apiKeyHelper'],
      [{ STUB_NO_INIT: '1' }, 'missing'],
    ] as const) {
      const result = await runLive({
        flowRoot: FLOW_ROOT,
        env: armed(extra),
        maxUsd: 1,
        cases: [trivial('who-paid')],
      });
      expect(result.credentialSource).toBe('local-claude-login');
      expect(result.checks[0].status).toBe('fail');
      expect(result.checks[0].detail).toMatch(
        new RegExp(
          `did not pay with local-claude-login: its apiKeySource is ${source}, expected none`
        )
      );
    }
    const keyed = await runLive({
      flowRoot: FLOW_ROOT,
      env: armed({ ANTHROPIC_API_KEY: 'sk-x', STUB_API_KEY_SOURCE: 'none' }),
      maxUsd: 1,
      cases: [trivial('who-paid')],
    });
    expect(keyed.checks[0].detail).toMatch(/expected ANTHROPIC_API_KEY/);
  });
});

describe('the breach check', { timeout: LIVE_TIMEOUT }, () => {
  it('judges paths by realpath: an alias inside is fine, a link or /tmp out is a breach', () => {
    // Purpose: macOS temp folders are /var/... with the realpath /private/var/...;
    // comparing the strings would miss an escape through a link, or flag a
    // legitimate alias.
    const sandbox = path.join(tmp, 'sandbox');
    const outside = path.join(tmp, 'outside');
    mkdirSync(sandbox);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    symlinkSync(outside, path.join(sandbox, 'escape'), 'dir');
    const bounds = { sandbox, flowRoot: FLOW_ROOT, home: tmp };

    // Inside: relative, absolute, and the unresolved alias of the temp folder.
    const alias = path.join(os.tmpdir(), path.relative(realpathSync(os.tmpdir()), sandbox));
    expect(
      findBreach(
        [
          { name: 'Read', input: { file_path: 'notes.md' } },
          { name: 'Write', input: { file_path: path.join(alias, 'new', 'file.md') } },
          { name: 'Read', input: { file_path: path.join(FLOW_ROOT, 'skills', 'x.md') } },
          { name: 'Bash', input: { command: `git status 2>/dev/null` } },
        ],
        bounds
      )
    ).toBeUndefined();

    expect(
      findBreach([{ name: 'Read', input: { file_path: 'escape/secret.txt' } }], bounds)
    ).toMatch(/escape\/secret\.txt, outside/);
    expect(
      findBreach([{ name: 'Write', input: { file_path: '/tmp/summary.md' } }], bounds)
    ).toMatch(/\/tmp\/summary\.md, outside/);
    expect(
      findBreach([{ name: 'Bash', input: { command: `cat ${outside}/secret.txt` } }], bounds)
    ).toMatch(/named .*secret\.txt, outside/);
    expect(findBreach([{ name: 'Grep', input: { path: '~/.ssh' } }], bounds)).toMatch(/~\/\.ssh/);
    for (const tool of [
      'curl https://x.test',
      'wget x',
      'gh issue list',
      'git log | xargs curl x',
      `node -e "require('child_process').execSync('gh pr list')"`,
      'node -e "1" # COMPOSIO',
    ]) {
      expect(findBreach([{ name: 'Bash', input: { command: tool } }], bounds)).toMatch(/naming/);
    }
    for (const fine of ['git grep "linear-issue:"', 'git log --grep linear', 'node --ghost x']) {
      expect(findBreach([{ name: 'Bash', input: { command: fine } }], bounds)).toBeUndefined();
    }
  });

  it('allows writes in the sandbox only: through the adapter link, to the flow root, by redirect', () => {
    // Purpose: the flow root is readable, never writable. The sandbox's
    // adapter folder is a link into the plugin, so a write through it lands
    // in the checkout the oracles run from.
    const s = makeSandbox({ flowRoot: FLOW_ROOT, files: {}, backlog: { items: [] } });
    try {
      const bounds = { sandbox: s.dir, flowRoot: FLOW_ROOT, home: tmp };
      const skill = '.agents/flow/adapters/fake/SKILL.md';
      const one = (name: string, input: Record<string, unknown>) =>
        findBreach([{ name, input }], bounds);
      expect(one('Read', { file_path: skill })).toBeUndefined();
      expect(one('Read', { file_path: path.join(FLOW_ROOT, 'scripts', 'flow.ts') })).toBe(
        undefined
      );
      expect(one('Write', { file_path: 'notes/summary.md' })).toBeUndefined();
      expect(one('Edit', { file_path: skill })).toMatch(
        /^Edit wrote .*SKILL\.md, outside the sandbox/
      );
      expect(one('Edit', { file_path: path.join(s.dir, skill) })).toMatch(/outside the sandbox/);
      expect(one('Write', { file_path: path.join(FLOW_ROOT, 'scripts', 'new.ts') })).toMatch(
        /^Write wrote .*new\.ts, outside the sandbox/
      );
      expect(one('NotebookEdit', { notebook_path: `${FLOW_ROOT}/x.ipynb` })).toMatch(/wrote/);
      expect(one('Bash', { command: `node x.js > ${skill}` })).toMatch(/wrote .*SKILL\.md/);
      expect(one('Bash', { command: `git show HEAD:a 2>> ${FLOW_ROOT}/log` })).toMatch(/wrote/);
      expect(one('Bash', { command: `git diff | tee out.txt ${FLOW_ROOT}/x` })).toMatch(/wrote/);
      expect(one('Bash', { command: `git show HEAD:a > out.txt 2>/dev/null` })).toBeUndefined();
      expect(
        one('Bash', {
          command: `node -e "require('fs').writeFileSync('${FLOW_ROOT}/scripts/x.ts', '')"`,
        })
      ).toMatch(/wrote .*scripts\/x\.ts/);
      expect(
        one('Bash', {
          command: `node --experimental-strip-types ${FLOW_ROOT}/scripts/flow.ts next`,
        })
      ).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it('reads $CLAUDE_PLUGIN_ROOT as the flow root and $PWD as the sandbox, as flow commands spell them', () => {
    // Purpose: commands/flow.md and the stage commands name flow's scripts
    // through ${CLAUDE_PLUGIN_ROOT}; flagging it would fail every paid case.
    const s = makeSandbox({ flowRoot: FLOW_ROOT, files: {}, backlog: { items: [] } });
    try {
      const bounds = { sandbox: s.dir, flowRoot: FLOW_ROOT, home: tmp };
      const bash = (command: string) => findBreach([{ name: 'Bash', input: { command } }], bounds);
      expect(
        bash(
          'node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/scripts/flow.ts" done FAKE-2 --summary-file s.md --json'
        )
      ).toBeUndefined();
      expect(bash('node $CLAUDE_PLUGIN_ROOT/scripts/config-files.ts')).toBeUndefined();
      expect(bash('git -C "$PWD" status')).toBeUndefined();
      expect(bash('node x.js > "${CLAUDE_PLUGIN_ROOT}/scripts/x.ts"')).toMatch(
        /wrote .*scripts\/x\.ts, outside/
      );
      expect(bash('node x.js > $PWD/../escape.txt')).toMatch(/wrote .*escape\.txt, outside/);
      expect(bash('node x.js "${CLAUDE_PLUGIN_ROOTX}/y"')).toMatch(
        /used \$\{CLAUDE_PLUGIN_ROOTX\}/
      );
    } finally {
      s.cleanup();
    }
  });

  it('follows a script written into the sandbox and git aimed elsewhere', () => {
    // Purpose: two routes to a write the path fields never show: a script the
    // agent writes and then runs, and git -C at another repository.
    const s = makeSandbox({ flowRoot: FLOW_ROOT, files: {}, backlog: { items: [] } });
    try {
      const bounds = { sandbox: s.dir, flowRoot: FLOW_ROOT, home: tmp };
      const one = (name: string, input: Record<string, unknown>) =>
        findBreach([{ name, input }], bounds);
      const script = (target: string) =>
        `import { writeFileSync } from 'node:fs';\nwriteFileSync('${target}', 'x');\n`;
      expect(
        one('Write', { file_path: 'write-it.mjs', content: script(`${FLOW_ROOT}/scripts/x.ts`) })
      ).toMatch(/wrote a script that writes .*scripts\/x\.ts, outside/);
      expect(
        one('Write', { file_path: 'w.mjs', content: script('../store/backlog.json') })
      ).toMatch(/writes \.\.\/store\/backlog\.json/);
      expect(
        one('Edit', {
          file_path: 'w.mjs',
          old_string: 'a',
          new_string: script('.agents/flow/adapters/fake/SKILL.md'),
        })
      ).toMatch(/SKILL\.md, outside/);
      expect(
        one('Write', {
          file_path: 'w.mjs',
          content: "require('fs').rmSync(process.env.FLOW_FAKE_BACKLOG)",
        })
      ).toMatch(/process\.env/);
      expect(
        one('Write', { file_path: 'w.mjs', content: script('out/result.json') })
      ).toBeUndefined();
      expect(
        one('Write', { file_path: 'notes.md', content: 'See ../other and /etc/hosts.' })
      ).toBeUndefined();

      const bash = (command: string) => one('Bash', { command });
      const git = 'git';
      expect(bash(`${git} -C ${FLOW_ROOT} reset --hard`)).toMatch(/wrote .*, outside the sandbox/);
      expect(bash(`${git} -C "${FLOW_ROOT}" -c a=b restore .`)).toMatch(/wrote/);
      expect(bash(`${git} --work-tree ${FLOW_ROOT} clean -fd`)).toMatch(/wrote/);
      expect(bash(`${git} -C .agents/flow/adapters/fake commit -am x`)).toMatch(/wrote/);
      expect(bash(`${git} --git-dir=${FLOW_ROOT}/.git commit -m x`)).toMatch(/wrote/);
      expect(bash(`${git} config --global user.name x`)).toMatch(
        /changed git config outside the sandbox/
      );
      expect(bash(`${git} -C ${FLOW_ROOT} log -1`)).toBeUndefined();
      expect(bash(`${git} config user.name x`)).toBeUndefined();
      expect(bash(`${git} add -A && ${git} commit -m "tasks"`)).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it('follows cd through a command: reads from where it is, writes that land outside fail', () => {
    // Purpose: after `cd` into the adapter link, a relative write lands in the
    // real plugin. A cd into the flow root is allowed (reading there is fine),
    // so the write itself must fail there; a cd anywhere else is a breach.
    const s = makeSandbox({
      flowRoot: FLOW_ROOT,
      files: { 'sub/keep.txt': 'x', 'specs/fixture/02-specification.md': '# Spec' },
      backlog: { items: [] },
    });
    try {
      const bounds = { sandbox: s.dir, flowRoot: FLOW_ROOT, home: tmp };
      const bash = (command: string) => findBreach([{ name: 'Bash', input: { command } }], bounds);
      const link = '.agents/flow/adapters/fake';
      const writeAdapter = `node -e "require('fs').writeFileSync('adapter.ts', '')"`;
      expect(bash(`cd ${link} && ${writeAdapter}`)).toMatch(
        /wrote adapter\.ts, outside the sandbox/
      );
      expect(bash(`cd ${link} && node -p 1 > adapter.ts`)).toMatch(/wrote adapter\.ts, outside/);
      expect(bash(`cd ${link}; node -p 1 > $PWD/adapter.ts`)).toMatch(/adapter\.ts, outside/);
      expect(bash(`pushd "\${CLAUDE_PLUGIN_ROOT}/scripts" && node -p 1 > x.ts`)).toMatch(
        /wrote x\.ts, outside/
      );
      expect(bash('cd .. && node -p 1')).toMatch(
        /changed folder to \.\., outside the sandbox and the flow root/
      );
      expect(bash('cd && node -p 1')).toMatch(/changed folder to ~, outside/);
      expect(bash('cd /tmp && git status')).toMatch(/changed folder to \/tmp, outside/);

      // Reads are judged from the folder the command is in; so are writes.
      expect(bash('cd specs/fixture && git status ..')).toBeUndefined();
      expect(bash('cd specs/fixture && node -p 1 > ../x.md')).toBeUndefined();
      expect(
        bash(
          'cd "${CLAUDE_PLUGIN_ROOT}" && node --experimental-strip-types scripts/config-files.ts'
        )
      ).toBeUndefined();
      expect(bash(`cd ${link} && git status`)).toBeUndefined();

      // Inside the sandbox a cd is fine, and paths follow it.
      expect(bash('cd sub && node -p 1 > out.txt')).toBeUndefined();
      expect(bash('cd sub && node -p 1 > $PWD/out.txt')).toBeUndefined();
      expect(bash('cd sub && node -p 1 > $PWD/../top.txt')).toBeUndefined();
      expect(bash('cd sub && git status && cd .. && node -p 1 > top.txt')).toBeUndefined();
      expect(bash('cd sub && node -p 1 > ../../escape.txt')).toMatch(
        /wrote \.\.\/\.\.\/escape\.txt/
      );
      expect(bash('cd sub && pushd . && popd && node -p 1 > ok.txt')).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it('sees the command inside $(...), backticks and a subshell, with its own folder', () => {
    // Purpose: a write hidden in a command substitution runs all the same;
    // a cd inside a nested command ends with it, as in the shell.
    const s = makeSandbox({
      flowRoot: FLOW_ROOT,
      files: { 'sub/keep.txt': 'x' },
      backlog: { items: [] },
    });
    try {
      const bounds = { sandbox: s.dir, flowRoot: FLOW_ROOT, home: tmp };
      const bash = (command: string) => findBreach([{ name: 'Bash', input: { command } }], bounds);
      const link = '.agents/flow/adapters/fake';
      const inner = `cd ${link} && node -e "require('fs').writeFileSync('adapter.ts', '')"`;
      expect(bash(`git commit -m "$(${inner})"`)).toMatch(/wrote adapter\.ts, outside/);
      expect(bash(`node x.js $(${inner})`)).toMatch(/wrote adapter\.ts, outside/);
      expect(bash(`git commit -m "\`${inner}\`"`)).toMatch(/wrote adapter\.ts, outside/);
      expect(bash(`node -p "$(cd .. && git status)"`)).toMatch(/changed folder to \.\./);

      // A cd inside a nested command does not outlast it.
      expect(bash('(cd sub && node -p 1 > ../x.md)')).toBeUndefined();
      expect(bash('(cd sub) && node -p 1 > ../x.md')).toMatch(/wrote \.\.\/x\.md, outside/);
      expect(bash(`git log -1 --format="$(cd ${link} && git status)" > log.txt`)).toBeUndefined();

      // Quoted parentheses and redirects to a descriptor are not nesting or writes.
      expect(bash(`node -e "console.log((1))" > out.txt 2>&1`)).toBeUndefined();
      expect(bash(`node -e 'console.log("$(x)")' > out.txt`)).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  it('flags a path it cannot follow: a .. out of the sandbox, the store variable, $VAR', () => {
    // Purpose: the store is outside the project, reachable only by a path the
    // earlier check missed: a relative `..`, the store's variable, or $HOME.
    const s = makeSandbox({ flowRoot: FLOW_ROOT, files: {}, backlog: { items: [] } });
    try {
      const bounds = { sandbox: s.dir, flowRoot: FLOW_ROOT, home: tmp };
      const bash = (command: string) => findBreach([{ name: 'Bash', input: { command } }], bounds);
      expect(bash(`node -e "require('fs').writeFileSync('../store/backlog.json', '{}')"`)).toMatch(
        /wrote \.\.\/store\/backlog\.json/
      );
      expect(
        bash(`node -e "console.log(require('fs').readFileSync('../store/backlog.json'))"`)
      ).toMatch(/named \.\.\/store\/backlog\.json, outside/);
      expect(bash(`node -e "require('fs').readFileSync(process.env.FLOW_FAKE_BACKLOG)"`)).toMatch(
        /read process\.env/
      );
      expect(bash(`node -e "require('fs').readFileSync(process.env['X'])"`)).toMatch(
        /process\.env/
      );
      expect(bash('git show HEAD:a > $HOME/out')).toMatch(/used \$HOME as a path/);
      expect(bash('node x.js "${TMPDIR}/y"')).toMatch(/used \$\{TMPDIR\} as a path/);
      expect(findBreach([{ name: 'Read', input: { file_path: '$HOME/.ssh/id' } }], bounds)).toMatch(
        /cannot follow/
      );
      expect(bash('git log -1 --format=%H')).toBeUndefined();
      expect(bash('node ./scripts/a.js ../project/README.md')).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });
});

describe('the permission-rule layer', () => {
  it('denies edits in the flow root by path, and skips a path rules would garble', () => {
    // Purpose: a flow root with ( ) or spaces would close or split the rule;
    // such a path gets no rule (the breach check still judges every write).
    expect(deniedTools(FLOW_ROOT)).toContain(`Edit(/${FLOW_ROOT}/**)`);
    for (const odd of ['plugins (copy)', 'my plugins', 'a,b', 'x*y']) {
      const dir = path.join(tmp, odd);
      mkdirSync(dir);
      const rules = deniedTools(dir);
      expect(rules.some((r) => r.includes(odd))).toBe(false);
      expect(rules).toContain('Write(.agents/flow/adapters/fake/**)');
    }
  });
});

describe('the live report', { timeout: LIVE_TIMEOUT }, () => {
  it('reports each case with its cost and turns, the skips with reasons, and who paid', async () => {
    // Purpose: the live tier writes the standard SelftestReport, plus the
    // credential that paid and each case's spend.
    const run = await runMain(['--tier', 'live', '--json', '--no-save'], armed());
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ v: 1, tiers: ['live'], credentialSource: 'local-claude-login' });
    expect(report.checks.map((c: { id: string }) => c.id)).toEqual(
      LIVE_CASES.map((c) => `live/${c.id}`)
    );
    for (const check of report.checks) {
      expect(check.tier).toBe('live');
      expect(check.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      const liveCase = LIVE_CASES.find((c) => `live/${c.id}` === check.id) as LiveCase;
      if (liveCase.skip !== undefined) {
        expect(check).toMatchObject({ status: 'skip', detail: liveCase.skip });
        expect(check.costUsd).toBeUndefined();
      } else {
        expect(check).toMatchObject({ costUsd: 0.1, turns: 3 });
        expect(check.detail).toMatch(/\$0\.1000, 3 turns/);
      }
    }
    // The stub wrote nothing, so every case fails on its oracle: exit 1.
    expect(report.checks.find((c: { id: string }) => c.id === 'live/capture').status).toBe('fail');
    expect(run.code).toBe(1);
    const text = await runMain(['--tier', 'live', '--no-save'], armed());
    expect(text.stdout).toMatch(/Live tier: \$0\.3000 spent, paid by local-claude-login/);
  });
});

describe('the live oracles', { timeout: LIVE_TIMEOUT }, () => {
  /** The case by id. */
  function liveCase(id: string): RunnableCase {
    const found = LIVE_CASES.find((c) => c.id === id);
    if (found === undefined || found.skip !== undefined) throw new Error(`no runnable ${id}`);
    return found;
  }

  /** A stream in which the session loaded the flow commands. */
  const loaded = { slashCommands: ['flow:capture', 'flow:decompose', 'flow:done'], toolUses: [] };

  /** Run the real flow CLI in a case's sandbox, against its store. */
  function flow(sandbox: { dir: string; backlogFile: string }, ...args: string[]) {
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', path.join(FLOW_ROOT, 'scripts', 'flow.ts'), ...args, '--json'],
      {
        cwd: sandbox.dir,
        env: { PATH: process.env.PATH, HOME: tmp, FLOW_FAKE_BACKLOG: sandbox.backlogFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  }

  /** The case's oracle after `act` ran in its sandbox. */
  async function judge(id: string, act: (s: ReturnType<typeof makeSandbox>) => void) {
    const c = liveCase(id);
    const sandbox = makeSandbox({ flowRoot: FLOW_ROOT, files: c.files, backlog: c.backlog });
    try {
      act(sandbox);
      const after = JSON.parse(readFileSync(sandbox.backlogFile, 'utf8')) as FakeBacklog;
      return await c.oracle({ sandbox: sandbox.dir, before: c.backlog, after, stream: loaded });
    } finally {
      sandbox.cleanup();
    }
  }

  /** A valid 03-tasks.json for the decompose fixture. */
  function writeTasks(dir: string, description: string) {
    const task = {
      id: '1.1',
      phase: 1,
      phaseName: 'Build',
      subject: '[fixture] [P1] Add scripts/greet.mjs',
      description,
      activeForm: 'Adding the greeting script',
      size: 'small',
      priority: 'medium',
      dependencies: [],
      parallelWith: [],
    };
    writeFileSync(
      path.join(dir, 'specs', 'fixture', '03-tasks.json'),
      JSON.stringify({
        spec: 'specs/fixture/02-specification.md',
        slug: 'fixture',
        generatedAt: '2026-09-26T12:00:00.000Z',
        mode: 'full',
        lastDecomposeDate: null,
        tasks: [task],
      })
    );
  }

  it('decompose passes on what flow stage and a valid tasks file leave, and fails without either', async () => {
    // Purpose: the oracle reads the sandbox and the store; each missing piece fails it.
    const good = 'Write scripts/greet.mjs printing Hello, <name>!';
    expect(
      await judge('decompose', (s) => {
        flow(s, 'stage', 'FAKE-1', 'decompose');
        writeTasks(s.dir, good);
      })
    ).toBeUndefined();
    expect(await judge('decompose', () => {})).toMatch(/no specs\/fixture\/03-tasks\.json/);
    expect(await judge('decompose', (s) => writeTasks(s.dir, good))).toMatch(
      /does not carry stage\/decompose/
    );
    expect(
      await judge('decompose', (s) => {
        flow(s, 'stage', 'FAKE-1', 'decompose');
        writeTasks(s.dir, 'Implement according to spec.');
      })
    ).toMatch(/summarizes with "implement according to spec"/);
  });

  it('done passes on what flow done leaves, and fails on an item still open', async () => {
    // Purpose: the oracle checks the store the child's flow command wrote, through the linked adapter.
    expect(await judge('done', (s) => flow(s, 'done', 'FAKE-2', '--summary', 'Shipped'))).toBe(
      undefined
    );
    expect(await judge('done', () => {})).toMatch(/not completed/);
    expect(
      await judge('done', (s) => {
        const store = JSON.parse(readFileSync(s.backlogFile, 'utf8')) as FakeBacklog;
        Object.assign(store.items[0], { stateCategory: 'completed', stateName: 'Done' });
        writeFileSync(s.backlogFile, JSON.stringify(store));
      })
    ).toMatch(/completed without agent\/completed/);
  });

  it('capture fails when the plugin never loaded, even with the item in place', async () => {
    // Purpose: an item counts only when flow was there to make it.
    const c = liveCase('capture');
    const captured = {
      ...c.backlog.items[0],
      id: 'x',
      identifier: 'FAKE-2',
      labels: ['type/idea', 'origin/human'],
    };
    const after = { ...c.backlog, items: [...c.backlog.items, captured] };
    const input = { sandbox: tmp, before: c.backlog, after };
    expect(await c.oracle({ ...input, stream: { toolUses: [] } })).toMatch(
      /plugin may not have loaded/
    );
    expect(await c.oracle({ ...input, stream: { slashCommands: ['help'], toolUses: [] } })).toMatch(
      /plugin may not have loaded/
    );
    expect(
      await c.oracle({
        ...input,
        stream: {
          toolUses: [
            {
              name: 'Bash',
              input: {
                command: `node --experimental-strip-types ${FLOW_ROOT}/scripts/flow.ts create`,
              },
            },
          ],
        },
      })
    ).toBeUndefined();
  });

  it('capture passes on exactly one item from flow create, with an origin and not ready', async () => {
    // Purpose: the oracle reads the store the real flow create wrote through the linked fake.
    const create = (s: ReturnType<typeof makeSandbox>, ...labels: string[]) =>
      flow(
        s,
        'create',
        '--title',
        'Export the monthly report as CSV',
        '--description',
        'People want a CSV export.',
        ...labels.flatMap((label) => ['--label', label])
      );
    expect(await judge('capture', (s) => create(s, 'type/idea', 'origin/human'))).toBeUndefined();
    expect(await judge('capture', () => {})).toMatch(/gained 0 items/);
    expect(
      await judge('capture', (s) => {
        create(s, 'type/idea', 'origin/human');
        create(s, 'type/idea', 'origin/human');
      })
    ).toMatch(/gained 2 items/);
    expect(await judge('capture', (s) => create(s, 'type/idea'))).toMatch(/no origin\/\* label/);
    expect(
      await judge('capture', (s) => {
        create(s, 'type/idea', 'origin/human');
        const store = JSON.parse(readFileSync(s.backlogFile, 'utf8')) as FakeBacklog;
        store.items[1].labels.push('agent/ready');
        writeFileSync(s.backlogFile, JSON.stringify(store));
      })
    ).toMatch(/carries agent\/ready/);
  });

  it('builds the sandbox with the adapter linked, not copied, and the store outside the project', () => {
    // Purpose: the fake's adapter.ts imports from the plugin by relative path; a copy breaks it.
    const s = makeSandbox({ flowRoot: FLOW_ROOT, files: {}, backlog: { items: [] } });
    try {
      const link = path.join(s.dir, '.agents', 'flow', 'adapters', 'fake');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(s.backlogFile.startsWith(`${s.dir}${path.sep}`)).toBe(false);
      const tracked = execFileSync('git', ['ls-files'], { cwd: s.dir, encoding: 'utf8' });
      expect(tracked.split('\n')).toContain('.agents/flow/config.json');
    } finally {
      s.cleanup();
    }
  });
});
