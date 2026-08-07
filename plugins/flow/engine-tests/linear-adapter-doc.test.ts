/**
 * Doc-completeness guard for the `linear-adapter` skill (spec §3; task 1.1).
 *
 * The v1 `PMClient` is a PROSE contract — a SKILL.md the agent reads and follows,
 * not executable code. A prose contract has no compiler to keep it complete, so
 * this cheap structural test pins that the contract documents every capability
 * verb, the core `WorkItem` fields, and the load-bearing invariants. If the
 * adapter shape (spec §3) changes, this test is the early warning that the prose
 * drifted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { sizeOrdinal } from '../scripts/dispatch-policy.ts';

// engine-tests -> plugins/flow (the plugin bundle root)
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = path.join(pluginRoot, 'skills', 'linear-adapter', 'SKILL.md');

const skill = readFileSync(skillPath, 'utf8');

/**
 * The capability verbs the generic layer knows (spec §3): the contract's
 * required verbs, the groom-only `getBacklogSnapshot` read this adapter adds,
 * and `completeProject` — the contract's one OPTIONAL verb, which this adapter
 * declares supported (adapters/SPEC.md 1.1.0). An optional verb is only listed
 * here because THIS adapter supports it; an adapter that did not would say so
 * instead, and would not carry the name.
 */
const VERBS = [
  'getCurrentUser',
  'getProjects',
  'getEligibleWork',
  'getInbox',
  'getRelations',
  'getBacklogSnapshot',
  'claim',
  'transition',
  'comment',
  'assignToHuman',
  'attachEvidence',
  'needsInput',
  'link',
  'createSubIssue',
  'completeProject',
] as const;

/** The core `WorkItem` normalization fields (spec §3). */
const WORK_ITEM_FIELDS = [
  'id',
  'identifier',
  'title',
  'description',
  'type',
  'stateCategory',
  'stateName',
  'priority',
  'size',
  'project',
  'parent',
  'relations',
  'labels',
  'assignee',
  'agentDisposition',
] as const;

describe('linear-adapter SKILL.md — prose-contract completeness', () => {
  it('has valid skill frontmatter (name + description)', () => {
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^name:\s*linear-adapter\s*$/m);
    expect(skill).toMatch(/^description:\s*.+/m);
  });

  it.each(VERBS)('documents the `%s` verb', (verb) => {
    expect(skill).toContain(verb);
  });

  it.each(WORK_ITEM_FIELDS)('documents the WorkItem field `%s`', (field) => {
    expect(skill).toContain(field);
  });

  it('documents stateCategory matching on CATEGORY, never on display name', () => {
    // The load-bearing rule: branch on category, not the team-customizable name.
    expect(skill).toMatch(/categor/i);
    expect(skill).toMatch(
      /never on (display )?name|never on the display name|NEVER ON DISPLAY NAME/i
    );
    for (const category of ['backlog', 'unstarted', 'started', 'completed', 'canceled']) {
      expect(skill).toContain(category);
    }
  });

  it('documents the agent/* labels as the durable state machine (not the plan field)', () => {
    expect(skill).toMatch(/agent\/\*/);
    expect(skill).toMatch(/state machine/i);
    for (const label of ['agent/ready', 'agent/claimed', 'agent/completed', 'agent/needs-input']) {
      expect(skill).toContain(label);
    }
  });

  it('documents the getInbox entry shape { item, comment: { author, mentions[], body } }', () => {
    for (const token of ['item', 'comment', 'author', 'mentions', 'body']) {
      expect(skill).toContain(token);
    }
  });

  it('documents needsInput as label + comment + assign-to-human + stop', () => {
    expect(skill).toContain('agent/needs-input');
    expect(skill).toMatch(/assign/i);
    expect(skill).toMatch(/\bstop\b/i);
  });

  it('documents graceful degradation for trackers lacking stateCategory/priority/size', () => {
    expect(skill).toMatch(/graceful degradation/i);
    expect(skill).toMatch(/neutral/i);
  });

  it('documents both Linear access paths as a config-driven transport (cli + mcp), account never hardcoded', () => {
    expect(skill).toMatch(/mcp__(plugin_)?linear/);
    expect(skill).toMatch(/composio/i);
    // The account is read from config, never hardcoded (no literal `--account personal`).
    expect(skill).not.toContain('--account personal');
    expect(skill).toContain('trackerAccount');
    expect(skill).toMatch(/--account\s+"?<trackerAccount>"?/);
    // The transport is an explicit config knob, not an implicit MCP-first default.
    expect(skill).toContain('connection.transport');
    expect(skill).toMatch(/artblocks/); // the never-touch warning is present
  });

  it('reads team + workspace from config instead of hardcoding them', () => {
    // The three connection coordinates are config reads, not inline literals.
    expect(skill).toContain('connection.team.key');
    expect(skill).toContain('connection.team.id');
    expect(skill).toContain('connection.workspace.slug');
    // The old hardcoded DorkOS team id must be gone from the adapter prose.
    expect(skill).not.toContain('a171dbd5');
  });

  it('calls out the MCP-must-be-authenticated-as-trackerAccount footgun', () => {
    // Selecting the `mcp` transport silently acts as whoever OAuth'd the server
    // unless it is the same identity as trackerAccount — the adapter must warn.
    expect(skill).toMatch(/mcp/i);
    expect(skill).toMatch(/same identity|authenticated as|OAuth/i);
    expect(skill).toContain('get_authenticated_user');
  });

  it('states the sub-issue promotion rule as an ORDINAL comparison, and states it truly', () => {
    // `size` is the union `number | string`, so `size >= "xl"` is a comparison
    // between two vocabularies — the contradiction DOR-515 closed. The prose
    // must carry the ordinal form, and the concrete values it quotes must
    // actually be what the oracle computes: the rule now lives in 8 prose sites
    // across 7 files, and moving a breakpoint would otherwise update the unit
    // test while every one of those went quietly wrong.
    expect(skill).toContain('sizeOrdinal(size) >= sizeOrdinal(');
    expect(skill).not.toMatch(/`size\s*[><≥]=?\s*decomposition\.subIssueThreshold`/);

    // The prose states `sizeOrdinal(8)` and `sizeOrdinal("xl")` are both 4.
    // Bind that literal claim to the oracle, so the two cannot drift apart.
    const claimed = skill.match(
      /`sizeOrdinal\(8\)`\s*and\s*\n?\s*`sizeOrdinal\("xl"\)`\s*are\s*both\s*`(\d+)`/
    );
    expect(claimed, 'the SKILL must state the concrete shared-scale value').not.toBeNull();
    const stated = Number(claimed?.[1]);
    expect(sizeOrdinal('xl')).toBe(stated);
    expect(sizeOrdinal(8)).toBe(stated);
  });

  it('frames itself as a prose contract that P5 promotes into a typed PMClient', () => {
    expect(skill).toMatch(/prose contract/i);
    expect(skill).toContain('PMClient');
    expect(skill).toMatch(/P5/);
  });
});
