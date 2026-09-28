---
name: building-adapters
description: Guided procedure for generating and verifying a concrete /flow tracker adapter that conforms to the adapter contract. Use when building, porting, or scaffolding a tracker adapter for a new tracker (Jira, GitHub Issues, or another), or when /flow:init must produce one for an adopter. Teaches the generate-and-verify loop, maps the tracker onto the WorkItem model and the 16 required capability verbs (plus any optional ones), then loops on validate-adapter.ts until the conformance invariants pass.
---

# building-adapters - generate a conforming `/flow` tracker adapter

> **Where `<flow-root>` is:** the folder that holds `skills/`, found from this file's `realpath` (it may be reached through a `flow__*` skill link).

Produce one tracker adapter: the only tracker-aware part of flow. **Generate, then verify.** An adapter is done when `validate-adapter.ts` returns green on a representative fixture, not when it looks right.

**The contract is [`<flow-root>/adapters/SPEC.md`](../../adapters/SPEC.md).** Read it first and keep it open; where this skill and the SPEC disagree, the SPEC wins. It defines the `WorkItem` model (section 2), the 16 required verbs and the optional ones (section 3), the code realization (section 3, "The code realization"), the invariants `INV-1 .. INV-5` (section 4) and versioning (section 5).

Use this to build an adapter that does not exist yet. To operate an existing one, read that adapter instead.

## The procedure

```
1 READ the SPEC, pick a starting point
2 MAP the tracker to the model
3 GENERATE the adapter into the project
4 VERIFY with validate-adapter.ts --> ok? done
      ^------ fix the failed invariant ---'
```

Expect to loop between 3 and 4.

### 1. Read the SPEC, pick a starting point

- Read `adapters/SPEC.md` end to end.
- Same access shape as a reference adapter under [`<flow-root>/adapters/reference/`](../../adapters/reference/): copy its structure. `linear-mcp` is the in-session MCP path; `linear-composio` is the external-CLI path (a CLI or bare REST client looks like this one). The shipped `skills/linear-adapter/` shows a skill with code beside it.
- Neither fits (Jira, GitHub Issues): start from scratch, keeping the same shape.
- **Never copy tracker strings across.** Reuse the structure and the normalization discipline, never another tracker's API names.

### 2. Map the tracker to the model

Fill in [`references/mapping-worksheet.md`](references/mapping-worksheet.md). The rules are SPEC section 2; the traps:

- Every state maps to exactly one of `backlog | unstarted | started | completed | canceled`, by **category**, never display name. A holding or untriaged state is `backlog`. Never invent a sixth.
- Re-namespace every label into `agent/*`, `stage/*`, `type/*` (or another `family/leaf`). A bare `ready` silently fails to match.
- `priority` and `size` are native fields, never labels. A missing optional is `undefined`, never a made-up value.
- Relations come from the typed graph only, never from prose.

### 3. Generate the adapter

Write it into the project, never the plugin: `<committedDir>/adapters/<tracker>/SKILL.md`, where `committedDir` is what `node --experimental-strip-types "<flow-root>/scripts/config-files.ts"` prints (`.agents/flow/`). It is committed; a plugin update would erase it. Flow reads it by `adapter.path`, never as a harness skill. It holds:

1. Frontmatter `name: <tracker>-adapter` and a description saying every `/flow` stage and the loop reach the tracker through it. Under it, a note that `<flow-root>` means `flowRoot` from `config-files.ts`, not a path beside the adapter.
2. The one rule, up top: all `/flow` tracker I/O lives here, and no other flow file names this tracker's API strings.
3. The access path(s) and auth. Credentials and team coordinates come from `config.local.json`, policy from `config.json`, both found by running `config-files.ts` (`committed`, `local`).
4. The `WorkItem` shape with your step 2 mappings inlined.
5. Every required verb bound to its tracker call, with durability and degradation (SPEC section 3). A read that cannot reach the tracker throws, never returns `[]`. A failed write fails loudly, never reports success.
6. A line per optional verb: **supported** or **not supported**. Silence reads as an oversight.
7. The contract version it targets (`CONTRACT_VERSION`, or a manifest field).

Optionally, `adapter.ts` beside it, so `flow claim|stage|done|create|snapshot` run as code (SPEC "The code realization"). Without it those verbs exit 3 and the skill still works.

### 4. Verify (the gate)

Build a fixture of the normalized `WorkItem`s your reads return: at least one item per state category, a ready and a not-ready item, one relation that resolves in the set and one that is closed or outside it. Then:

```bash
node --experimental-strip-types "<flow-root>/scripts/validate-adapter.ts" --fixture <fixture.json>
```

(Node before 22.6: `tsx "<flow-root>/scripts/validate-adapter.ts" --fixture <fixture.json>`.)

- It prints `{ "ok": true|false, "failures": [ { "invariant", "detail" } ] }`. Exit `0` is pass; gate on the exit code.
- Fix the mapping that produced each failure, re-run, repeat until `ok`.
- `getEligibleWork` and `getProjectWork` return **candidates**, not only `agent/ready` items: pre-filtering breaks starvation detection (INV-5).
- Per-invariant causes, fixtures and negative cases: [`references/conformance-harness.md`](references/conformance-harness.md).

## Definition of done

- [ ] SPEC read; starting point chosen.
- [ ] State table complete: five categories only, holding state `backlog`.
- [ ] Label map complete: no bare leaves.
- [ ] Native fields mapped; missing optionals `undefined`.
- [ ] Every required verb implemented, with durability and degradation; reads throw when unreachable, writes never fake success.
- [ ] **Outward writes are signed.** `comment`, the `needsInput` question and the description `createSubIssue` writes end with the `agent:provenance` line ([`<flow-root>/docs/provenance.md`](../../docs/provenance.md)) beside the identity marker. The adapter says whether its tracker preserves HTML comments byte-for-byte; if not, it posts unsigned rather than a mangled line.
- [ ] Every optional verb declared.
- [ ] No tracker API string outside the adapter.
- [ ] Contract version declared: a new adapter the SPEC's current one; an existing one may keep the version it passed.
- [ ] `validate-adapter.ts --fixture <fixture>` returns `ok: true`, exit `0`.
