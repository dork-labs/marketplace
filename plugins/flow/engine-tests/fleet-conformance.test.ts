/**
 * Runs the shared fleet conformance fixture (`plugins/flow/conformance/fleet/`,
 * spec `flow-cli-core` §1.4) against flow's own implementation.
 *
 * The fixture is the contract flow and DorkOS both implement: DorkOS vendors the
 * folder at a pinned commit and runs its own code against the same cases. So this
 * suite is the proof that flow's side agrees with the written contract, and every
 * case file must be run here in full; a case file the runner does not know fails
 * the suite rather than being skipped.
 *
 * Warnings compare as sorted lists of codes: the codes are the contract, their
 * order and message text are not.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  accountRoom,
  effectiveReservePct,
  fiveHourRoom,
  mayServe,
  mintAccountId,
  modelRoom,
  parseOriginRepo,
  readAccounts,
  readIdentities,
  resolveFleetPolicy,
  spendRoom,
  weeklyRoom,
  type PolicySubject,
  type ResolvedAccountPolicy,
} from '../scripts/fleet/accounts.ts';
import {
  codexObservations,
  mergeLedger,
  pruneTargets,
  readWindow,
  type RuntimeSlug,
} from '../scripts/fleet/usage-ledger.ts';
import {
  FlowStateSchema,
  parseFlowState,
  readFlowState,
  serializeFlowState,
  writeFlowRun,
  type FlowStateStore,
} from '../scripts/flow-state.ts';
import type { FlowRun } from '../scripts/flow-run.ts';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'conformance',
  'fleet'
);

/** One case: `{ name, input, expected }`. */
interface Case {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

/** A case file: a description of the call, and its cases. */
interface CaseFile {
  contract: string;
  about: string;
  cases: Case[];
}

/** Load one case file from the fixture folder. */
function load(name: string): CaseFile {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as CaseFile;
}

/** Warning codes, sorted, for a multiset comparison. */
function codes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((w) => w.code).sort();
}

/** Expected codes, sorted. */
function expectedCodes(expected: unknown): string[] {
  return [...(expected as string[])].sort();
}

/** The runner for each case file, by file name. */
const RUNNERS: Record<string, (c: Case) => void> = {
  'account-id.cases.json': ({ input, expected }) => {
    const id = mintAccountId({
      label: input.label as string | null,
      path: input.path as string,
      taken: input.taken as string[],
    });
    expect(id).toBe(expected.id);
  },

  'identity.cases.json': ({ input, expected }) => {
    const result = readIdentities(input.config, input.runtime as RuntimeSlug);
    expect(result.accounts).toEqual(expected.accounts);
    expect(codes(result.warnings)).toEqual(expectedCodes(expected.warnings));
  },

  'accounts.cases.json': ({ input, expected }) => {
    const result = readAccounts(input.config);
    expect(result.accounts).toEqual(expected.accounts);
    expect(codes(result.warnings)).toEqual(expectedCodes(expected.warnings));
  },

  'fleet-policy.cases.json': ({ input, expected }) => {
    const resolved = resolveFleetPolicy(input.accounts as PolicySubject[], input.fleet);
    expect(resolved.handoff).toBe(expected.handoff);
    expect(resolved.runtimes).toEqual(expected.runtimes);
    expect(resolved.crossRuntimeFallback).toBe(expected.crossRuntimeFallback);
    expect(resolved.mains).toEqual(expected.mains);
    expect(resolved.accounts).toEqual(expected.accounts);
    expect(codes(resolved.warnings)).toEqual(expectedCodes(expected.warnings));
    const checks = (input.checks ?? []) as { account: string; origin: string | null }[];
    const answers = checks.map((check) => {
      const policy = resolved.accounts.find((entry) => entry.key === check.account);
      if (policy === undefined) throw new Error(`case names unknown account ${check.account}`);
      const repo = parseOriginRepo(check.origin);
      return { repo, mayServe: mayServe(policy, repo) };
    });
    if (expected.checks !== undefined) expect(answers).toEqual(expected.checks);
    else expect(checks).toEqual([]);
  },

  'window-read.cases.json': ({ input, expected }) => {
    expect(readWindow(input.entry, input.now as string, input.key as string)).toEqual(
      expected.reading
    );
  },

  'room.cases.json': ({ input, expected }) => {
    const policy = input.policy as ResolvedAccountPolicy;
    const windows = input.windows as Record<string, unknown> | null;
    const now = input.now as string;
    const actual: Record<string, unknown> = {
      effectiveReservePct: effectiveReservePct(policy, windows, now),
      fiveHourRoom: fiveHourRoom(windows, now),
      weeklyRoom: weeklyRoom(policy, windows, now),
    };
    if (input.model !== undefined)
      actual.modelRoom = modelRoom(windows, input.model as string, now);
    expect(actual).toEqual(expected);
  },

  'ledger-merge.cases.json': ({ input, expected }) => {
    const result = mergeLedger(
      input.existing,
      input.observations as unknown[],
      input.now as string,
      {
        runtime: input.runtime as RuntimeSlug,
        accountId: input.accountId as string,
      }
    );
    expect(result.changed).toBe(expected.changed);
    expect(result.ledger).toEqual(expected.ledger);
    expect(codes(result.warnings)).toEqual(expectedCodes(expected.warnings));
  },

  'codex-rate-limits.cases.json': ({ input, expected }) => {
    expect(codexObservations(input.rateLimits, input.observedAt as string, 'rollout')).toEqual(
      expected.observations
    );
  },

  'eligibility.cases.json': ({ input, expected }) => {
    const ledger = input.ledger as { windows?: unknown; spend?: unknown } | null;
    expect({
      room: accountRoom(
        input.runtime as RuntimeSlug,
        input.policy as ResolvedAccountPolicy,
        ledger,
        input.now as string
      ),
      spendRoom: spendRoom(ledger?.spend),
    }).toEqual(expected);
  },

  'prune.cases.json': ({ input, expected }) => {
    expect(
      pruneTargets(
        input.registered as Partial<Record<RuntimeSlug, string[]>>,
        input.onDisk as Partial<Record<RuntimeSlug, string[]>>
      )
    ).toEqual(expected.remove);
  },

  'flow-run.cases.json': ({ input, expected }) => {
    const raw = JSON.stringify(input.state);
    expect(FlowStateSchema.safeParse(input.state).success).toBe(expected.valid);
    if (input.write === undefined) {
      expect(parseFlowState(raw)).toEqual(expected.readBack);
      return;
    }
    let cell: string | undefined = raw;
    const store: FlowStateStore = {
      read: () => cell,
      write: (contents) => {
        cell = contents;
      },
    };
    writeFlowRun(store, input.write as FlowRun);
    expect(JSON.parse(cell)).toEqual(expected.readBack);
    expect(readFlowState(store)).toEqual(expected.readBack);
    expect(serializeFlowState(readFlowState(store))).toBe(cell);
  },
};

