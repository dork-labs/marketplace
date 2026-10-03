/**
 * The `dashboard` config block (spec "Flow Dashboard", M1): the Zod schema
 * accepts a full block and resolves every default, refuses a product with a
 * missing key and a view that does not exist, and the zod-free reader the
 * extension and the self-test use applies the same rules, dropping only the
 * bad entry and naming it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FlowConfigSchema } from '../scripts/config-schema.ts';
import {
  DASHBOARD_DEFAULTS,
  DASHBOARD_VIEWS,
  linkKeysOf,
  parseDashboardBlock,
  readDashboardSettings,
  readProjectDashboard,
} from '../scripts/dashboard-config.ts';

/** A full block, with placeholder names only. */
const FULL = {
  teams: ['ACME', 'OPS'],
  repos: ['acme/app', 'acme/site'],
  products: [
    {
      id: 'app',
      repo: 'acme/app',
      versionFile: 'package.json',
      unreleased: 'changelog/unreleased',
      release: { kind: 'agent-command', command: '/release', dryRunFlag: '--dry-run' },
      watchWorkflows: ['release.yml', 'Publish'],
    },
  ],
  views: ['issues', 'prs', 'releases'],
  next: { limit: 5 },
  roadmap: { lanes: ['Now', 'Next', 'Later'] },
};

/**
 * The first Zod issue for a dashboard block, as `<path inside the block>: <message>`,
 * or `null` when it parses.
 */
function zodIssue(dashboard: unknown): string | null {
  const result = FlowConfigSchema.safeParse({ dashboard });
  if (result.success) return null;
  const [issue] = result.error.issues;
  expect(issue.path[0]).toBe('dashboard');
  return `${issue.path.slice(1).join('.')}: ${issue.message}`;
}

describe('the dashboard block in the Zod schema', () => {
  it('resolves to the zod-free defaults: nothing listed, every page on', () => {
    expect(FlowConfigSchema.parse({}).dashboard).toEqual(DASHBOARD_DEFAULTS);
    expect(DASHBOARD_DEFAULTS.views).toEqual(['next', 'roadmap', 'issues', 'prs', 'releases']);
  });

  it('accepts a full block as written', () => {
    expect(FlowConfigSchema.parse({ dashboard: FULL }).dashboard).toEqual(FULL);
  });

  it('defaults watchWorkflows and leaves release, next and roadmap out when absent', () => {
    const { release: _r, watchWorkflows: _w, ...bare } = FULL.products[0];
    const parsed = FlowConfigSchema.parse({ dashboard: { products: [bare] } }).dashboard;
    expect(parsed.products).toEqual([{ ...bare, watchWorkflows: [] }]);
    expect(parsed).not.toHaveProperty('next');
    expect(parsed).not.toHaveProperty('roadmap');
  });

  it.each(['id', 'repo', 'versionFile', 'unreleased'])('refuses a product without %s', (key) => {
    const product: Record<string, unknown> = { ...FULL.products[0] };
    delete product[key];
    expect(zodIssue({ products: [product] })).toMatch(new RegExp(`^products\\.0\\.${key}:`));
  });

  it('refuses a view that does not exist', () => {
    expect(zodIssue({ views: ['issues', 'burndown'] })).toMatch(/^views\.1:/);
  });

  it.each([
    ['a lowercase team key', { teams: ['acme'] }, /^teams\.0:/],
    ['a repo without an owner', { repos: ['app'] }, /^repos\.0:/],
    ['a versionFile outside the repo', { products: [{ ...FULL.products[0], versionFile: '../x' }] }, /^products\.0\.versionFile:/],
    ['an absolute unreleased folder', { products: [{ ...FULL.products[0], unreleased: '/tmp/x' }] }, /^products\.0\.unreleased:/],
    ['a release that is not an agent command', { products: [{ ...FULL.products[0], release: { kind: 'script', command: 'x', dryRunFlag: 'y' } }] }, /^products\.0\.release\.kind:/],
    ['two products with one id', { products: [FULL.products[0], FULL.products[0]] }, /^products:/],
    ['a next limit of 0', { next: { limit: 0 } }, /^next\.limit:/],
  ])('refuses %s', (_name, dashboard, path) => {
    expect(zodIssue(dashboard)).toMatch(path);
  });
});

