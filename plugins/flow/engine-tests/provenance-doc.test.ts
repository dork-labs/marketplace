/**
 * Doc guard for the **agent provenance signature** — the convention that every
 * outward write to a tracker or forge carries a machine-readable line naming the
 * runtime, session and account that wrote it, so a later reader can route a
 * follow-up back to the originating session.
 *
 * The signature is a PROSE contract spread over five surfaces that have to agree:
 * the canonical spec (the adapter skill), the two emitters that reference it
 * (`verifying-work`, `templates/pr.md`), the field table the run fills in
 * (`executing-specs` Phase 0.5), and the reader that routes on it
 * (`tending-tracker`). Prose has no compiler, and a marker name that drifts on one
 * surface produces exactly the failure the convention exists to prevent: a reader
 * that silently parses nothing, then reports a resume it never performed.
 *
 * So this test pins the load-bearing claims by name — the marker name, the `v`
 * field, the never-an-email rule, the legacy-reader clause, the emission list, and
 * the three routing paths — and binds the documented field set to the on-disk
 * schema, since a Zod object strips unknown keys and would drop a field the prose
 * promises without ever erroring.
 *
 * **Every multi-word phrase is matched against whitespace-flattened text.** These
 * files are hard-wrapped at ~80 columns, so a phrase assertion against the raw
 * bytes fails the moment someone re-wraps a paragraph — a false red that teaches
 * people to delete the guard. Flattening keeps the guard about the CLAIM. Only
 * line-anchored assertions (table rows, headings) read the raw text, where the
 * line structure is the thing being pinned.
 *
 * Sibling of `linear-adapter-doc.test.ts`, same shape and same purpose.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { FlowRunSchema } from '../scripts/flow-state.ts';

// engine-tests -> plugins/flow (the plugin bundle root)
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (...parts: string[]): string => readFileSync(path.join(pluginRoot, ...parts), 'utf8');

/** Collapse every whitespace run to one space, so a hard-wrapped phrase still matches. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const adapter = read('skills', 'linear-adapter', 'SKILL.md');
const verifying = read('skills', 'verifying-work', 'SKILL.md');
const executing = read('skills', 'executing-specs', 'SKILL.md');
const tending = read('skills', 'tending-tracker', 'SKILL.md');
const prTemplate = read('templates', 'pr.md');

const adapterFlat = flat(adapter);
const verifyingFlat = flat(verifying);
const executingFlat = flat(executing);
const tendingFlat = flat(tending);
const prTemplateFlat = flat(prTemplate);

/**
 * The fields the canonical spec documents. Every one must appear in the spec's
 * field table AND be accepted by the on-disk provenance schema — the prose and the
 * validator are two halves of one contract.
 */
const SIGNATURE_FIELDS = [
  'v',
  'harness',
  'sessionId',
  'account',
  'host',
  'instanceId',
  'surface',
  'resumeUrl',
] as const;

