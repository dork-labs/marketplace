/**
 * `flow sweep` and `flow prs` (DOR-3341).
 *
 * The sweep arms a cleared PR only through the arm guard, at the head whose
 * labels it checked; a moved head or a red check is not armed, and the reason
 * comes back. `flow prs` flags stale and far-behind PRs with a prompt naming
 * the owner, and `--for` refuses at the cap unless the item is P0.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ArmGuard, CliDeps } from '../../scripts/cli/context.ts';
import { main, VERBS } from '../../scripts/flow.ts';
import type { OpenPr } from '../../scripts/forge/open-prs.ts';
import type { ArmFacts, Forge } from '../../scripts/forge/types.ts';
import type { WorkItem } from '../../scripts/tracker/types.ts';
import { createFakeAdapter } from '../fixtures/cli/fake-adapter/adapter.ts';
import { recordingGuard, refusal, type RecordingGuard } from '../fixtures/land/recording-guard.ts';
import { readyItem, tempProject, type TempProject } from './read-verb-harness.ts';

let temp: TempProject | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const HEAD = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const PUSHED = '2026-09-25T10:00:00Z';
const BEFORE = '2026-09-25T09:00:00Z';
const AFTER = '2026-09-25T11:00:00Z';

const github: CliDeps['runProcess'] = async (cmd, args) =>
  cmd === 'git' && args.join(' ') === 'remote get-url origin'
    ? { code: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' }
    : { code: 0, stdout: '', stderr: '' };

function open(number: number, overrides: Partial<OpenPr> = {}): OpenPr {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    createdAt: '2026-09-24T00:00:00Z',
    author: 'kai',
    headRefName: `b-${number}`,
    headSha: HEAD,
    baseRefName: 'main',
    isDraft: false,
    labels: [],
    armed: false,
    ...overrides,
  };
}

/** One PR's world: files, checks, label times, when its head was seen. */
interface PrWorld {
  files: string[];
  checks?: { name: string; bucket: string }[];
  head?: string;
  labelledAt?: Record<string, string>;
  headSeenAt?: string | null;
  behind?: number;
  queued?: boolean;
}

function forgeFor(prs: OpenPr[], worlds: Record<number, PrWorld>) {
  const armed: [number, string][] = [];
  const forge = {
    repo: 'acme/app',
    async openPrs() {
      return prs;
    },
    async prStatus(n: number) {
      return {
        state: 'open',
        failing: [],
        armed: false,
        queued: worlds[n].queued ?? false,
        headSha: worlds[n].head ?? HEAD,
        base: 'main',
      };
    },
    async armFacts(n: number): Promise<ArmFacts> {
      const w = worlds[n];
      return {
        state: 'OPEN',
        isDraft: false,
        labels: Object.keys(w.labelledAt ?? {}).map((name) => ({ name })),
        reviewDecision: '',
        checks: w.checks ?? [{ name: 'ci', bucket: 'pass' }],
        headRefOid: w.head ?? HEAD,
        headRefName: `b-${n}`,
        baseRefName: 'main',
        isCrossRepository: false,
        files: w.files,
      };
    },
    async requiredChecks() {
      return ['ci'];
    },
    async labelledAt(n: number, label: string) {
      return worlds[n].labelledAt?.[label] ?? null;
    },
    async headPushedAt() {
      return PUSHED;
    },
    async behindBy(_base: string, _sha: string) {
      const w = Object.entries(worlds).find(([, v]) => (v.head ?? HEAD) === _sha);
      return w?.[1].behind ?? 0;
    },
    async arm(n: number, sha: string) {
      armed.push([n, sha]);
    },
  };
  return { forge: forge as unknown as Forge, armed };
}

async function flow(
  argv: string[],
  forge: Forge,
  opts: { guard?: RecordingGuard; items?: WorkItem[]; config?: Record<string, unknown> } = {}
) {
  temp ??= tempProject({
    tracker: 'fake',
    identity: { agent: 'flow-bot', reviewer: 'dorian' },
    ...opts.config,
  });
  let out = '';
  let err = '';
  const code = await main([...argv, '--json'], {
    env: { DORK_HOME: temp.dorkHome },
    cwd: temp.project,
    now: () => new Date('2026-09-30T12:00:00Z'),
    stdout: { write: (c: string) => (out += c) },
    stderr: { write: (c: string) => (err += c) },
    createAdapter: async () => createFakeAdapter({ items: opts.items ?? [] }).adapter,
    runProcess: github,
    createForge: () => forge,
    ...(opts.guard === undefined ? {} : { armGuard: opts.guard.guard as ArmGuard }),
    flowRoot: temp.plugin,
    io: { osHome: temp.osHome },
    verbs: VERBS,
  });
  return { code, json: out === '' ? null : JSON.parse(out), stderr: err };
}

