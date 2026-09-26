/**
 * The `flow` CLI entry point (spec `flow-cli-core` §2, task 1.5): argv parsing,
 * the verb registry, `--help`, human and `--json` output, and the one table that
 * turns a typed error into an exit code.
 *
 * Every case drives the exported `main(argv, deps)` with injected streams, env,
 * clock and collaborators, and registers test-only verbs through `deps.verbs`,
 * so the shipped registry stays free of stubs. One spawn test runs the real
 * script, proving the dynamic imports and exit codes outside the harness.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { formatColumns } from '../../scripts/cli/output.ts';
import type {
  AdapterRequest,
  VerbContext,
  VerbDefinition,
  VerbModule,
} from '../../scripts/cli/context.ts';
import {
  ConfigError,
  EXIT,
  PausedError,
  PreconditionError,
  TrackerError,
  UsageError,
} from '../../scripts/errors.ts';
import { classifyError, main, VERBS, type MainDeps } from '../../scripts/flow.ts';
import { createFakeAdapter } from '../fixtures/cli/fake-adapter/adapter.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FLOW_SCRIPT = path.resolve(here, '..', '..', 'scripts', 'flow.ts');

/** A string sink that records every write. */
function sink(): { write(chunk: string): boolean; text(): string } {
  let buffer = '';
  return {
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

/** Fake deps with recording streams; `overrides` replaces any field. */
function fakeDeps(overrides: Partial<MainDeps> = {}) {
  const stdout = sink();
  const stderr = sink();
  const deps: MainDeps = {
    env: {},
    cwd: '/work/project',
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    stdout,
    stderr,
    createAdapter: async () => createFakeAdapter({ items: [] }).adapter,
    runProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
    flowRoot: '/opt/flow',
    verbs: [],
    ...overrides,
  };
  return { deps, stdout, stderr };
}

/** A verb module whose `run` records the context and returns a fixed result. */
function recordingModule(result: Awaited<ReturnType<VerbModule['run']>> = okResult()) {
  const seen: VerbContext[] = [];
  const module: VerbModule = {
    run: async (ctx) => {
      seen.push(ctx);
      return result;
    },
  };
  return { module, seen };
}

function okResult() {
  return { json: { done: true }, text: 'done' };
}

/** A read-style test verb: one optional positional, its own flags, some common flags. */
function probeVerb(module: VerbModule, load = vi.fn(async () => module)): VerbDefinition {
  return {
    name: 'probe',
    summary: 'A test-only read verb.',
    common: ['project', 'snapshot', 'session', 'manual'],
    positionals: [{ name: 'identifier', description: 'The item to read.' }],
    flags: [
      { name: 'limit', kind: 'string', short: 'n', value: 'N', description: 'How many.' },
      { name: 'strict', kind: 'boolean', description: 'Fail on drift.' },
    ],
    load,
  };
}

/** A write-style test verb with a required positional and `--dry-run`. */
function writeVerb(module: VerbModule): VerbDefinition {
  return {
    name: 'poke',
    summary: 'A test-only write verb.',
    common: ['dry-run', 'session'],
    positionals: [{ name: 'identifier', required: true, description: 'The item to change.' }],
    load: async () => module,
  };
}

describe('the shipped registry', () => {
  // Purpose: no stub verb ships. Every registered verb must load a module with a
  // real `run`, so a placeholder entry cannot hide behind the registry.
  it('only registers verbs whose module loads and has a run function', async () => {
    for (const verb of VERBS) {
      const module = await verb.load();
      expect(typeof module.run, verb.name).toBe('function');
    }
  });
});

describe('argv parsing', () => {
  // Purpose: the parser hands the verb its positionals, its own flags in both
  // `--flag value` and `--flag=value` forms, short flags, and booleans.
  it('parses positionals, long, equals, short and boolean flags', async () => {
    const { module, seen } = recordingModule();
    const { deps } = fakeDeps({ verbs: [probeVerb(module)] });

    expect(await main(['probe', 'DOR-1', '-n', '3', '--strict'], deps)).toBe(0);
    expect(seen[0].args.verb).toBe('probe');
    expect(seen[0].args.positionals).toEqual(['DOR-1']);
    expect(seen[0].args.flags).toEqual({ limit: '3', strict: true });

    expect(await main(['probe', '--limit=7'], deps)).toBe(0);
    expect(seen[1].args.flags).toEqual({ limit: '7' });
    expect(seen[1].args.positionals).toEqual([]);
  });

  // Purpose: common flags resolve into the context: --project against cwd,
  // --snapshot against cwd, --session over FLOW_SESSION_ID, --manual.
  it('resolves the common flags into the verb context', async () => {
    const { module, seen } = recordingModule();
    const { deps } = fakeDeps({
      verbs: [probeVerb(module)],
      env: { FLOW_SESSION_ID: 'from-env' },
    });

    await main(['probe', '--project', 'sub', '--snapshot', 'snap.json', '--manual'], deps);
    expect(seen[0].projectDir).toBe(path.resolve('/work/project', 'sub'));
    expect(seen[0].snapshotPath).toBe(path.resolve('/work/project', 'snap.json'));
    expect(seen[0].sessionId).toBe('from-env');
    expect(seen[0].manual).toBe(true);
    expect(seen[0].dryRun).toBe(false);

    await main(['probe', '--session', 'from-flag'], deps);
    expect(seen[1].projectDir).toBe('/work/project');
    expect(seen[1].snapshotPath).toBeUndefined();
    expect(seen[1].sessionId).toBe('from-flag');
    expect(seen[1].manual).toBe(false);
  });

  // Purpose: an empty FLOW_SESSION_ID is no session; a session is never invented.
  it('treats an empty FLOW_SESSION_ID as no session', async () => {
    const { module, seen } = recordingModule();
    const { deps } = fakeDeps({ verbs: [probeVerb(module)], env: { FLOW_SESSION_ID: '' } });
    await main(['probe'], deps);
    expect(seen[0].sessionId).toBeUndefined();
  });

  // Purpose: under Claude Code no flag is needed: CLAUDE_CODE_SESSION_ID, which
  // Claude Code sets for every Bash command, is the fallback, and
  // FLOW_SESSION_ID still wins over it.
  it('falls back to CLAUDE_CODE_SESSION_ID, below FLOW_SESSION_ID', async () => {
    const fallback = recordingModule();
    const a = fakeDeps({
      verbs: [probeVerb(fallback.module)],
      env: { FLOW_SESSION_ID: '', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'cc-session' },
    });
    await main(['probe'], a.deps);
    expect(fallback.seen[0].sessionId).toBe('cc-session');

    const both = recordingModule();
    const b = fakeDeps({
      verbs: [probeVerb(both.module)],
      env: {
        FLOW_SESSION_ID: 'flow-session',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'cc-session',
      },
    });
    await main(['probe'], b.deps);
    expect(both.seen[0].sessionId).toBe('flow-session');
  });

  // Purpose: under Codex no flag is needed either: CODEX_THREAD_ID, which Codex
  // sets for every command, is the fallback, still below FLOW_SESSION_ID.
  it('falls back to CODEX_THREAD_ID under Codex', async () => {
    const fallback = recordingModule();
    const a = fakeDeps({
      verbs: [probeVerb(fallback.module)],
      env: { CODEX_THREAD_ID: 'codex-thread' },
    });
    await main(['probe'], a.deps);
    expect(fallback.seen[0].sessionId).toBe('codex-thread');

    const opencode = recordingModule();
    const b = fakeDeps({ verbs: [probeVerb(opencode.module)], env: { OPENCODE: '1' } });
    await main(['probe'], b.deps);
    expect(opencode.seen[0].sessionId).toBeUndefined();
  });

  // Purpose: common flags may come before the verb, and `--` ends flag parsing
  // so a value that looks like a flag can still be a positional.
  it('accepts common flags before the verb and honors --', async () => {
    const { module, seen } = recordingModule();
    const { deps, stdout } = fakeDeps({ verbs: [probeVerb(module)] });

    expect(await main(['--json', '--project', 'a', 'probe', '--', '--strict'], deps)).toBe(0);
    expect(seen[0].json).toBe(true);
    expect(seen[0].projectDir).toBe(path.resolve('/work/project', 'a'));
    expect(seen[0].args.positionals).toEqual(['--strict']);
    expect(seen[0].args.flags).toEqual({ project: 'a' });
    expect(JSON.parse(stdout.text()).v).toBe(1);
  });
});

describe('usage errors exit 2', () => {
  const cases: [string, string[], RegExp][] = [
    ['an unknown verb', ['bogus'], /unknown verb "bogus"/],
    ['no verb', [], /no verb/],
    ['an unknown flag', ['probe', '--wat'], /unknown flag --wat/],
    ['an unknown flag before the verb', ['--wat', 'probe'], /unknown flag --wat/],
    ['a common flag the verb does not take', ['probe', '--dry-run'], /--dry-run/],
    ['a string flag with no value', ['probe', '--limit'], /--limit needs a value/],
    ['a string flag followed by a flag', ['probe', '--limit', '--strict'], /--limit needs/],
    ['a boolean flag given a value', ['probe', '--strict=yes'], /--strict takes no value/],
    ['a flag given twice', ['probe', '-n', '1', '--limit', '2'], /--limit was given twice/],
    ['too many positionals', ['probe', 'A', 'B'], /unexpected argument "B"/],
    ['a missing required positional', ['poke'], /missing <identifier>/],
  ];

  for (const [label, argv, message] of cases) {
    // Purpose: each malformed invocation is a usage error (2) that names the
    // problem on stderr, and the verb module is never loaded or run.
    it(`rejects ${label}`, async () => {
      const load = vi.fn(async () => recordingModule().module);
      const { deps, stdout, stderr } = fakeDeps({
        verbs: [probeVerb(recordingModule().module, load), writeVerb(recordingModule().module)],
      });
      expect(await main(argv, deps)).toBe(EXIT.usage);
      expect(stderr.text()).toMatch(message);
      expect(stderr.text()).toMatch(/^flow: /);
      expect(stdout.text()).toBe('');
      expect(load).not.toHaveBeenCalled();
    });
  }
});

describe('--help', () => {
  // Purpose: `flow --help` works with an empty registry and lists no verb.
  it('prints top-level help with an empty registry and lists nothing', async () => {
    const { deps, stdout, stderr } = fakeDeps({ verbs: [] });
    expect(await main(['--help'], deps)).toBe(0);
    expect(stdout.text()).toMatch(/^Usage: flow <verb>/);
    expect(stdout.text()).not.toMatch(/Verbs:/);
    expect(stderr.text()).toBe('');
  });

  // Purpose: with verbs registered, top-level help lists each with its summary.
  it('lists registered verbs in top-level help', async () => {
    const { module } = recordingModule();
    const { deps, stdout } = fakeDeps({ verbs: [probeVerb(module), writeVerb(module)] });
    expect(await main(['-h'], deps)).toBe(0);
    expect(stdout.text()).toMatch(
      /Verbs:\n {2}probe +A test-only read verb\.\n {2}poke +A test-only/
    );
  });

  // Purpose: per-verb help shows its usage line, own flags and only the common
  // flags it takes, exits 0, and never loads the verb module (so it answers
  // even before `npm install`).
  it('prints per-verb help without loading the verb', async () => {
    const load = vi.fn(async () => recordingModule().module);
    const { deps, stdout } = fakeDeps({ verbs: [probeVerb(recordingModule().module, load)] });

    expect(await main(['probe', '--help'], deps)).toBe(0);
    const text = stdout.text();
    expect(text).toMatch(/^Usage: flow probe \[<identifier>\] \[flags\]/);
    expect(text).toMatch(/-n, --limit <N> +How many\./);
    expect(text).toMatch(/--strict +Fail on drift\./);
    expect(text).toMatch(/--project <dir>/);
    expect(text).toMatch(/--json/);
    expect(text).not.toMatch(/--dry-run/);
    expect(load).not.toHaveBeenCalled();
  });

  // Purpose: help wins over an otherwise bad invocation of a known verb, so a
  // person asking how to call it is never answered with an error.
  it('answers --help even when other flags are wrong', async () => {
    const { deps, stdout } = fakeDeps({ verbs: [writeVerb(recordingModule().module)] });
    expect(await main(['poke', '--wat', '-h'], deps)).toBe(0);
    expect(stdout.text()).toMatch(/^Usage: flow poke <identifier> \[flags\]/);
  });

  // Purpose: --help on an unknown verb is still a usage error, not silent help.
  it('refuses --help on an unknown verb', async () => {
    const { deps } = fakeDeps();
    expect(await main(['bogus', '--help'], deps)).toBe(EXIT.usage);
  });

  // Purpose: in --json mode help is still exactly one JSON value on stdout.
  it('wraps help in one JSON object under --json', async () => {
    const { deps, stdout } = fakeDeps({ verbs: [writeVerb(recordingModule().module)] });
    expect(await main(['poke', '--help', '--json'], deps)).toBe(0);
    const body = JSON.parse(stdout.text());
    expect(body).toMatchObject({ v: 1, ok: true, verb: 'poke' });
    expect(body.usage).toMatch(/^Usage: flow poke/);
  });
});

describe('output', () => {
  // Purpose: --json prints exactly one JSON value carrying v:1 and the verb's
  // data; human mode prints the verb's text and no JSON.
  it('prints the verb result as JSON or as text', async () => {
    const { module } = recordingModule({ json: { picked: ['DOR-1'] }, text: 'picked DOR-1' });
    const json = fakeDeps({ verbs: [probeVerb(module)] });
    expect(await main(['probe', '--json'], json.deps)).toBe(0);
    expect(JSON.parse(json.stdout.text())).toEqual({ v: 1, picked: ['DOR-1'] });
    expect(json.stdout.text().trim().split('\n')).toHaveLength(1);

    const human = fakeDeps({ verbs: [probeVerb(module)] });
    expect(await main(['probe'], human.deps)).toBe(0);
    expect(human.stdout.text()).toBe('picked DOR-1\n');
  });

  // Purpose: a verb whose check found problems exits 1 and its JSON still goes out.
  it('passes the findings exit code through', async () => {
    const { module } = recordingModule({ exitCode: 1, json: { ok: false }, text: '1 problem' });
    const { deps, stdout } = fakeDeps({ verbs: [probeVerb(module)] });
    expect(await main(['probe', '--json'], deps)).toBe(EXIT.findings);
    expect(JSON.parse(stdout.text())).toEqual({ v: 1, ok: false });
  });

  // Purpose: a verb's data can never overwrite the envelope version.
  it('keeps v:1 even if the verb data carries a v', async () => {
    const { module } = recordingModule({ json: { v: 9, x: 1 }, text: '' });
    const { deps, stdout } = fakeDeps({ verbs: [probeVerb(module)] });
    await main(['probe', '--json'], deps);
    expect(JSON.parse(stdout.text())).toEqual({ v: 1, x: 1 });
  });

  // Purpose: warnings are diagnostics and go to stderr in both modes, so
  // --json stdout stays one parseable value.
  it('sends warnings to stderr', async () => {
    const module: VerbModule = {
      run: async (ctx) => {
        ctx.warn('the snapshot is 2 hours old');
        return okResult();
      },
    };
    const { deps, stdout, stderr } = fakeDeps({ verbs: [probeVerb(module)] });
    await main(['probe', '--json'], deps);
    expect(stderr.text()).toBe('flow: warning: the snapshot is 2 hours old\n');
    expect(JSON.parse(stdout.text())).toEqual({ v: 1, done: true });
  });

  // Purpose: human columns are aligned plain text, no color codes.
  it('aligns columns without color', () => {
    expect(formatColumns([['a', 'one'], ['long-name', 'two', 'x'], ['b']])).toBe(
      'a          one\nlong-name  two  x\nb'
    );
  });
});

describe('errors map to exit codes in one place', () => {
  const typed: [string, Error, number][] = [
    ['UsageError', new UsageError('bad'), EXIT.usage],
    ['ConfigError', new ConfigError('not configured'), EXIT.config],
    ['TrackerError', new TrackerError('unreachable'), EXIT.tracker],
    ['PreconditionError', new PreconditionError('already claimed'), EXIT.precondition],
    ['PausedError', new PausedError('paused since noon'), EXIT.paused],
  ];

  for (const [name, error, code] of typed) {
    // Purpose: every typed error a verb throws becomes its exit code and, under
    // --json, the {v:1, ok:false, error:{code, message}} envelope on stdout.
    it(`maps ${name} to ${code} with the JSON error envelope`, async () => {
      const module: VerbModule = {
        run: async () => {
          throw error;
        },
      };
      const { deps, stdout, stderr } = fakeDeps({ verbs: [probeVerb(module)] });
      expect(await main(['probe', '--json'], deps)).toBe(code);
      expect(JSON.parse(stdout.text())).toEqual({
        v: 1,
        ok: false,
        error: { code, message: error.message },
      });
      expect(stderr.text()).toBe(`flow: ${error.message}\n`);
    });
  }

  // Purpose: in human mode an error goes to stderr only and stdout stays empty.
  it('prints a human error to stderr only', async () => {
    const module: VerbModule = {
      run: async () => {
        throw new TrackerError('Linear did not answer');
      },
    };
    const { deps, stdout, stderr } = fakeDeps({ verbs: [probeVerb(module)] });
    expect(await main(['probe'], deps)).toBe(EXIT.tracker);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('flow: Linear did not answer\n');
  });

  // Purpose: an unknown-verb usage error under --json is the envelope too.
  it('wraps a usage error in the JSON envelope', async () => {
    const { deps, stdout } = fakeDeps();
    expect(await main(['bogus', '--json'], deps)).toBe(EXIT.usage);
    expect(JSON.parse(stdout.text())).toMatchObject({ v: 1, ok: false, error: { code: 2 } });
  });

  // Purpose: an unexpected (untyped) error is reported, not swallowed or
  // thrown past main, and says it is a bug.
  it('reports an unexpected error as an internal error', () => {
    expect(classifyError(new TypeError('x is undefined'), '/opt/flow')).toEqual({
      code: 70,
      message: 'internal error: x is undefined',
    });
  });

  const zodMissing = Object.assign(
    new Error("Cannot find package 'zod' imported from /opt/flow/scripts/config-schema.ts"),
    { code: 'ERR_MODULE_NOT_FOUND' }
  );

  // Purpose: a verb module that cannot load zod exits 6 with the install line
  // naming flow's own folder.
  it('exits 6 with the install hint when a verb cannot load zod', async () => {
    const load = vi.fn(async (): Promise<VerbModule> => {
      throw zodMissing;
    });
    const { deps, stderr } = fakeDeps({
      verbs: [probeVerb(recordingModule().module, load)],
    });
    expect(await main(['probe'], deps)).toBe(EXIT.dependency);
    expect(stderr.text()).toBe('flow: run "npm install --omit=dev" in /opt/flow\n');
  });

  // Purpose: the hint also fires when zod is missing further in (a verb's own
  // lazy import), and a different missing module is not mistaken for zod.
  it('tells a missing zod apart from another missing module', () => {
    expect(classifyError(zodMissing, '/opt/flow').code).toBe(EXIT.dependency);
    const subpath = Object.assign(new Error("Cannot find package 'zod/v4' imported from x"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(classifyError(subpath, '/opt/flow').code).toBe(EXIT.dependency);
    const other = Object.assign(new Error("Cannot find module '/opt/flow/scripts/cli/x.ts'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(classifyError(other, '/opt/flow').code).not.toBe(EXIT.dependency);
    const lookalike = Object.assign(new Error("Cannot find package 'zodiac' imported from x"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(classifyError(lookalike, '/opt/flow').code).not.toBe(EXIT.dependency);
  });
});

describe('lazy loading and injected collaborators', () => {
  // Purpose: only the verb being run is imported.
  it('loads only the requested verb', async () => {
    const other = vi.fn(async () => recordingModule().module);
    const { module } = recordingModule();
    const { deps } = fakeDeps({
      verbs: [probeVerb(module), { ...writeVerb(module), load: other }],
    });
    await main(['probe'], deps);
    expect(other).not.toHaveBeenCalled();
  });

  // Purpose: the verb reaches env, clock, process runner and adapter only
  // through deps, and the adapter is built once per run, lazily.
  it('hands the verb the injected collaborators', async () => {
    const fakeAdapter = createFakeAdapter({ items: [] }).adapter;
    const createAdapter = vi.fn(async (_request: AdapterRequest) => fakeAdapter);
    const runProcess = vi.fn(async () => ({ code: 0, stdout: 'main\n', stderr: '' }));
    let observed: unknown[] = [];
    const module: VerbModule = {
      run: async (ctx) => {
        const first = await ctx.adapter();
        const second = await ctx.adapter();
        const branch = await ctx.runProcess('git', ['branch', '--show-current']);
        observed = [first, first === second, branch.stdout, ctx.now().toISOString(), ctx.env.X];
        return okResult();
      },
    };
    const { deps } = fakeDeps({
      verbs: [probeVerb(module)],
      createAdapter,
      runProcess,
      env: { X: 'y' },
    });
    await main(['probe', '--project', 'p'], deps);
    expect(observed).toEqual([fakeAdapter, true, 'main\n', '2026-09-26T12:00:00.000Z', 'y']);
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(createAdapter.mock.calls[0][0]).toMatchObject({
      projectDir: path.resolve('/work/project', 'p'),
    });
    expect(runProcess).toHaveBeenCalledWith('git', ['branch', '--show-current']);
  });

  // Purpose: a verb that never asks for the adapter never builds one.
  it('does not build the adapter unless asked', async () => {
    const createAdapter = vi.fn(async () => createFakeAdapter({ items: [] }).adapter);
    const { deps } = fakeDeps({
      verbs: [probeVerb(recordingModule().module)],
      createAdapter,
    });
    await main(['probe'], deps);
    expect(createAdapter).not.toHaveBeenCalled();
  });
});

describe('the real script', () => {
  // Purpose: run flow.ts as a real process, proving its top-level imports load
  // with no install step, --help exits 0, and an unknown verb exits 2 with the
  // JSON envelope.
  it('answers --help and refuses an unknown verb', () => {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--experimental-strip-types', FLOW_SCRIPT, ...args], {
        encoding: 'utf8',
      });

    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^Usage: flow <verb>/);

    const bogus = run(['bogus', '--json']);
    expect(bogus.status).toBe(EXIT.usage);
    expect(JSON.parse(bogus.stdout)).toMatchObject({ v: 1, ok: false, error: { code: 2 } });
  });
});
