/**
 * Intake routing oracle — TRIAGE's third entry shape (Path C).
 *
 * Two guarantees carry the whole feature, and both are asserted here rather than
 * stated in prose:
 *
 * 1. **Off by default.** `connection.intake` resolves to `[]`, and with no source
 *    configured Path C does not apply, the three optional adapter verbs are never
 *    named, and nothing about today's TRIAGE changes for an adopter who did not
 *    ask for intake. The strongest form of that claim — the adapter is not even
 *    inspected — is proven with a support object that throws on any property
 *    read.
 * 2. **Six bounded exits that link rather than move.** Each exit routes exactly
 *    as the contract says, exactly one creates work, and no exit can create work
 *    without recording the link back — which is the structural form of "link, do
 *    not move and do not mirror".
 */
import { describe, it, expect } from 'vitest';

import {
  INTAKE_EXITS,
  INTAKE_ROUTING,
  INTAKE_STEPS,
  INTAKE_VERBS,
  INTAKE_VERB_FALLBACK,
  intakeSources,
  isIntakeConfigured,
  planIntake,
  routeIntakeExit,
  selectIntakeSource,
  type IntakeExit,
  type IntakeSource,
  type IntakeVerbSupport,
} from '../scripts/intake.ts';
import { FlowConfigSchema, IntakeSourceSchema } from '../scripts/config-schema.ts';

/** A configured source, resolved through the real schema so defaults apply. */
function source(overrides: Partial<IntakeSource> & { id: string }): IntakeSource {
  return IntakeSourceSchema.parse(overrides);
}

/** An adapter declaring every intake verb supported. */
const FULL_SUPPORT: IntakeVerbSupport = { listIntake: true, promote: true, resolveIntake: true };

/**
 * A verb-support object that throws the moment anything reads a property from
 * it. Passed where intake is off, it turns "never asks the adapter" from a claim
 * into a test: if `planIntake` so much as looks, the test fails loudly.
 */
const NEVER_INSPECTED = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `intake read adapter support for ${String(property)} while intake was off — it must not`
      );
    },
    has(_target, property) {
      throw new Error(
        `intake probed adapter support for ${String(property)} while intake was off — it must not`
      );
    },
  }
) as IntakeVerbSupport;

describe('intake is off until a source is configured', () => {
  it('resolves an empty source list from the default config', () => {
    const { connection } = FlowConfigSchema.parse({});
    expect(connection.intake).toEqual([]);
    expect(isIntakeConfigured(connection)).toBe(false);
    expect(intakeSources(connection)).toEqual([]);
  });

  it('does not apply, and never asks the adapter, when no source is configured', () => {
    const { connection } = FlowConfigSchema.parse({});
    const plan = planIntake(connection, NEVER_INSPECTED);

    expect(plan.applies).toBe(false);
    expect(plan.reason).toBe('no-intake-configured');
    expect(plan.sources).toEqual([]);
    // No degradations either: an adapter that was never asked cannot be found
    // wanting, so an off install reports nothing about its adapter at all.
    expect(plan.degradations).toEqual([]);
  });

  it('treats an absent connection block, and an absent intake key, the same as empty', () => {
    for (const connection of [undefined, {}, { intake: [] }]) {
      expect(isIntakeConfigured(connection)).toBe(false);
      expect(planIntake(connection, NEVER_INSPECTED).applies).toBe(false);
    }
  });

  it('the guard is not vacuous — one configured source flips every answer', () => {
    // Without this, every assertion above would also pass if `planIntake` simply
    // never applied at all.
    const connection = { intake: [source({ id: 'user-feedback' })] };
    expect(isIntakeConfigured(connection)).toBe(true);

    const plan = planIntake(connection, FULL_SUPPORT);
    expect(plan.applies).toBe(true);
    expect(plan.reason).toBe('ready');
    expect(plan.sources.map((s) => s.id)).toEqual(['user-feedback']);
    expect(plan.degradations).toEqual([]);
  });
});