const allLabels = { 'security-reviewed': AFTER, 'qa-go': AFTER };

describe('flow sweep', () => {
  it('a cleared PR is armed, through the guard, at the head its labels cover', async () => {
    const { forge, armed } = forgeFor([open(1)], {
      1: { files: ['src/a.ts'], labelledAt: allLabels },
    });
    const guard = recordingGuard();
    const r = await flow(['sweep', '--arm'], forge, { guard });
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.results).toMatchObject([{ number: 1, outcome: 'armed', head: HEAD }]);
    expect(guard.requests).toMatchObject([{ pr: 1, reviewedSha: HEAD, preArm: 'defer' }]);
    expect(armed).toEqual([[1, HEAD]]);
  });

  it('a moved head is not armed: the labels predate it, and the reason says so', async () => {
    const { forge, armed } = forgeFor([open(2)], {
      2: { files: ['src/a.ts'], labelledAt: { 'security-reviewed': BEFORE, 'qa-go': AFTER } },
    });
    const guard = recordingGuard();
    const r = await flow(['sweep', '--arm'], forge, { guard });
    expect(r.json.results).toMatchObject([
      { number: 2, outcome: 'not-cleared', reason: 'security-label-stale' },
    ]);
    expect(r.json.results[0].detail).toMatch(/added before the head moved to ccccccc/);
    expect(guard.requests).toEqual([]);
    expect(armed).toEqual([]);
  });

  it('a red required check is not armed', async () => {
    const { forge, armed } = forgeFor([open(3)], {
      3: { files: ['src/a.ts'], labelledAt: allLabels, checks: [{ name: 'ci', bucket: 'fail' }] },
    });
    const r = await flow(['sweep', '--arm'], forge, { guard: recordingGuard() });
    expect(r.json.results).toMatchObject([{ outcome: 'not-cleared', reason: 'checks-not-green' }]);
    expect(armed).toEqual([]);
  });

  it('a check still running, or a required one never reported, is not green', async () => {
    const { forge } = forgeFor([open(4), open(5)], {
      4: {
        files: ['src/a.ts'],
        labelledAt: allLabels,
        checks: [{ name: 'ci', bucket: 'pending' }],
      },
      5: { files: ['src/a.ts'], labelledAt: allLabels, checks: [] },
    });
    const r = await flow(['sweep', '--arm'], forge, { guard: recordingGuard() });
    expect(r.json.results.map((x: { reason: string }) => x.reason)).toEqual([
      'checks-not-green',
      'checks-not-green',
    ]);
  });

  it('a cleared PR the guard refuses stays unarmed, with the guard’s reason', async () => {
    const { forge, armed } = forgeFor([open(6)], {
      6: { files: ['src/a.ts'], labelledAt: allLabels },
    });
    const r = await flow(['sweep', '--arm'], forge, {
      guard: recordingGuard(() => refusal('held-by-label')),
    });
    expect(r.json.results).toMatchObject([{ outcome: 'refused', reason: 'held-by-label' }]);
    expect(armed).toEqual([]);
  });

  it('a light PR needs no QA label, but always the Security label', async () => {
    const { forge, armed } = forgeFor([open(7), open(8)], {
      7: { files: ['package-lock.json'], labelledAt: { 'security-reviewed': AFTER } },
      8: { files: ['package-lock.json'], labelledAt: { 'qa-go': AFTER } },
    });
    const r = await flow(['sweep', '--arm'], forge, { guard: recordingGuard() });
    expect(r.json.results).toMatchObject([
      { number: 7, outcome: 'armed', route: { class: 'light' } },
      { number: 8, outcome: 'not-cleared', reason: 'security-label-missing' },
    ]);
    expect(armed).toEqual([[7, HEAD]]);
  });

  it('a PR touching a design path needs the design label', async () => {
    const { forge } = forgeFor([open(9)], {
      9: { files: ['apps/client/src/Button.tsx'], labelledAt: allLabels },
    });
    const r = await flow(['sweep', '--arm'], forge, {
      guard: recordingGuard(),
      config: { review: { designPaths: ['apps/client/**'] } },
    });
    expect(r.json.results).toMatchObject([
      { outcome: 'not-cleared', reason: 'design-label-missing' },
    ]);
  });

  it('skips armed PRs, and reports a queued one', async () => {
    const { forge } = forgeFor([open(10, { armed: true }), open(11)], {
      10: { files: ['src/a.ts'] },
      11: { files: ['src/a.ts'], labelledAt: allLabels, queued: true },
    });
    const r = await flow(['sweep', '--arm'], forge, { guard: recordingGuard() });
    expect(r.json.results).toMatchObject([
      { number: 11, outcome: 'not-cleared', reason: 'queued' },
    ]);
  });

  it('arms nothing unless drain.armAutoMerge is on or --arm is passed', async () => {
    const { forge, armed } = forgeFor([open(13)], {
      13: { files: ['src/a.ts'], labelledAt: allLabels },
    });
    const guard = recordingGuard();
    const r = await flow(['sweep'], forge, { guard });
    expect(r.json.results).toMatchObject([{ outcome: 'would-arm' }]);
    expect(guard.requests).toEqual([]);
    expect(armed).toEqual([]);
    temp?.cleanup();
    temp = undefined;
    const on = await flow(['sweep'], forge, { guard, config: { drain: { armAutoMerge: true } } });
    expect(on.json.results).toMatchObject([{ outcome: 'armed' }]);
    expect(armed).toEqual([[13, HEAD]]);
  });

  it('--dry-run arms nothing', async () => {
    const { forge, armed } = forgeFor([open(12)], {
      12: { files: ['src/a.ts'], labelledAt: allLabels },
    });
    const guard = recordingGuard();
    const r = await flow(['sweep', '--arm', '--dry-run'], forge, { guard });
    expect(r.json.results).toMatchObject([{ outcome: 'would-arm' }]);
    expect(guard.requests).toEqual([]);
    expect(armed).toEqual([]);
  });
});