describe('agent provenance — the canonical spec lives in the adapter skill', () => {
  it('declares itself the one authoritative definition', () => {
    expect(adapter).toMatch(/^## Provenance: signing outward writes$/m);
    expect(adapterFlat).toMatch(/canonical spec for the provenance signature/i);
    // Other skills reference it; none redefines it.
    expect(adapterFlat).toMatch(/references it and none redefines it/i);
  });

  it('pins the EMITTED marker name as `agent:provenance`, not `flow:provenance`', () => {
    // The name is the whole interoperability surface: a reader greps for this
    // literal. `agent:` rather than `flow:` because the convention is
    // runtime-agnostic and emitted by sessions that never ran flow.
    expect(adapter).toContain('<!-- agent:provenance');
    expect(adapterFlat).toMatch(/The prefix is `agent:` because/);
    expect(adapterFlat).toMatch(/runtime-agnostic/i);
  });

  it('carries the `v` field, and shows it in the marker example', () => {
    expect(adapter).toContain('"v":1');
    expect(adapter).toMatch(/\|\s*`v`\s*\|/);
    expect(adapterFlat).toMatch(/schema version/i);
  });

  it('accepts the LEGACY `flow:provenance` name on read, and forbids emitting it', () => {
    // Readers must keep parsing signatures written before the rename — same field
    // shape, no `v` — or every already-stamped PR body becomes unroutable.
    expect(adapter).toContain('flow:provenance');
    expect(adapterFlat).toMatch(/legacy/i);
    expect(adapterFlat).toMatch(/A reader must accept both names/);
    expect(adapterFlat).toMatch(/treat a missing `v` as `v: 1`/);
    expect(adapterFlat).toMatch(/Never emit the legacy name/);
  });

  it('bans an email address in `account` (and everywhere else)', () => {
    // These bodies land on public forges, where a comment is world-readable and
    // permanent. The rule has to be stated, not implied by "non-PII".
    expect(adapterFlat).toMatch(/\*\*NEVER an email address/);
    expect(adapterFlat).toMatch(/Never put an email address in `account`/);
    expect(adapterFlat).toMatch(/non-PII/);
    expect(adapterFlat).toMatch(/public forge|world-readable/i);
  });

  it('documents the public-repo `sessionId` prefix as an opaque, locally-matched token', () => {
    expect(adapterFlat).toMatch(/first \*\*8 characters\*\*|first 8 characters/i);
    expect(adapterFlat).toMatch(/opaque token/i);
    expect(adapterFlat).toMatch(/prefix-match/i);
  });

  it.each(SIGNATURE_FIELDS)('documents the `%s` field', (field) => {
    expect(adapter).toMatch(new RegExp(`\\|\\s*\`${field}\`\\s*\\|`));
  });

  it('keeps `identity.marker` separate: human-facing marker vs machine-facing signature', () => {
    expect(adapter).toMatch(/identity\.marker/);
    expect(adapterFlat).toMatch(/human- and self-facing/i);
    expect(adapterFlat).toMatch(/machine-facing/i);
    expect(adapterFlat).toMatch(/Write both/);
  });

  it('states the omit-never-fabricate rule and the valid-JSON discipline', () => {
    expect(adapterFlat).toMatch(/Emit only what the run actually has/);
    expect(adapterFlat).toMatch(/An omitted field is a fact/);
    expect(adapterFlat).toMatch(/JSON-escape every value/);
    expect(adapterFlat).toMatch(/valid JSON/);
  });

  it('reads the NEWEST signature when a thread carries several', () => {
    expect(adapterFlat).toMatch(/newest signature wins/i);
  });
});

describe('agent provenance — the emission list', () => {
  it('names `comment` as a signed write', () => {
    // The emission list is the part that makes this more than a PR-body stamp.
    expect(adapter).toMatch(/^\|\s*`comment\(item, body\)`\s*\|\s*\*\*Yes\*\*/m);
  });

  it('names `needsInput` as a signed write', () => {
    expect(adapter).toMatch(/^\|\s*`needsInput\(item, question\)`[^|]*\|\s*\*\*Yes\*\*/m);
  });

  it('names issue descriptions, PR bodies and PR comments as signed writes', () => {
    for (const surface of ['issue description', 'PR body', 'PR comment']) {
      expect(adapterFlat.toLowerCase()).toContain(surface.toLowerCase());
    }
  });

  it('names the bodiless writes that do NOT carry it, so the list is a decision not a wish', () => {
    // A guard that only lists what IS signed can be satisfied by signing
    // everything, including writes with no body to sign.
    expect(adapter).toMatch(/^\|[^|]*`claim`[^|]*\|\s*\*\*No\*\*/m);
    expect(adapter).toMatch(/^\|\s*`attachEvidence`\s*\|\s*\*\*No\*\*/m);
    expect(adapterFlat).toMatch(/verbatim/);
  });

  it('the `comment` and `needsInput` verb rows themselves say they carry the line', () => {
    // The verbs table is what an agent actually reads when it writes; the
    // emission list below it must not be the only place the rule appears.
    const commentRow = adapter.match(/^\|\s*\*\*`comment\(item, body\)`\*\*.*$/m)?.[0] ?? '';
    expect(commentRow).toContain('agent:provenance');
    const needsInputRow =
      adapter.match(/^\|\s*\*\*`needsInput\(item, question\)`\*\*.*$/m)?.[0] ?? '';
    expect(needsInputRow).toContain('agent:provenance');
  });
});

describe('agent provenance — the emitters reference the spec instead of redefining it', () => {
  it('VERIFY emits `agent:provenance` and names the legacy read-side name', () => {
    expect(verifying).toContain('agent:provenance');
    expect(verifyingFlat).toMatch(/legacy name/i);
    expect(verifying).toContain('flow:provenance');
    // It must point at the canonical section rather than restating the shape.
    expect(verifyingFlat).toMatch(/Provenance: signing outward writes/);
    expect(verifyingFlat).toMatch(/do not redefine|defined once/i);
    // VERIFY still owns the cadence: once per run.
    expect(verifyingFlat).toMatch(/once-per-run/i);
    expect(verifyingFlat).toMatch(/never an email address/i);
  });

  it('the PR template emits `agent:provenance` with `v`', () => {
    expect(prTemplate).toContain('<!-- agent:provenance {"v":1');
    expect(prTemplateFlat).toMatch(/never an email address/i);
  });

  it('NO shipped surface still emits the legacy marker literal', () => {
    // Mentioning `flow:provenance` as the legacy READ name is required; writing
    // `<!-- flow:provenance` is the emission this change retires.
    const roots = ['skills', 'commands', 'hooks', 'scripts', 'templates', 'docs'];
    const files = roots.flatMap((root) => walk(path.join(pluginRoot, root)));
    const offenders = files.filter((file) =>
      readFileSync(file, 'utf8').includes('<!-- flow:provenance')
    );
    expect(offenders.map((f) => path.relative(pluginRoot, f))).toEqual([]);
  });
});

describe('agent provenance — EXECUTE Phase 0.5 fills the block', () => {
  it.each(['v', 'account', 'instanceId', 'surface', 'resumeUrl'] as const)(
    'documents the `%s` field in the Phase 0.5 table',
    (field) => {
      expect(executing).toMatch(new RegExp(`\\|\\s*\`${field}\`\\s*\\|`));
    }
  );

  it('gives per-harness derivation guidance for `account`, and says derive-never-guess', () => {
    expect(executing).toContain('CLAUDE_CONFIG_DIR');
    expect(executingFlat).toMatch(/\*\*Derive it, never guess\*\*/);
    // codex / opencode get their own profile/home analog, not a guess.
    expect(executingFlat).toMatch(/`codex` and `opencode`/);
    expect(executingFlat).toMatch(/profile \/ home directory/i);
    expect(executingFlat).toMatch(/cannot derive it, \*\*omit it\*\*/);
    expect(executingFlat).toMatch(/never an email address/i);
  });

  it('scopes `instanceId` to DorkOS runs and forbids substituting the hostname', () => {
    expect(executingFlat).toMatch(/when this run is under DorkOS/i);
    expect(executingFlat).toMatch(/Omit it entirely outside DorkOS/);
    expect(executingFlat).toMatch(/Do not substitute the hostname/);
  });
});

describe('agent provenance — the reader routes on it', () => {
  it('parses the NEWEST signature before acting, accepting either marker name', () => {
    expect(tending).toMatch(/^#### Routing a reply back to its originating session$/m);
    expect(tending).toContain('agent:provenance');
    expect(tending).toContain('flow:provenance');
    expect(tendingFlat).toMatch(/newest agent provenance/i);
    // Before acting, not after having written into the wrong session.
    expect(tendingFlat).toMatch(/runs \*\*before\*\* you act/);
  });

  it('documents path (a): same host + harness + resumable → deliver INTO that session', () => {
    expect(tending).toMatch(/--resume <sessionId>/);
    expect(tending).toContain('POST /api/sessions/<id>/messages');
    expect(tendingFlat).toMatch(/`instanceId` matching this install/);
    expect(tendingFlat).toMatch(/\*\*\(a\)\*\*/);
    expect(tendingFlat).toMatch(/Deliver the follow-up INTO that session/);
  });

  it('documents path (b): same host, session gone → fresh session seeded with the thread', () => {
    expect(tendingFlat).toMatch(/\*\*\(b\)\*\*/);
    expect(tendingFlat).toMatch(/fresh session seeded with the thread/i);
  });

  it('documents path (c): different host/instance → handle here and SAY so', () => {
    expect(tendingFlat).toMatch(/\*\*\(c\)\*\*/);
    expect(tendingFlat).toMatch(/different `host`/);
    expect(tendingFlat).toMatch(/recorded future step, not something to fake/i);
    expect(tendingFlat).toMatch(/Handle it in the current session, and say so/);
  });

  it('forbids silence about which path was taken — the tick report names it', () => {
    expect(tendingFlat).toMatch(/Silence about which path you took is not allowed/);
    expect(tendingFlat).toMatch(/tick report \*\*names the path\*\*/);
  });

  it('requires every reply this loop writes to be signed', () => {
    expect(tendingFlat).toMatch(/always carry the provenance signature/i);
    expect(tendingFlat).toMatch(/never an email address/i);
  });

  it('stays PM-agnostic: it points at the spec by section, never by tracker name', () => {
    // The tracker-confinement guard enforces the general rule; this pins that the
    // reference added here is the section title, which is what keeps it portable.
    expect(tendingFlat).toMatch(/adapter skill's "Provenance: signing outward writes" section/);
  });
});

describe('agent provenance — the prose field set matches the on-disk schema', () => {
  /**
   * The drift this closes: `z.object` STRIPS unknown keys. A field the spec
   * promises but the schema omits is written to `flow-state.json` by EXECUTE and
   * silently gone by the time VERIFY reads it back — no error, just a signature
   * missing the fields that make it routable.
   */
  const baseRun = {
    issueId: 'issue-node-1',
    identifier: 'PROJ-1',
    sessionId: 'session-1',
    worktreePath: '/tmp/wt',
    branch: 'topic',
    stage: 'execute',
    status: 'running',
    attemptCount: 0,
    workerPid: 1234,
    startedAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('accepts and preserves every documented field through a parse', () => {
    const parsed = FlowRunSchema.parse({
      ...baseRun,
      provenance: {
        v: 1,
        harness: 'claude-code',
        sessionId: 'session-1',
        account: 'example-account',
        host: 'example-host',
        instanceId: '2f9c1e6a-0000-4000-8000-abcdefabcdef',
        surface: 'dorkos',
        resumeUrl: 'https://example.invalid/session/session-1',
      },
    });

    for (const field of SIGNATURE_FIELDS) {
      expect(
        parsed.provenance?.[field],
        `the schema dropped the documented provenance field \`${field}\``
      ).toBeDefined();
    }
  });

  it('still parses a legacy block carrying no `v` — the pre-rename shape', () => {
    const parsed = FlowRunSchema.parse({
      ...baseRun,
      provenance: { harness: 'claude-code', host: 'example-host' },
    });
    expect(parsed.provenance?.v).toBeUndefined();
    expect(parsed.provenance?.harness).toBe('claude-code');
  });
});

/** Recursively collect every file path under `dir` (flow dirs are small). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