describe('parseDashboardBlock (the zod-free reader)', () => {
  it('reads a full block exactly as the Zod schema does', () => {
    expect(parseDashboardBlock(FULL)).toEqual({ settings: FULL, problems: [] });
  });

  it('reads an absent block as the defaults', () => {
    expect(parseDashboardBlock(undefined)).toEqual({
      settings: DASHBOARD_DEFAULTS,
      problems: [],
    });
  });

  it('drops only the product with a missing key, and names it', () => {
    const { repo: _repo, ...noRepo } = FULL.products[0];
    const { settings, problems } = parseDashboardBlock({
      ...FULL,
      products: [noRepo, { ...FULL.products[0], id: 'site', repo: 'acme/site' }],
    });
    expect(settings.products.map((p) => p.id)).toEqual(['site']);
    expect(settings.repos).toEqual(FULL.repos);
    expect(problems).toEqual(['dashboard.products[0].repo is missing']);
  });

  it('drops a view that does not exist, and names it', () => {
    const { settings, problems } = parseDashboardBlock({ views: ['issues', 'burndown'] });
    expect(settings.views).toEqual(['issues']);
    expect(problems).toEqual([
      `dashboard.views[1] must be one of ${DASHBOARD_VIEWS.join(', ')}`,
    ]);
  });

  it('agrees with the Zod schema on every refusal above', () => {
    const cases: unknown[] = [
      { teams: ['acme'] },
      { repos: ['app'] },
      { products: [{ ...FULL.products[0], versionFile: '../x' }] },
      { products: [{ ...FULL.products[0], unreleased: '/tmp/x' }] },
      { products: [{ ...FULL.products[0], release: { kind: 'script', command: 'x', dryRunFlag: 'y' } }] },
      { products: [FULL.products[0], FULL.products[0]] },
      { next: { limit: 0 } },
      { views: 'issues' },
    ];
    for (const dashboard of cases) {
      expect(zodIssue(dashboard), JSON.stringify(dashboard)).not.toBeNull();
      expect(parseDashboardBlock(dashboard).problems, JSON.stringify(dashboard)).not.toEqual([]);
    }
  });
});

describe('reading the block from a project', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project whose `.agents/flow/` holds the given files. */
  function project(files: { config?: unknown; local?: unknown }): string {
    const root = mkdtempSync(path.join(tmpdir(), 'flow-dash-'));
    dirs.push(root);
    const dir = path.join(root, '.agents', 'flow');
    mkdirSync(dir, { recursive: true });
    if (files.config !== undefined) writeFileSync(path.join(dir, 'config.json'), JSON.stringify(files.config));
    if (files.local !== undefined) writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(files.local));
    return root;
  }

  it('is not configured without a dashboard block in either file', () => {
    expect(readProjectDashboard(project({ config: { tracker: 'linear' } }))).toEqual({
      configured: false,
      settings: DASHBOARD_DEFAULTS,
      problems: [],
    });
  });

  it('lets each key of config.local.json replace the same key of config.json', () => {
    const root = project({
      config: { dashboard: { teams: ['ACME'], repos: ['acme/app'] } },
      local: { dashboard: { repos: ['acme/fork'] } },
    });
    const read = readProjectDashboard(root);
    expect(read.configured).toBe(true);
    expect(read.settings.teams).toEqual(['ACME']);
    expect(read.settings.repos).toEqual(['acme/fork']);
  });

  it('reads files that do not exist as no block', () => {
    expect(readDashboardSettings({ committed: null, local: '/nowhere/config.local.json' }).configured).toBe(false);
  });
});

describe('linkKeysOf', () => {
  it('adds the project team and puts a longer key before a key it starts with', () => {
    const settings = { ...DASHBOARD_DEFAULTS, teams: ['AC', 'OPS'] };
    expect(linkKeysOf(settings, 'ACME')).toEqual(['ACME', 'OPS', 'AC']);
    expect(linkKeysOf(settings, null)).toEqual(['OPS', 'AC']);
  });
});