const caseFiles = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.cases.json'))
  .sort();

describe('the fleet conformance fixture', () => {
  // Purpose: the folder is the contract DorkOS vendors. Pin its version and the
  // exact set of case files, so a case file added without a runner (and so never
  // run here) fails instead of passing silently.
  it('is contract 2.0.0 with exactly the known case files', () => {
    expect(readFileSync(path.join(FIXTURE_DIR, 'CONTRACT_VERSION'), 'utf8').trim()).toBe('2.0.0');
    expect(caseFiles).toEqual(Object.keys(RUNNERS).sort());
  });

  // Purpose: every case is `{ name, input, expected }`, names are unique per
  // file, and `now` is always an input (never the wall clock) where time matters.
  it('has well-formed cases', () => {
    for (const file of caseFiles) {
      const parsed = load(file);
      expect(parsed.contract, file).toBe('fleet');
      expect(typeof parsed.about, file).toBe('string');
      expect(parsed.cases.length, file).toBeGreaterThan(0);
      const names = new Set<string>();
      for (const c of parsed.cases) {
        expect(Object.keys(c).sort(), `${file}: ${c.name}`).toEqual(['expected', 'input', 'name']);
        expect(names.has(c.name), `${file}: duplicate name ${c.name}`).toBe(false);
        names.add(c.name);
      }
      if (['window-read', 'room', 'ledger-merge', 'eligibility'].some((p) => file.startsWith(p))) {
        for (const c of parsed.cases)
          expect(typeof c.input.now, `${file}: ${c.name}`).toBe('string');
      }
    }
  });

  // Purpose: the fixture is published for another repo to vendor, so it must
  // name no tracker and carry nothing private.
  it('names no tracker and nothing private', () => {
    const banned = /linear|jira|github issues|composio|price|\$\d|plan name|dorkos-cloud/i;
    for (const name of readdirSync(FIXTURE_DIR)) {
      const text = readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
      expect(banned.exec(text)?.[0], name).toBeUndefined();
    }
  });

  for (const file of caseFiles) {
    const runner = RUNNERS[file];
    if (runner === undefined) continue;
    describe(file, () => {
      for (const c of load(file).cases) {
        // Purpose: one contract case; see the file's `about` for the rule.
        it(c.name, () => runner(c));
      }
    });
  }
});

describe('the fixture JSON Schemas', () => {
  const ajv = new (Ajv as unknown as typeof import('ajv').default)({
    strict: true,
    allErrors: true,
  });

  for (const [schemaFile, examplesFile] of [
    ['usage-ledger.schema.json', 'usage-ledger.examples.json'],
    ['fleet-policy.schema.json', 'fleet-policy.examples.json'],
  ] as const) {
    const schema = JSON.parse(readFileSync(path.join(FIXTURE_DIR, schemaFile), 'utf8')) as object;
    const examples = JSON.parse(readFileSync(path.join(FIXTURE_DIR, examplesFile), 'utf8')) as {
      valid: { name: string; value: unknown }[];
      invalid: { name: string; value: unknown }[];
    };
    const validate = ajv.compile(schema);

    describe(schemaFile, () => {
      for (const example of examples.valid) {
        // Purpose: the schema accepts what the contract says a writer may write.
        it(`accepts: ${example.name}`, () => {
          expect(validate(example.value), JSON.stringify(validate.errors)).toBe(true);
        });
      }
      for (const example of examples.invalid) {
        // Purpose: the schema rejects each shape the contract forbids.
        it(`rejects: ${example.name}`, () => {
          expect(validate(example.value)).toBe(false);
        });
      }
    });
  }

  // Purpose: every ledger a merge case produces is a file a writer may write, so
  // the schema and the merge rules cannot drift apart.
  it('accepts every ledger the merge cases produce', () => {
    const validate = ajv.compile(
      JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'usage-ledger.schema.json'), 'utf8')) as object
    );
    for (const c of load('ledger-merge.cases.json').cases) {
      const ledger = c.expected.ledger as { v?: number; windows?: Record<string, unknown> } | null;
      if (ledger === null || ledger.v !== 1 || c.expected.changed !== true) continue;
      const writable = {
        ...ledger,
        windows: Object.fromEntries(
          Object.entries(ledger.windows ?? {}).filter(
            ([key]) => /^(model:|[a-z])/.test(key) && !key.includes(' ')
          )
        ),
      };
      expect(validate(writable), `${c.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});