describe('the config block that switches intake on', () => {
  it('accepts a fully-specified source and keeps every value', () => {
    const cfg = FlowConfigSchema.parse({
      connection: {
        intake: [
          {
            id: 'user-feedback',
            label: 'user feedback',
            coordinates: { teamKey: 'FB' },
            promoteTo: { team: 'ENG', project: null },
            outcomes: { promote: 'Accepted', junk: 'Closed' },
          },
        ],
      },
    });

    const [configured] = cfg.connection.intake;
    expect(configured.id).toBe('user-feedback');
    expect(configured.coordinates).toEqual({ teamKey: 'FB' });
    expect(configured.promoteTo).toEqual({ team: 'ENG', project: null });
    expect(configured.outcomes).toEqual({ promote: 'Accepted', junk: 'Closed' });
    // Turning intake on must not disturb the rest of the connection block.
    expect(cfg.connection.transport).toBe('cli');
    expect(cfg.connection.team).toEqual({ key: null, id: null });
  });

  it('fills the defaults a minimal entry leaves out', () => {
    const configured = source({ id: 'support' });
    expect(configured.coordinates).toEqual({});
    // `null` means "the team flow already works in" — never a fabricated team.
    expect(configured.promoteTo).toEqual({ team: null, project: null });
    expect(configured.outcomes).toEqual({});
    expect(configured.label).toBeUndefined();
  });

  it('rejects an id that is not a usable bare word', () => {
    // The id is typed in a trigger and printed in provenance, so it has to be
    // one token — a malformed id must fail to parse rather than resolve oddly.
    for (const bad of ['User Feedback', '1support', '-support', '', 'a_b', 'a/b']) {
      expect(
        FlowConfigSchema.safeParse({ connection: { intake: [{ id: bad }] } }).success,
        `expected intake id ${JSON.stringify(bad)} to be rejected`
      ).toBe(false);
    }
  });

  it('rejects an outcome vocabulary keyed by something that is not an exit', () => {
    // A typo'd exit key would silently never fire; the generated JSON Schema
    // refuses it at edit time, which is what turns it into a red squiggle.
    const cfg = FlowConfigSchema.parse({
      connection: { intake: [{ id: 'support', outcomes: { promoted: 'Accepted' } }] },
    });
    expect(cfg.connection.intake[0].outcomes).toEqual({});
  });

  it('the outcome vocabulary is keyed by exactly the six exits', () => {
    // The schema shape is built from INTAKE_EXITS, so this pins that the config
    // vocabulary and the routing vocabulary cannot drift apart.
    expect(Object.keys(IntakeSourceSchema.shape.outcomes.unwrap().shape).sort()).toEqual(
      [...INTAKE_EXITS].sort()
    );
  });

  it('selects a configured source by id, and reports a miss as a miss', () => {
    const connection = { intake: [source({ id: 'support' }), source({ id: 'issues' })] };
    expect(selectIntakeSource(connection, 'issues')?.id).toBe('issues');
    expect(selectIntakeSource(connection, 'sales')).toBeUndefined();

    const plan = planIntake(connection, FULL_SUPPORT, { sourceId: 'sales' });
    expect(plan.applies).toBe(false);
    expect(plan.reason).toBe('source-not-found');
  });

  it('narrows the pass to one source when the trigger names it', () => {
    const connection = { intake: [source({ id: 'support' }), source({ id: 'issues' })] };
    expect(planIntake(connection, FULL_SUPPORT).sources).toHaveLength(2);
    expect(planIntake(connection, FULL_SUPPORT, { sourceId: 'issues' }).sources.map((s) => s.id)) //
      .toEqual(['issues']);
  });
});

describe('the six exits route as specified', () => {
  it('has exactly six exits, in dedupe-first order', () => {
    expect(INTAKE_EXITS).toEqual([
      'duplicate',
      'promote',
      'attach',
      'needs-info',
      'decline',
      'junk',
    ]);
    expect(new Set(INTAKE_EXITS).size).toBe(INTAKE_EXITS.length);
    expect(Object.keys(INTAKE_ROUTING).sort()).toEqual([...INTAKE_EXITS].sort());
  });

  const EXPECTED: Record<
    IntakeExit,
    { work: string; link: string; reporter: string; outward: boolean; verbs: string[] }
  > = {
    duplicate: {
      work: 'none',
      link: 'report',
      reporter: 'merged',
      outward: true,
      verbs: ['resolveIntake'],
    },
    promote: {
      work: 'new',
      link: 'work',
      reporter: 'accepted',
      outward: true,
      verbs: ['promote', 'resolveIntake'],
    },
    attach: {
      work: 'existing',
      link: 'work',
      reporter: 'accepted',
      outward: true,
      verbs: ['promote', 'resolveIntake'],
    },
    'needs-info': {
      work: 'none',
      link: 'none',
      reporter: 'question',
      outward: true,
      verbs: ['resolveIntake'],
    },
    decline: {
      work: 'none',
      link: 'none',
      reporter: 'reason',
      outward: true,
      verbs: ['resolveIntake'],
    },
    junk: {
      work: 'none',
      link: 'none',
      reporter: 'nothing',
      outward: false,
      verbs: ['resolveIntake'],
    },
  };

  it.each(INTAKE_EXITS)('routes `%s` to its work, link, and reporter effect', (exit) => {
    const routing = routeIntakeExit(exit);
    const expected = EXPECTED[exit];
    expect(routing.exit).toBe(exit);
    expect(routing.work).toBe(expected.work);
    expect(routing.link).toBe(expected.link);
    expect(routing.reporter).toBe(expected.reporter);
    expect(routing.outward).toBe(expected.outward);
    expect([...routing.verbs]).toEqual(expected.verbs);
  });

  it('creates work on exactly one exit, and touches work on exactly two', () => {
    const creates = INTAKE_EXITS.filter((exit) => routeIntakeExit(exit).work === 'new');
    const touches = INTAKE_EXITS.filter((exit) => routeIntakeExit(exit).work !== 'none');
    expect(creates).toEqual(['promote']);
    expect(touches).toEqual(['promote', 'attach']);
  });

  it('never creates work without recording the link back (link, do not move)', () => {
    // The structural form of the rule: a promotion that created work and no link
    // would have consumed the report in all but name.
    for (const exit of INTAKE_EXITS) {
      const routing = routeIntakeExit(exit);
      if (routing.work !== 'none') {
        expect(routing.link, `${exit} touches work without linking to it`).toBe('work');
      }
    }
  });

  it('resolves the report on every exit — none leaves it untouched', () => {
    for (const exit of INTAKE_EXITS) {
      expect(routeIntakeExit(exit).verbs, `${exit} never closes the loop`).toContain(
        'resolveIntake'
      );
    }
  });

  it('junk is the only exit that reaches nobody', () => {
    const silent = INTAKE_EXITS.filter((exit) => routeIntakeExit(exit).reporter === 'nothing');
    expect(silent).toEqual(['junk']);
    // `outward` is what puts the other five behind the calibration floor, so it
    // must agree with "the reporter sees something" exit for exit.
    for (const exit of INTAKE_EXITS) {
      const routing = routeIntakeExit(exit);
      expect(routing.outward).toBe(routing.reporter !== 'nothing');
    }
  });

  it('names only verbs that exist, and rejects an exit that does not', () => {
    for (const exit of INTAKE_EXITS) {
      for (const verb of routeIntakeExit(exit).verbs) {
        expect(INTAKE_VERBS).toContain(verb);
      }
    }
    expect(() => routeIntakeExit('promoted' as IntakeExit)).toThrow(/unknown intake exit/);
  });
});

