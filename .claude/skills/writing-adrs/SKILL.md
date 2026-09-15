---
name: writing-adrs
description: Guides writing concise, effective Architecture Decision Records. Use when creating ADRs, extracting decisions from specs, or reviewing ADR quality.
---

# Writing Architecture Decision Records

## Overview

Architecture Decision Records (ADRs) capture significant technical decisions in a concise, standardized format. They answer "why did we do this?" for future developers and AI agents.

**Where ADRs live.** This marketplace repo has no `decisions/` directory. Decisions about the contracts it consumes (the `dorkos.json` sidecar, `.dork/manifest.json`, `SKILL.md` `schedule:` blocks, the marketplace schema) belong to the DorkOS app repo, which owns those schemas and keeps its ADRs in `decisions/` there. For a decision local to this repo (for example, a flow plugin design choice), ask the user where it should be recorded before creating a new directory; `plugins/flow/docs/` is the likely home for flow.

## When to Write an ADR

Write an ADR when a decision:

- **Chooses between alternatives** — "We picked X over Y because..."
- **Adopts a pattern or technology** — New library, architecture pattern, data model
- **Has lasting consequences** — Affects how future features are built
- **Would surprise a new team member** — Non-obvious choices that need explanation

## When NOT to Write an ADR

Skip ADRs for:

- **Trivial implementation details** — Variable naming, file placement within an established structure
- **Obvious choices** — Using TypeScript in a TypeScript project
- **Temporary decisions** — Workarounds that will be replaced soon
- **Single-feature scope** — Decisions that only affect one spec with no project-wide impact

## Writing Guidelines

### Context (2-5 sentences)

Focus on the **problem**, not the solution. What situation existed? What forces were at play?

- **Good**: "The flow CI check is required on `main`. A required check whose workflow has a `paths:` filter never reports on PRs outside those paths, so those PRs wait forever on a check that never runs."
- **Bad**: "We needed better CI." (Too vague)
- **Bad**: A full page of background. (Too long — that belongs in the spec)

### Decision (2-5 sentences)

State what was decided in **active voice**. Start with "We will..."

- **Good**: "We will run the flow workflow on every pull request with no `paths:` filter. The job costs about 25 seconds. If a filter is ever re-added, the check must be un-required first."
- **Bad**: "The path filter was removed." (Passive, vague)

### Consequences

List concrete positives and negatives. Every decision has trade-offs — if you can't list a negative, think harder.

- **Positive**: Real benefits the project gains
- **Negative**: Real costs, complexity, or limitations introduced

## Decision Signals in Specs

When scanning specs for ADR candidates, look for:

| Signal                         | Example                                  |
| ------------------------------ | ---------------------------------------- |
| "We chose X over Y"            | Technology or library selection          |
| "The recommended approach"     | Pattern adoption after comparing options |
| "Trade-offs" section           | Explicit trade-off analysis              |
| "Architecture" or "Design"     | Structural decisions                     |
| "We will not" / "Out of scope" | Deliberate exclusions with rationale     |

## ADR Lifecycle

| Status       | Meaning                                                |
| ------------ | ------------------------------------------------------ |
| `proposed`   | Significant decision recorded, not yet committed       |
| `accepted`   | Active decision guiding implementation                 |
| `deprecated` | No longer relevant (project evolved past it)           |
| `superseded` | Replaced by a newer ADR (link via `superseded-by`)     |
| `archived`   | Determined trivial or historical                       |

There is no `draft` status: significance is judged **at extraction time**. Decisions meeting 2+ "When to Write" criteria are written as `proposed` (or `accepted` if the work already shipped); the rest are never written as files.

### Partial supersession: the `amends` relation

When a new ADR reverses **part** of an older one, the older ADR **stays `accepted`**. There is no `superseded-in-part` status, and inventing one is not the answer: a status is an instruction about whether to rely on the document, and marking a mostly-live ADR terminal tells every future reader to stop reading something they still need.

So:

1. **Parent keeps `status: accepted`** and no `superseded-by`.
2. **Parent's Status section names exactly what is retired:** quote the clause, list any Consequences bullets that fall with it, then state what still governs.
3. **Child carries `amends: <parent-id>`** in its frontmatter (a list when it amends several parents), and says in its own Status section which clause it replaces. That field is the only machine-readable link, so it is not optional.

Reserve `status: superseded` + a `supersedes` link for a **whole** ADR being replaced. A `supersedes` link must point at a `superseded` ADR, and an `amends` link must point at a live one — a violation means either the wrong relation or an unflipped status.

### Keeping accepted ADRs honest

`accepted` is a claim about the present, and nothing re-checks it on its own. When you touch code an ADR governs, check that the ADR still describes it. If it does not, record the change with a new ADR or an amendment note; never rewrite the old ADR's prose, because the history is the point.

**Acceptance criteria:** A proposed ADR is ready for acceptance when:

1. The work it describes has been implemented
2. The pattern/technology/convention described in the ADR is present in the codebase
3. The decision is still actively guiding development (not just historical)

### Extraction

ADRs are seeded by the `/flow:specify` stage (when the flow plugin is loaded), which applies the significance rubric immediately — only decisions that clear it become ADR files.

## Common Pitfalls

- **Too long** — ADRs are not specs. Keep each section to 2-5 sentences.
- **Missing negative consequences** — Every decision has costs. Be honest.
- **Vague context** — "We needed a better solution" tells nothing. What was broken?
- **Solution in context** — Context describes the problem, not the answer.
- **No spec link** — If a spec or issue drove this decision, always link it.
- **Wrong repo** — A decision about a DorkOS-owned schema belongs in the DorkOS app repo, not here.
- **Private details** — This repo is public. No prices, plan names, hostnames, or anything from private repos.

## File Conventions

- **Filename**: `<id>-kebab-case-title.md`, where `<id>` is a timestamp `YYMMDD-HHMMSS` (coordination-free, so parallel agents never collide on a number)
- **Frontmatter**: `status`, and when relevant `supersedes` / `superseded-by` (full replacement) or `amends` (partial — id or list)
- **Sections**: Status, Context, Decision, Consequences (Positive / Negative)
