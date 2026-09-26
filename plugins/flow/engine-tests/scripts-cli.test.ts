/**
 * Contract suite for the oracle CLI scripts (`plugins/flow/scripts/*.ts`, run via
 * `node --experimental-strip-types`, ADR-0294 / tasks 1.2-1.3). Each script is
 * spawned as a real subprocess with a fixture JSON payload on stdin; we assert
 * its stdout JSON and exit code.
 *
 * The keystone is the dispatch **reproduce-the-oracle** test: it feeds the script
 * the SAME fixture an existing `classifyDispatchOutcome` unit test uses and
 * asserts the script's output equals the oracle's direct output — proving the
 * runnable `.ts` entrypoint reproduces the in-process oracle with no drift.
 *
 * No build step: the scripts are the source. Node strips the types at spawn time,
 * so the suite always exercises current source (no stale-bundle drift).
 *
 * @see specs/flow-marketplace-package (the /flow plugin packaging spec)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CalibrationSchema,
  CircuitBreakerSchema,
  DispatchSchema,
  GatesSchema,
  OwnershipSchema,
  RecoverySchema,
  WipCapSchema,
} from '../scripts/config-schema.ts';
import { classifyDispatchOutcome, type DispatchOptions } from '../scripts/dispatch-policy.ts';
import { resolveInvolvement, type DecisionDescriptor } from '../scripts/calibration.ts';
import {
  evaluateAutoMerge,
  planApprovalRequired,
  tripsCircuitBreaker,
} from '../scripts/gates-policy.ts';
import type { MergeState, UnitUsage } from '../scripts/gates-policy.ts';
import { recoverOrphan, type RecoveryContext } from '../scripts/flow-run.ts';
import type { WorkItem } from '../scripts/work-item.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// engine-tests -> plugins/flow
const PLUGIN_DIR = path.resolve(here, '..');
// plugins/flow -> scripts
const SCRIPTS_DIR = path.resolve(PLUGIN_DIR, 'scripts');

/**
 * Spawn a runnable oracle script (`<name>.ts`) under `node
 * --experimental-strip-types`, returning its exit code + captured streams.
 */
