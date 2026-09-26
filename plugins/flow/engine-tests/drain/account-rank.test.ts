/**
 * Runs `account-rank.cases.json` against `scripts/drain/account-rank.ts` (spec
 * `flow-handoff-dispatch` §3): the limit signal, eligibility, the three ordering
 * tiers over (runtime, account) pairs, cross-runtime fallback, the implicit
 * `default` account and the machine-load cap.
 *
 * The cases carry the DOR-2373 validation: an account resetting sooner with less
 * left beats one resetting later with more, and the main account gets work only
 * when no other account is eligible or inside its spend-down window. Every group
 * in the file must have a runner here; an unknown group fails the suite rather
 * than being skipped.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  chooseAccount,
  itemRuntime,
  launchBudget,
  limitSignal,
  modelBucketsFor,
  rankAccounts,
  type AccountRank,
  type ChooseAccountInput,
  type LaunchBudgetInput,
  type LimitSignalInput,
  type RankableAccount,
  type RankAccountsInput,
} from '../../scripts/drain/account-rank.ts';
import type { ResolvedAccountPolicy } from '../../scripts/fleet/accounts.ts';
import type { RuntimeSlug } from '../../scripts/fleet/usage-ledger.ts';

/** One case: `{ name, input, expected }`. */
interface Case {
  name: string;
  input: Record<string, unknown>;
  expected: unknown;
}

/** The case file: an `about` line and one list of cases per function. */
type CaseFile = { about: string } & Record<string, Case[]>;

const CASES = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'account-rank.cases.json'),
    'utf8'
  )
) as CaseFile;

/** One expected ranked row: runtime, id and tier always; score and signal level when given. */
interface ExpectedRanked {
  runtime: string;
  id: string;
  tier: number;
  score?: number;
  signal?: string;
}

/** Build a full rank input from a case, filling the documented defaults. */
function rankInput(input: Record<string, unknown>): RankAccountsInput {
  const accounts = (input.accounts as Record<string, unknown>[]).map((raw): RankableAccount => {
    const runtime = raw.runtime as RuntimeSlug;
    const id = raw.id as string;
    const implicit = (raw.implicit as boolean | undefined) ?? false;
    return {
      runtime,
      id,
      path: implicit ? null : `/accounts/${id}`,
      implicit,
      routable: raw.routable as boolean,
      policy: {
        ...(raw.policy as Omit<ResolvedAccountPolicy, 'id' | 'runtime' | 'key'>),
        runtime,
        id,
        key: `${runtime}:${id}`,
      },
      windows: raw.windows as Record<string, unknown> | null,
      spend: raw.spend,
    };
  });
  return {
    now: input.now as string,
    repo: (input.repo as string | null | undefined) ?? 'dork-labs/marketplace',
    accounts,
    runtime: (input.runtime as RuntimeSlug | undefined) ?? 'claude-code',
    runtimes: (input.runtimes as RuntimeSlug[] | undefined) ?? [],
    crossRuntimeFallback: (input.crossRuntimeFallback as 'off' | 'on' | undefined) ?? 'off',
    model: (input.model as string | null | undefined) ?? null,
    affinity: (input.affinity as string | null | undefined) ?? null,
    exclude: (input.exclude as string[] | undefined) ?? [],
    liveByAccount: (input.liveByAccount as Record<string, number> | undefined) ?? {},
    opts: (input.opts as RankAccountsInput['opts'] | undefined) ?? {
      warnMarginPct: 10,
      maxLivePerAccount: 2,
    },
  };
}

/** The runner for each group, by key. */
const RUNNERS: Record<string, (c: Case) => void> = {
  modelBucketsFor: (c) => {
    expect(modelBucketsFor(c.input.model as string | null)).toEqual(c.expected);
  },
  limitSignal: (c) => {
    expect(limitSignal(c.input as unknown as LimitSignalInput)).toEqual(c.expected);
  },
  rankAccounts: (c) => {
    const expected = c.expected as Omit<AccountRank, 'ranked'> & { ranked: ExpectedRanked[] };
    const rank = rankAccounts(rankInput(c.input));
    expect(rank.pick).toEqual(expected.pick);
    expect(rank.ineligible).toEqual(expected.ineligible);
    // Project each ranked row down to the fields the case pins, so a case states only what it tests.
    const projected = rank.ranked.map((row, i) => {
      const want = expected.ranked[i] ?? {};
      const out: ExpectedRanked = { runtime: row.runtime, id: row.id, tier: row.tier };
      if (want.score !== undefined) out.score = Math.round(row.score * 100) / 100;
      if (want.signal !== undefined) out.signal = row.signal.level;
      return out;
    });
    expect(projected).toEqual(expected.ranked);
  },
  chooseAccount: (c) => {
    expect(chooseAccount(c.input as unknown as ChooseAccountInput)).toEqual(c.expected);
  },
  launchBudget: (c) => {
    expect(launchBudget(c.input as unknown as LaunchBudgetInput)).toEqual(c.expected);
  },
  itemRuntime: (c) => {
    expect(itemRuntime(c.input.recorded as string | null, c.input.runtimes as RuntimeSlug[])).toBe(
      c.expected
    );
  },
};

describe('account-rank cases', () => {
  // Every group in the case file has a runner, so a new group cannot be silently skipped.
  it('has a runner for every group in the case file', () => {
    const groups = Object.keys(CASES).filter((key) => key !== 'about');
    expect(groups.sort()).toEqual(Object.keys(RUNNERS).sort());
  });

  for (const [group, run] of Object.entries(RUNNERS)) {
    describe(group, () => {
      // Each case below is one row of the §3 contract, named for the rule it pins.
      for (const c of CASES[group] ?? []) {
        it(c.name, () => run(c));
      }
    });
  }
});