describe('the pass order — dedupe first, batch the reading, serialise the writing', () => {
  it('runs dedupe first and closes the loop last', () => {
    expect(INTAKE_STEPS.map((step) => step.id)).toEqual([
      'dedupe',
      'validate',
      'classify',
      'split',
      'decide',
      'promote-and-link',
      'resolve',
    ]);
  });

  it('splits before deciding, so one report can take more than one exit', () => {
    const ids = INTAKE_STEPS.map((step) => step.id);
    expect(ids.indexOf('split')).toBeLessThan(ids.indexOf('decide'));
    expect(ids.indexOf('dedupe')).toBeLessThan(ids.indexOf('decide'));
  });

  it('never batches a step that writes', () => {
    // Batching's win is on reads, whose cost amortizes over the whole set; a
    // batched write is how one wrong judgement becomes ten.
    for (const step of INTAKE_STEPS) {
      if (step.writes) {
        expect(step.batchable, `${step.id} writes and is marked batchable`).toBe(false);
      }
    }
    // Non-vacuity: at least one step does batch, and at least one does write.
    expect(INTAKE_STEPS.some((step) => step.batchable)).toBe(true);
    expect(INTAKE_STEPS.some((step) => step.writes)).toBe(true);
  });

  it('writes only after every read step has run', () => {
    const firstWrite = INTAKE_STEPS.findIndex((step) => step.writes);
    expect(INTAKE_STEPS.slice(firstWrite).every((step) => step.writes)).toBe(true);
  });
});

describe('an adapter without the optional verbs still gets a path through', () => {
  const connection = { intake: [source({ id: 'support' })] };

  it('degrades rather than failing when the adapter declares nothing', () => {
    // The contract's reading rule: no declaration means NOT supported, and
    // absence is never an error.
    const plan = planIntake(connection, {});
    expect(plan.applies).toBe(true);
    expect(plan.reason).toBe('ready');
    expect(plan.degradations.map((d) => d.verb)).toEqual([...INTAKE_VERBS]);
    for (const degradation of plan.degradations) {
      expect(degradation.fallback).toBe(INTAKE_VERB_FALLBACK[degradation.verb]);
      expect(degradation.fallback.length).toBeGreaterThan(0);
    }
  });

  it('treats an explicitly unsupported verb exactly like an undeclared one', () => {
    const declaredFalse = planIntake(connection, {
      listIntake: false,
      promote: false,
      resolveIntake: false,
    });
    expect(declaredFalse.degradations).toEqual(planIntake(connection, {}).degradations);
  });

  it('degrades per verb, not all-or-nothing', () => {
    const plan = planIntake(connection, { listIntake: true, resolveIntake: true });
    expect(plan.applies).toBe(true);
    expect(plan.degradations.map((d) => d.verb)).toEqual(['promote']);
  });

  it('reports no degradation when the adapter supports all three', () => {
    expect(planIntake(connection, FULL_SUPPORT).degradations).toEqual([]);
  });
});