function runScript(
  name: string,
  opts: { stdin?: string; args?: readonly string[] } = {}
): { status: number | null; stdout: string; stderr: string } {
  const scriptPath = path.join(SCRIPTS_DIR, `${name}.ts`);
  const res = spawnSync(
    process.execPath,
    ['--experimental-strip-types', scriptPath, ...(opts.args ?? [])],
    {
      input: opts.stdin ?? '',
      encoding: 'utf8',
    }
  );
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Build a fully-formed, dispatchable WorkItem with overridable fields. */
function makeItem(overrides: Partial<WorkItem> & { identifier: string }): WorkItem {
  return {
    id: `node_${overrides.identifier}`,
    title: `Title ${overrides.identifier}`,
    description: '',
    type: 'task',
    stateCategory: 'backlog',
    stateName: 'Backlog',
    priority: 3,
    size: 'md',
    project: { id: 'proj_a', name: 'Project A', stateCategory: 'started' },
    parent: null,
    relations: { blocks: [], blockedBy: [], children: [], relatedTo: [] },
    labels: ['agent/ready'],
    agentDisposition: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('runnable oracle scripts exist', () => {
  it('ships all five named scripts in plugins/flow/scripts/', () => {
    for (const name of ['dispatch', 'involvement', 'gates', 'recovery', 'validate-config']) {
      expect(existsSync(path.join(SCRIPTS_DIR, `${name}.ts`))).toBe(true);
    }
  });
});

describe('dispatch', () => {
  // Mirrors the dispatch-outcome.test.ts case (d): one agent/ready item plus two
  // shapeable items behind the readiness gate. Ownership crosses the JSON
  // boundary as a precomputed `ownershipOf` map (callbacks cannot serialize).
  const items = [
    makeItem({ identifier: 'DOR-READY' }),
    makeItem({ identifier: 'DOR-SHAPE-1', labels: [] }),
    makeItem({ identifier: 'DOR-SHAPE-2', labels: ['stage/triage'] }),
  ];
  const config = {
    dispatch: DispatchSchema.parse({}),
    ownership: OwnershipSchema.parse({}),
    wipCap: WipCapSchema.parse({}),
  };
  const opts: DispatchOptions = {
    ownershipOf: {
      'DOR-READY': 'unassigned',
      'DOR-SHAPE-1': 'unassigned',
      'DOR-SHAPE-2': 'unassigned',
    },
  };

  it('reproduces the classifyDispatchOutcome oracle exactly (no drift)', () => {
    // The oracle, called directly in-process.
    const expected = classifyDispatchOutcome(items, config, opts);

    // The same fixture, through the compiled script.
    const { status, stdout } = runScript('dispatch', {
      stdin: JSON.stringify({ items, config, opts }),
    });

    expect(status).toBe(0);
    const actual = JSON.parse(stdout);
    // Equal to the oracle output as it crosses the JSON boundary (the script's
    // sole transform). This is the reproduce-the-oracle contract.
    expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
    // And a readable spot-check of the keystone signals.
    expect(actual.picked.map((p: WorkItem) => p.identifier)).toEqual(['DOR-READY']);
    expect(actual).toMatchObject({
      eligibleCount: 1,
      shapeableCount: 2,
      starved: false,
    });
  });

  it('--help prints the input/output shape and exits 0', () => {
    const { status, stdout } = runScript('dispatch', { args: ['--help'] });
    expect(status).toBe(0);
    expect(stdout).toContain('"items"');
    expect(stdout).toContain('DispatchOutcome');
  });

  it('reads from --input <path> as well as stdin', () => {
    // A round-trip through a temp file proves the --input path is honored.
    const tmp = path.join(PLUGIN_DIR, '.dispatch-fixture.tmp.json');
    writeFileSync(tmp, JSON.stringify({ items, config, opts }), 'utf8');
    try {
      const { status, stdout } = runScript('dispatch', {
        args: ['--input', tmp],
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout).eligibleCount).toBe(1);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('exits 1 on invalid (non-JSON) input', () => {
    const { status, stderr } = runScript('dispatch', { stdin: 'not json' });
    expect(status).toBe(1);
    expect(stderr).toContain('invalid input');
  });

  it('exits 1 on structurally invalid input (missing items)', () => {
    const { status } = runScript('dispatch', {
      stdin: JSON.stringify({ config }),
    });
    expect(status).toBe(1);
  });
});

describe('involvement', () => {
  const calibration = CalibrationSchema.parse({});

  it('reproduces resolveInvolvement for a floor trigger (stop-and-ask)', () => {
    const decision: DecisionDescriptor = {
      floorTriggers: ['secrets-or-spend'],
      reversibility: 'reversible',
      confidence: 'confident',
      stage: 'execution',
    };
    const expected = resolveInvolvement(decision, calibration);
    const { status, stdout } = runScript('involvement', {
      stdin: JSON.stringify({ decision, calibration }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('reproduces resolveInvolvement for reversible+confident (proceed-silently)', () => {
    const decision: DecisionDescriptor = {
      reversibility: 'reversible',
      confidence: 'confident',
      stage: 'execution',
    };
    const expected = resolveInvolvement(decision, calibration);
    const { status, stdout } = runScript('involvement', {
      stdin: JSON.stringify({ decision, calibration }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).behavior).toBe('proceed-silently');
  });
});

describe('gates', () => {
  const gates = GatesSchema.parse({});
  const calibration = CalibrationSchema.parse({});

  it('planApproval reproduces planApprovalRequired (off by default)', () => {
    const expected = planApprovalRequired(gates);
    const { status, stdout } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'planApproval', gates }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toBe(expected);
    expect(JSON.parse(stdout)).toBe(false);
  });

  it('circuitBreaker reproduces tripsCircuitBreaker (wall-clock trip)', () => {
    const usage: UnitUsage = {
      estimateMs: 1000,
      elapsedMs: 5000,
      tokensUsed: 10,
    };
    const circuitBreaker = CircuitBreakerSchema.parse({});
    const expected = tripsCircuitBreaker(usage, circuitBreaker);
    const { status, stdout } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'circuitBreaker', usage, circuitBreaker }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).reason).toBe('wall-clock');
  });

  it('autoMerge reproduces evaluateAutoMerge (clean + green + no drift -> merge)', () => {
    const state: MergeState = {
      mergeable: 'clean',
      ci: 'green',
      functionalChange: false,
      attemptCount: 1,
    };
    const expected = evaluateAutoMerge(state, gates, calibration);
    const { status, stdout } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'autoMerge', state, gates, calibration }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).kind).toBe('merge');
  });

  it('exits 1 on an unknown gate discriminator', () => {
    const { status } = runScript('gates', {
      stdin: JSON.stringify({ gate: 'nope' }),
    });
    expect(status).toBe(1);
  });
});

describe('recovery', () => {
  const recovery = RecoverySchema.parse({});
  const ctx: RecoveryContext = { worktreeExists: true, sessionLogIntact: true };

  it('reproduces recoverOrphan for needs-input (skip, never reclaimed)', () => {
    const expected = recoverOrphan('needs-input', null, ctx, recovery);
    const { status, stdout } = runScript('recovery', {
      stdin: JSON.stringify({
        signal: 'needs-input',
        run: null,
        ctx,
        recovery,
      }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(JSON.parse(stdout).kind).toBe('skip');
  });

  it('skips a flow drain run whose worker pid is dead, never resuming it', () => {
    // Purpose: a drain's cli worker exits after every turn (and a DorkOS worker
    // has pid -1), so a dead pid is normal there; resuming it would put a second
    // writer in the worktree the drain supervisor manages.
    const run = {
      issueId: 'id-ACME-12',
      identifier: 'ACME-12',
      sessionId: 'minted-session',
      worktreePath: '/tmp/wt',
      branch: 'ACME-12-x',
      stage: 'execute',
      status: 'running',
      attemptCount: 0,
      workerPid: 999_999_999,
      startedAt: '2026-09-26T00:00:00.000Z',
      drain: { v: 1, rev: 1, phase: 'working' },
    };
    const { status, stdout } = runScript('recovery', {
      stdin: JSON.stringify({ signal: 'claimed-no-worker', run, ctx, recovery }),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ kind: 'skip', reason: 'drain-run' });
    // Without the drain the same dead pid is resumed: the skip is what the drain buys.
    const { drain: _drain, ...plain } = run;
    const resumed = runScript('recovery', {
      stdin: JSON.stringify({ signal: 'claimed-no-worker', run: plain, ctx, recovery }),
    });
    expect(JSON.parse(resumed.stdout).kind).toBe('resume');
  });

  it('exits 2 on an oracle invariant violation (claimed-no-worker with run: null)', () => {
    const { status, stderr } = runScript('recovery', {
      stdin: JSON.stringify({
        signal: 'claimed-no-worker',
        run: null,
        ctx,
        recovery,
      }),
    });
    expect(status).toBe(2);
    expect(stderr).toContain('oracle invariant');
  });
});

describe('validate-config', () => {
  // The oracle VALIDATES a config object against the committed
  // config/config.schema.json — it never applies Zod defaults, it only decides
  // whether the loader's Zod parse would accept the file. So a complete, valid
  // config (the committed config.example.json template; see
  // config-schema.test.ts's `readConfigJson`) is accepted and echoed back
  // verbatim, and so is a config
  // that leaves out fields the schema fills with a default (DOR-2246). An
  // unknown key is reported under `warnings` and never makes a config invalid
  // (DOR-1221's rule: unknown keys must never condemn the file).
  const configPath = path.join(PLUGIN_DIR, 'config', 'config.example.json');
  const fullConfig = JSON.parse(readFileSync(configPath, 'utf8'));

  it('accepts a complete valid config and echoes it back unchanged (exit 0)', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify(fullConfig),
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    // Validate-only: the input config is echoed back verbatim, no defaults added.
    expect(out.config).toEqual(fullConfig);
    expect(out.warnings).toEqual([]);
    expect(out.config.tracker).toBe('linear');
    expect(out.config.gates.planApproval).toBe(false);
  });

  // DOR-2246: every field in FlowConfigSchema has a default, so the loader's
  // Zod parse accepts `{}`. The validator used to call it invalid because the
  // JSON Schema was generated for the parse OUTPUT (where every defaulted field
  // is present) instead of the INPUT (the file a person writes). Fails if the
  // schema is ever regenerated with defaulted fields marked required again.
  it('accepts an empty object, because every field has a default (exit 0)', () => {
    const { status, stdout } = runScript('validate-config', { stdin: '{}' });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, config: {}, warnings: [] });
  });

  // DOR-2246, the case seen in the field: a config written by flow 0.5.1 (the
  // committed config.example.json of that release, verbatim) predates
  // `connection.intake`, which shipped later with a default of `[]`. Updating
  // flow must not turn that install "invalid" and send its owner back to
  // /flow:init. Fails if a defaulted field added after 0.5.1 is required.
  it('accepts a flow 0.5.1 config that predates every field added since (exit 0)', () => {
    const oldConfig = JSON.parse(
      readFileSync(path.join(here, 'fixtures', 'config-0.5.1.json'), 'utf8')
    );
    // Guard the fixture itself: it really is missing the later field.
    expect(oldConfig.connection).not.toHaveProperty('intake');
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify(oldConfig),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, config: oldConfig, warnings: [] });
  });

  // The other half of DOR-2246: making defaulted fields optional must not make
  // the validator permissive. `id` on an intake source has no default, so a
  // source without one is still refused, at the exact path. Fails if the fix
  // drops `required` wholesale instead of only for defaulted fields.
  it('still rejects a missing field that has no default (exit 1)', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify({
        ...fullConfig,
        connection: { ...fullConfig.connection, intake: [{ name: 'Triage' }] },
      }),
    });
    expect(status).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(out.errors).toEqual([
      { path: '/connection/intake/0/id', message: 'missing required property "id"' },
    ]);
  });

  // A misspelled key is surfaced, loudly, but never blocks: the config stays
  // valid and the warning names the exact path. Fails if the typo guard is lost
  // in regeneration (the input-side schema would otherwise drop
  // `additionalProperties: false` on every nested block, so nothing is reported)
  // or if an unknown key is ever counted as an error again.
  it('warns about a misspelled key inside a nested block, naming its path (exit 0)', () => {
    const config = { ...fullConfig, gates: { ...fullConfig.gates, planAproval: true } };
    const { status, stdout, stderr } = runScript('validate-config', {
      stdin: JSON.stringify(config),
    });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      config,
      warnings: [
        {
          path: '/gates/planAproval',
          message: 'unknown property "planAproval" is ignored (check the spelling, or remove it)',
        },
      ],
    });
    expect(stderr).toContain('/gates/planAproval');
  });

  // A setting a later flow removes, or one a newer flow wrote, sits at the top
  // level of an existing config. It must not send the install back to
  // /flow:init. Fails if the top-level (Zod `.strict()`) block still errors.
  it('warns about an unknown top-level key rather than rejecting the config (exit 0)', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify({ ...fullConfig, retiredSetting: 'on' }),
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.warnings).toEqual([
      {
        path: '/retiredSetting',
        message: 'unknown property "retiredSetting" is ignored (check the spelling, or remove it)',
      },
    ]);
  });

  // A credentials block pasted into the committed config.json must not block
  // /flow (unknown keys never condemn the file), but the operator has to be told
  // plainly, since that file is shared. Fails if the pointed message is lost.
  it('warns that a secrets block belongs in config.local.json (exit 0)', () => {
    const { status, stdout, stderr } = runScript('validate-config', {
      stdin: JSON.stringify({ ...fullConfig, secrets: { trackerToken: 'lin_api_x' } }),
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0].path).toBe('/secrets');
    expect(out.warnings[0].message).toContain('config.local.json');
    expect(stderr).toContain('credentials never go in the committed config.json');
  });

  // Warnings are a separate channel, not a softened verdict: a genuinely wrong
  // value still fails, and an unknown key beside it stays a warning rather than
  // being folded into the errors. Fails if the split leaks either way.
  it('still rejects a wrong type, keeping an unknown key beside it as a warning (exit 1)', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify({
        ...fullConfig,
        autonomy: {
          ...fullConfig.autonomy,
          wipCap: { ...fullConfig.autonomy.wipCap, global: 'two' },
          wipcap: 3,
        },
      }),
    });
    expect(status).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(out.errors).toEqual([
      { path: '/autonomy/wipCap/global', message: 'expected type "integer" but got "string"' },
    ]);
    expect(out.warnings.map((w: { path: string }) => w.path)).toEqual(['/autonomy/wipcap']);
  });

  it('rejects an out-of-enum value in an otherwise valid config (exit 1)', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify({
        ...fullConfig,
        connection: { ...fullConfig.connection, transport: 'carrier-pigeon' },
      }),
    });
    expect(status).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(false);
    expect(Array.isArray(out.errors)).toBe(true);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors.some((e: { path: string }) => e.path === '/connection/transport')).toBe(true);
  });

  // `tracker` is a slug, not an enum (F1). The runtime validator walks the
  // GENERATED schema artifact rather than Zod, so it has to honour `pattern` —
  // without it the widened schema would accept anything at all, which is a
  // strictly worse outcome than the enum it replaced.
  it('accepts a tracker slug the plugin ships no adapter for (exit 0)', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: JSON.stringify({ ...fullConfig, tracker: 'github' }),
    });
    expect(status).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.ok).toBe(true);
    expect(out.config.tracker).toBe('github');
  });

  it.each(['Linear!', 'GitHub', '1password', '-github', 'git hub', ''])(
    'rejects the malformed tracker slug %j at /tracker (exit 1)',
    (bad) => {
      const { status, stdout } = runScript('validate-config', {
        stdin: JSON.stringify({ ...fullConfig, tracker: bad }),
      });
      expect(status).toBe(1);
      const out = JSON.parse(stdout);
      expect(out.ok).toBe(false);
      expect(out.errors.some((e: { path: string }) => e.path === '/tracker')).toBe(true);
    }
  );

  it('exits 1 on non-JSON input', () => {
    const { status, stdout } = runScript('validate-config', {
      stdin: 'garbage',
    });
    expect(status).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
  });
});
