/**
 * Doc guard for the **agent provenance signature** — the convention that every
 * outward write to a tracker or forge carries a machine-readable line naming the
 * runtime, session and account that wrote it, so a later reader can route a
 * follow-up back to the originating session.
 *
 * The signature is a PROSE contract spread over surfaces that have to agree: the
 * canonical spec (`docs/provenance.md`), the adapter contract that makes every
 * adapter sign (`adapters/SPEC.md`) and the authoring skill that generates them,
 * the emitters (`verifying-work`, `templates/pr.md`), the field table the run fills
 * in (`executing-specs` Phase 0.5), and the reader that routes on it
 * (`tending-tracker`). Prose has no compiler, and a marker name that drifts on one
 * surface produces exactly the failure the convention exists to prevent: a reader
 * that silently parses nothing, then reports a resume it never performed.
 *
 * So this test pins the load-bearing claims by name — the marker name, the `v`
 * field, the per-write cadence, the never-an-email rule, the legacy-reader clause,
 * the emission list, the wire-format boundary, the self-exclusion and precedence
 * rules, and the three routing paths — and binds the documented field set to the
 * on-disk schema.
 *
 * **Every multi-word phrase is matched against whitespace-flattened text.** These
 * files are hard-wrapped at ~80 columns, so a phrase assertion against the raw
 * bytes fails the moment someone re-wraps a paragraph — a false red that teaches
 * people to delete the guard. Flattening keeps the guard about the CLAIM. Only
 * line-anchored assertions (table rows, headings) read the raw text, where the line
 * structure is the thing being pinned.
 *
 * **Row-scoped assertions beat file-scoped ones.** A `toContain` against a whole
 * file passes as soon as the string appears ANYWHERE, which in these files it
 * usually already did. Where a claim belongs to one table row, this test extracts
 * that row and asserts inside it.
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

/**
 * The one markdown table row whose first cell matches `rowKey`, or `''` when there
 * is none. Scoping an assertion to its row is what stops it passing on an unrelated
 * sentence elsewhere in the file.
 */
function tableRow(markdown: string, rowKey: RegExp): string {
  const row = markdown
    .split('\n')
    .find((line) => line.startsWith('|') && rowKey.test(line.split('|')[1] ?? ''));
  return row ?? '';
}

const spec = read('docs', 'provenance.md');
const contract = read('adapters', 'SPEC.md');
const buildingAdapters = read('skills', 'building-adapters', 'SKILL.md');
const adapter = read('skills', 'linear-adapter', 'SKILL.md');
const verifying = read('skills', 'verifying-work', 'SKILL.md');
const executing = read('skills', 'executing-specs', 'SKILL.md');
const tending = read('skills', 'tending-tracker', 'SKILL.md');
const grooming = read('skills', 'grooming-backlog', 'SKILL.md');
const prTemplate = read('templates', 'pr.md');
const engineSpec = read('docs', 'SPEC.md');

const specFlat = flat(spec);
const contractFlat = flat(contract);
const buildingAdaptersFlat = flat(buildingAdapters);
const adapterFlat = flat(adapter);
const verifyingFlat = flat(verifying);
const executingFlat = flat(executing);
const tendingFlat = flat(tending);
const groomingFlat = flat(grooming);
const prTemplateFlat = flat(prTemplate);

/**
 * The eight fields that go ON THE WIRE. The local run record holds more
 * (`worktree`, `branch`, `agentId`); those must never reach a signed body.
 */
const WIRE_FIELDS = [
  'v',
  'harness',
  'sessionId',
  'account',
  'host',
  'surface',
  'instanceId',
  'resumeUrl',
] as const;

/** Fields the run records locally that must NOT appear in the wire field table. */
const LOCAL_ONLY_FIELDS = ['worktree', 'branch', 'agentId'] as const;