describe('flow prs', () => {
  it('flags stale and far-behind PRs with a prompt naming the owner', async () => {
    const prs = [
      open(20, { createdAt: '2026-09-20T00:00:00Z', author: 'priya', headSha: OLD }),
      open(21, { createdAt: '2026-09-30T00:00:00Z', author: 'kai' }),
      open(22, { createdAt: '2026-09-30T00:00:00Z', headSha: 'e'.repeat(40) }),
    ];
    const { forge } = forgeFor(prs, {
      20: { files: [], head: OLD, behind: 2 },
      21: { files: [], behind: 25 },
      22: { files: [], head: 'e'.repeat(40), behind: 1 },
    });
    const r = await flow(['prs'], forge);
    expect(r.code, r.stderr).toBe(0);
    expect(r.json.stuck).toMatchObject([
      { number: 20, owner: 'priya', stale: true, farBehind: false },
      { number: 21, owner: 'kai', stale: false, farBehind: true, behind: 25 },
    ]);
    expect(r.json.prs[0].headRefName).toBe('b-20');
    expect(r.json.stuck[0].prompt).toBe(
      '#20 is open 10 days (over 3): @priya, ship it, split it or close it?'
    );
    expect(r.json.stuck[1].prompt).toMatch(/25 commits behind \(over 20\): @kai/);
    expect(r.json.prCap).toMatchObject({ open: 3, max: 8, atCap: false });
  });

  it('--for refuses at the cap, naming the PRs, and lets a P0 item through', async () => {
    const prs = [open(30), open(31)];
    const { forge } = forgeFor(prs, {});
    const config = { pr: { maxOpen: 2 } };
    const refused = await flow(['prs', '--for', 'ACME-1'], forge, {
      items: [readyItem('ACME-1', { priority: 2 })],
      config,
    });
    expect(refused.code).toBe(5);
    expect(refused.stderr).toMatch(/at the cap of 2.*#30, #31/);
    temp?.cleanup();
    temp = undefined;
    const urgent = await flow(['prs', '--for', 'ACME-1'], forge, {
      items: [readyItem('ACME-1', { priority: 1 })],
      config,
    });
    expect(urgent.code, urgent.stderr).toBe(0);
    expect(urgent.json.mayOpen).toBe(true);
  });
});