describe('agent provenance — the canonical spec is tracker-neutral and reachable', () => {
  it('lives at docs/provenance.md, not inside a tracker-specific skill', () => {
    // BLOCKER: a spec that only exists in the Linear adapter is unreachable on a
    // Jira or GitHub-Issues install, which is every install that is not this one.
    expect(spec).toMatch(/^# Agent Provenance — signing outward writes$/m);
    expect(specFlat).toMatch(/generic, tracker-neutral/i);
  });

  it('names no tracker', () => {
    // The neutrality that makes it reachable is testable, not aspirational.
    for (const trackerName of [
      /\bLinear\b/,
      /\bJira\b/,
      /mcp__(plugin_)?linear/,
      /LINEAR_[A-Z_]/,
    ]) {
      expect(spec).not.toMatch(trackerName);
    }
  });

  it('pins the EMITTED marker name as `agent:provenance`, not `flow:provenance`', () => {
    expect(spec).toContain('<!-- agent:provenance');
    expect(specFlat).toMatch(/The prefix is `agent:` because/);
    expect(specFlat).toMatch(/runtime-agnostic/i);
  });

  it('carries the `v` field, and shows it in the marker example', () => {
    expect(spec).toContain('"v":1');
    expect(spec).toMatch(/\|\s*`v`\s*\|/);
    expect(specFlat).toMatch(/schema version/i);
  });

  it('accepts the LEGACY `flow:provenance` name on read, and forbids emitting it', () => {
    expect(spec).toContain('flow:provenance');
    expect(specFlat).toMatch(/A reader must accept both names/);
    expect(specFlat).toMatch(/treat a missing `v` as `v: 1`/);
    expect(specFlat).toMatch(/Never emit the legacy name/);
  });

  it.each(WIRE_FIELDS)('documents the wire field `%s`', (field) => {
    expect(spec).toMatch(new RegExp(`\\|\\s*\`${field}\`\\s*\\|`));
  });

  it.each(LOCAL_ONLY_FIELDS)('keeps `%s` OFF the wire field table', (field) => {
    // An absolute worktree path is /Users/<real name>/…, and these bodies can be
    // public and permanent. The local record and the wire format are different.
    expect(spec).not.toMatch(new RegExp(`\\|\\s*\`${field}\`\\s*\\|`));
  });

  it('says explicitly that the local record is not the wire format', () => {
    expect(specFlat).toMatch(/These eight fields are the whole wire format/);
    expect(specFlat).toMatch(/stay in `flow-state.json`/);
    expect(specFlat).toMatch(/only the wire format is public/);
  });
});

describe('agent provenance — cadence is per-write, not once-per-run', () => {
  it('the canonical spec states the per-write rule in its own section', () => {
    // BLOCKER: an agent that reads "once-per-run" stops signing comments, and
    // routing dies silently because the message a human replies to is unsigned.
    expect(spec).toMatch(/^## 3\. Cadence — every outward write, every time$/m);
    expect(specFlat).toMatch(
      /The signature is PER-WRITE\. Every body the agent writes outward carries its own line, every time/
    );
    expect(specFlat).toMatch(/This is not a once-per-run stamp/);
  });

  it('scopes the once-per-run cadence to the PR BODY alone', () => {
    expect(specFlat).toMatch(/PR-body stamp is written once per run/);
    expect(specFlat).toMatch(/never a licence to leave a comment unsigned/);
  });

  it('VERIFY repeats the scoping instead of claiming the run-wide cadence', () => {
    expect(verifyingFlat).toMatch(
      /The signature itself is per-write: every body written outward carries it, every time/
    );
    expect(verifyingFlat).toMatch(/applies to \*\*the PR-body stamp only\*\*/);
    // And it must say the comments it and later ticks post are signed too.
    expect(verifyingFlat).toMatch(/carries its own signature like any other outward write/);
  });
});

describe('agent provenance — privacy rules', () => {
  it('bans an email address in `account` (and everywhere else)', () => {
    expect(specFlat).toMatch(/\*\*NEVER an email address\*\*/);
    expect(specFlat).toMatch(/Never put an email address in `account`/);
    expect(specFlat).toMatch(/non-PII/);
    expect(specFlat).toMatch(/public forge|world-readable/i);
  });

  it('says `account` is the HARNESS account, never the tracker account', () => {
    // The footgun: a tracker's "authenticated user" read returns a real person.
    expect(specFlat).toMatch(/`account` is the \*\*harness account\*\*/i);
    expect(specFlat).toMatch(/not\*\* the tracker account/i);
    expect(executingFlat).toMatch(/never the tracker account/i);
  });

  it('omits `account` entirely when the derived value contains an `@`', () => {
    expect(specFlat).toMatch(/contains an `@`, omit `account` entirely/);
    expect(executingFlat).toMatch(/contains an `@`, omit `account` entirely/);
  });

  it('warns that `host` can carry a real name, and says to consider omitting it', () => {
    expect(specFlat).toMatch(/Firstname-Lastname-MacBook-Pro\.local/);
    expect(specFlat).toMatch(/consider omitting `host`/i);
  });

  it('in a public repo: truncate sessionId AND omit resumeUrl', () => {
    // Truncating the id while shipping a URL containing the same id is theatre.
    expect(specFlat).toMatch(/\*\*first 8 characters\*\*/);
    expect(specFlat).toMatch(/opaque token/i);
    expect(specFlat).toMatch(/prefix-match/i);
    expect(specFlat).toMatch(/\*\*`resumeUrl`\*\* — \*\*omit it\.\*\*/);
    expect(specFlat).toMatch(/not privacy, it is theatre/);
  });

  it('names a decidable visibility check, and fails SAFE when undeterminable', () => {
    expect(specFlat).toMatch(/gh repo view --json visibility/);
    expect(specFlat).toMatch(
      /\*\*When visibility cannot be determined, treat the repository as public\.\*\*/
    );
    expect(specFlat).toMatch(/fail-safe direction/i);
    // VERIFY writes the single most public body, so it must carry the pointer.
    expect(verifyingFlat).toMatch(/public-repository rules/);
    expect(verifyingFlat).toMatch(/truncate `sessionId` and omit `resumeUrl`/);
  });
});

describe('agent provenance — the emission list', () => {
  it('names `comment` as a signed write', () => {
    expect(tableRow(spec, /`comment\(item, body\)`/)).toMatch(/\*\*Yes\*\*/);
  });

  it('names `needsInput` as a signed write', () => {
    expect(tableRow(spec, /`needsInput\(item, question\)`/)).toMatch(/\*\*Yes\*\*/);
  });

  it('names `createSubIssue` and authored descriptions as signed writes', () => {
    // Row-scoped: "issue description" appears in plenty of unrelated prose.
    expect(tableRow(spec, /`createSubIssue/)).toMatch(/\*\*Yes\*\*/);
    expect(tableRow(spec, /item description the agent authors/)).toMatch(/\*\*Yes\*\*/);
  });

  it('names PR bodies and PR comments as signed writes', () => {
    expect(tableRow(spec, /PR body/)).toMatch(/\*\*Yes\*\*/);
    expect(tableRow(spec, /PR comment/)).toMatch(/\*\*Yes\*\*/);
  });

  it('names the bodiless writes that do NOT carry it, so the list is a decision not a wish', () => {
    expect(tableRow(spec, /`claim`/)).toMatch(/\*\*No\*\*/);
    expect(tableRow(spec, /`attachEvidence`/)).toMatch(/\*\*No\*\*/);
    expect(tableRow(spec, /verbatim/)).toMatch(/\*\*No\*\*/);
  });

  it('a description write REPLACES an existing signature, never appends a second', () => {
    // There is no ordering rule inside one body, so two signatures are unreadable.
    expect(specFlat).toMatch(
      /A description write REPLACES any signature already in that description/
    );
    expect(specFlat).toMatch(/never appends a second one/);
    expect(specFlat).toMatch(
      /no ordering rule _inside_ a single body|no ordering rule inside a single body/
    );
    // The bulk description-rewrite path inherits it.
    expect(groomingFlat).toMatch(/A description rewrite re-signs, it does not accumulate/);
  });

  it('the adapter verb rows themselves say they carry the line', () => {
    expect(tableRow(adapter, /\*\*`comment\(item, body\)`\*\*/)).toContain('agent:provenance');
    expect(tableRow(adapter, /\*\*`needsInput\(item, question\)`\*\*/)).toContain(
      'agent:provenance'
    );
    expect(tableRow(adapter, /\*\*`createSubIssue/)).toContain('agent:provenance');
  });
});

describe('agent provenance — it reaches adapters that are not this tracker', () => {
  it('the adapter CONTRACT requires the signature on `comment`', () => {
    // BLOCKER: without this, a generated Jira/GitHub adapter never signs and the
    // whole feature is dead on every install that is not the reference one.
    const commentSection = contract.split('#### `comment(')[1] ?? '';
    expect(commentSection).toContain('agent:provenance');
    expect(flat(commentSection)).toMatch(/\*\*and must carry the `agent:provenance` signature\*\*/);
  });

  it('the contract requires it on `needsInput` and the `createSubIssue` description', () => {
    const needsInputSection = contract.split('#### `needsInput(')[1] ?? '';
    expect(needsInputSection).toContain('agent:provenance');
    const subIssueSection = contract.split('#### `createSubIssue(')[1] ?? '';
    expect(subIssueSection).toContain('agent:provenance');
  });

  it('the contract documents a degradation for trackers that mangle HTML comments', () => {
    // A requirement with no stated degradation becomes a silently broken adapter.
    expect(contractFlat).toMatch(/mangles or strips HTML comments/);
    expect(contractFlat).toMatch(/posts the comment unsigned/);
    expect(contractFlat).toMatch(/never ships a mangled line/);
  });

  it('the contract took a MINOR bump for the new requirement', () => {
    expect(contract).toMatch(/\*\*Contract version: 1\.2\.0\*\*/);
    expect(contractFlat).toMatch(
      /\*\*1\.2\.0\*\* - outward writes carry the \*\*`agent:provenance` signature\*\*/
    );
    // Additive: an adapter on the older version still conforms.
    expect(contractFlat).toMatch(/an adapter declaring `1\.1\.0` still conforms/);
  });

  it('the adapter-authoring skill makes signing part of done', () => {
    expect(buildingAdaptersFlat).toMatch(/\*\*Outward writes are signed\.\*\*/);
    expect(buildingAdapters).toContain('agent:provenance');
    expect(buildingAdaptersFlat).toMatch(/preserves HTML comments byte-for-byte/);
  });

  it('the typed PMClient surface names the signature beside the marker', () => {
    expect(engineSpec).toMatch(/carries identity\.marker \+ the agent:provenance signature/);
  });

  it('the tracker-specific skill points at the canonical spec instead of restating it', () => {
    expect(adapterFlat).toMatch(/The canonical spec is \[`\.\.\/\.\.\/docs\/provenance\.md`\]/);
    expect(adapterFlat).toMatch(/do not redefine it here/i);
    // What stays there is tracker-specific verification, not the spec.
    expect(adapterFlat).toMatch(/byte-for-byte/);
    expect(adapterFlat).toMatch(/rich-text editor can strip the line/i);
  });
});

describe('agent provenance — the emitters reference the spec instead of redefining it', () => {
  it('VERIFY emits `agent:provenance` and names the legacy read-side name', () => {
    expect(verifying).toContain('agent:provenance');
    expect(verifyingFlat).toMatch(/legacy name/i);
    expect(verifying).toContain('flow:provenance');
    expect(verifyingFlat).toMatch(/docs\/provenance\.md/);
    expect(verifyingFlat).toMatch(/do not redefine it here/i);
  });

  it('VERIFY scopes `instanceId`/`resumeUrl` to DorkOS but NOT `surface`', () => {
    // `surface` selects the resume mechanism; the bare-cli branch needs it too.
    expect(verifyingFlat).toMatch(
      /`account`, `host`, `surface`, and — under DorkOS only — `instanceId` and `resumeUrl`/
    );
  });

  it('the PR template emits `agent:provenance` with `v`, and no local-only field', () => {
    expect(prTemplate).toMatch(/<!-- agent:provenance \{"v":1/);
    const emitted = prTemplate.match(/<!-- agent:provenance \{[^\n]*-->/)?.[0] ?? '';
    expect(emitted).not.toContain('worktree');
    expect(emitted).not.toContain('agentId');
    expect(emitted).not.toContain('branch');
    // And its guidance must not send an emitter to put them on the wire.
    expect(prTemplateFlat).toMatch(/stay in flow-state\.json/);
    expect(prTemplateFlat).toMatch(/never an email address/i);
    expect(prTemplateFlat).toMatch(/truncate `sessionId` to 8 chars, omit `resumeUrl`/);
  });

  it('NO shipped surface still emits the legacy marker literal', () => {
    // Mentioning `flow:provenance` as the legacy READ name is required; writing
    // `<!-- flow:provenance` is the emission this change retires.
    const roots = ['skills', 'commands', 'hooks', 'scripts', 'templates', 'docs', 'adapters'];
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

  it('marks the local-only rows and says they never go on the wire', () => {
    for (const field of LOCAL_ONLY_FIELDS) {
      expect(tableRow(executing, new RegExp(`\`${field}\``))).toMatch(/_\(local only\)_/);
    }
    expect(executingFlat).toMatch(/never go on the wire/);
  });

  it('gives per-harness derivation guidance for `account`, and says derive-never-guess', () => {
    expect(executing).toContain('CLAUDE_CONFIG_DIR');
    expect(executingFlat).toMatch(/\*\*Derive it, never guess\*\*/);
    expect(executingFlat).toMatch(/`codex` and `opencode`/);
    expect(executingFlat).toMatch(/profile \/ home directory/i);
    expect(executingFlat).toMatch(/cannot derive it, \*\*omit it\*\*/);
  });

  it('scopes `instanceId` to DorkOS runs but requires `surface` everywhere', () => {
    const instanceRow = tableRow(executing, /`instanceId`/);
    expect(flat(instanceRow)).toMatch(/when this run is under DorkOS/i);
    expect(flat(instanceRow)).toMatch(/Do not substitute the hostname/);
    const surfaceRow = tableRow(executing, /`surface`/);
    expect(flat(surfaceRow)).toMatch(/\*\*Always write it, on every surface\*\*/);
    expect(flat(surfaceRow)).toMatch(/not DorkOS-only/);
  });
});

describe('agent provenance — the reader routes on it', () => {
  it('resolves WHICH session is the originating one before routing', () => {
    expect(tending).toMatch(/^#### Routing a reply back to its originating session$/m);
    expect(tending).toMatch(/^##### Which session is "the originating session"$/m);
    expect(tendingFlat).toMatch(/runs \*\*before\*\* you act/);
  });

  it('gives a LOCAL run record precedence over a thread signature', () => {
    // BLOCKER: rule 3 already resumes from FlowRun.sessionId. Two authorities and
    // no precedence rule is a coin flip in the one place it must not be.
    expect(tendingFlat).toMatch(/A durable run record for this item is authoritative/);
    expect(tendingFlat).toMatch(/nothing in a thread overrides it/);
    expect(tendingFlat).toMatch(/Otherwise, read the thread's signature/);
    // Rule 3 itself must point at the fallback rather than contradicting it.
    expect(tendingFlat).toMatch(/\*\*When the item has no `FlowRun`\*\*/);
  });

  it('EXCLUDES this session own signature before taking the newest', () => {
    // BLOCKER: the loop signs its own replies, so "newest" is itself, and the
    // follow-up gets delivered straight back into this session.
    expect(tendingFlat).toMatch(/Take the newest signature that is NOT your own/);
    expect(tendingFlat).toMatch(
      /Compare each signature's `sessionId` against this session's own id and skip the matches/
    );
    expect(tendingFlat).toMatch(/self-delivery cycle/);
    // In shared-account mode the id is the ONLY discriminator.
    expect(tendingFlat).toMatch(/In shared-account mode this comparison is the only discriminator/);
  });

  it('documents path (a): same host + harness + resumable → deliver INTO that session', () => {
    // Row-scoped: `--resume <sessionId>` already appears in rule 3 above, so a
    // file-wide match for it would pass without any routing table at all.
    const rowA = tableRow(tending, /\*\*\(a\)\*\*/);
    expect(rowA).toContain('--resume <sessionId>');
    expect(rowA).toContain('POST /api/sessions/<id>/messages');
    expect(rowA).toMatch(/`instanceId` matching this install/);
    expect(flat(rowA)).toMatch(/Deliver the follow-up INTO that session/);
  });

  it('documents path (b): same host, session gone → fresh session seeded with the thread', () => {
    expect(flat(tableRow(tending, /\*\*\(b\)\*\*/))).toMatch(
      /fresh session seeded with the thread/i
    );
  });

  it('documents path (c): different host/instance → handle here and SAY so', () => {
    const rowC = flat(tableRow(tending, /\*\*\(c\)\*\*/));
    expect(rowC).toMatch(/different `host`/);
    expect(rowC).toMatch(/Handle it in the current session, and say so/);
    expect(rowC).toMatch(/recorded future step, not something to fake/i);
  });

  it('states the DEFAULT row, so the ladder cannot dead-end', () => {
    expect(tendingFlat).toMatch(/\*\*Anything that does not clearly match \(a\) is \(b\)\.\*\*/);
    expect(tendingFlat).toMatch(/\(b\) is always safe/);
  });

  it('says how to TEST resumability per harness, and where the local session set is', () => {
    expect(tendingFlat).toMatch(/Deciding "still resumable"/);
    expect(tending).toContain('~/.claude/projects/');
    expect(tending).toContain('claude --resume <sessionId>');
    expect(tendingFlat).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(tendingFlat).toMatch(/thread store and its sidecar session store/);
    // The prefix-match set is the LOCAL store, never ids seen in threads.
    expect(tendingFlat).toMatch(/Never match against ids you have only seen in tracker threads/);
    // And a failed probe is (b), not (a).
    expect(tendingFlat).toMatch(/if the probe itself fails, that is \(b\), not \(a\)/);
  });

  it('says where a reader gets its OWN instanceId, and what happens without one', () => {
    expect(tendingFlat).toMatch(/comes from the DorkOS install itself/);
    expect(tendingFlat).toMatch(/not from anything in the thread/);
    expect(tendingFlat).toMatch(/cannot determine its own `instanceId`.{0,120}falls to \(c\)/);
  });

  it('forbids silence about which path was taken — the tick report names it', () => {
    expect(tendingFlat).toMatch(/Silence about which path you took is not allowed/);
    expect(tendingFlat).toMatch(/tick report \*\*names the path\*\*/);
  });

  it('requires every reply this loop writes to be signed', () => {
    expect(tendingFlat).toMatch(/always carry the provenance signature/i);
    expect(tendingFlat).toMatch(/never an email address/i);
  });

  it('acknowledges the one product-specific mechanism it names, deliberately', () => {
    expect(tendingFlat).toMatch(/One product-specific name, deliberately/);
    expect(tendingFlat).toMatch(/it is not a tracker string/);
  });

  it('stays PM-agnostic: it points at the spec by path, never by tracker name', () => {
    expect(tendingFlat).toMatch(/`<flow-root>\/docs\/provenance\.md`/);
  });

  it('treats a human-stripped signature as absent, not as evidence', () => {
    expect(specFlat).toMatch(/Absence is normal, not evidence/);
    expect(specFlat).toMatch(/rich-text editor/);
    expect(specFlat).toMatch(/route as unsigned.{0,40}never "that session is dead"/);
    expect(tendingFlat).toMatch(/so does a signature a human stripped/);
  });
});

describe('agent provenance — the prose field set matches the on-disk schema', () => {
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

  it('accepts and preserves every documented wire field through a parse', () => {
    const parsed = FlowRunSchema.parse({
      ...baseRun,
      provenance: {
        v: 1,
        harness: 'claude-code',
        sessionId: 'session-1',
        account: 'example-account',
        host: 'example-host',
        surface: 'dorkos',
        instanceId: '2f9c1e6a-0000-4000-8000-abcdefabcdef',
        resumeUrl: 'https://example.invalid/session/session-1',
      },
    });

    for (const field of WIRE_FIELDS) {
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

  it('passes an UNKNOWN future field through instead of stripping it', () => {
    // The store is read-modify-write over a shared file: stripping means a v1
    // reader writing one run deletes a v2 field from every other run on disk.
    const parsed = FlowRunSchema.parse({
      ...baseRun,
      provenance: { harness: 'claude-code', futureSignatureField: 'kept' },
    });
    expect((parsed.provenance as Record<string, unknown>).futureSignatureField).toBe('kept');
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
