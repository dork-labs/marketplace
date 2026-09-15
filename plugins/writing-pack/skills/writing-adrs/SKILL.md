---
name: writing-adrs
description: Guides writing concise, effective Architecture Decision Records. Use when creating ADRs, extracting decisions from specs, or reviewing ADR quality.
---

# Writing Architecture Decision Records

## Overview

Architecture Decision Records (ADRs) capture significant technical decisions in a concise, standardized format. They answer "why did we do this?" for future developers and AI agents.

## When to Write an ADR

Write an ADR when a decision:

- **Chooses between alternatives** — "We picked X over Y because..."
- **Adopts a pattern or technology** — New library, architecture pattern, data model
- **Has lasting consequences** — Affects how future features are built
- **Would surprise a new team member** — Non-obvious choices that need explanation

A decision that meets two or more of these is worth a record. One that meets none is not.

## When NOT to Write an ADR

Skip ADRs for:

- **Trivial implementation details** — Variable naming, file placement within an established structure
- **Obvious choices** — Using TypeScript in a TypeScript project
- **Temporary decisions** — Workarounds that will be replaced soon
- **Single-feature scope** — Decisions that only affect one spec with no project-wide impact

## Writing Guidelines

### Context (2-5 sentences)

Focus on the **problem**, not the solution. What situation existed? What forces were at play?

- **Good**: "The app runs as both a standalone web app and an editor plugin. The plugin cannot make HTTP requests to localhost, so the client needs a way to reach the server that works in both environments."
- **Bad**: "We needed an architecture." (Too vague)
- **Bad**: A full page of background. (Too long — that belongs in the spec)

### Decision (2-5 sentences)

State what was decided in **active voice**. Start with "We will..."

- **Good**: "We will use a Transport interface that abstracts the communication layer. HttpTransport handles standalone mode via REST/SSE. DirectTransport handles plugin mode via in-process function calls."
- **Bad**: "The transport pattern was implemented." (Passive, vague)

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

Judge significance when you extract. A decision that clears the bar above becomes a record; the rest never become files. Avoid a "draft" pile that nobody promotes.

## ADR Lifecycle

| Status       | Meaning                                            |
| ------------ | -------------------------------------------------- |
| `proposed`   | Significant decision recorded, not yet committed   |
| `accepted`   | Active decision guiding implementation             |
| `deprecated` | No longer relevant (project evolved past it)       |
| `superseded` | Replaced by a newer ADR (link to the replacement)  |
| `archived`   | Determined trivial or historical                   |

A proposed ADR is ready to accept when the work it describes has shipped, the pattern is present in the code, and it is still guiding development.

**`accepted` is a claim about the present.** Code drifts. Re-check accepted ADRs against the codebase from time to time, and correct history with new records and status changes, never by rewriting an old ADR's prose.

### Partial replacement: `amends`

When a new ADR reverses **part** of an older one, the older ADR **stays `accepted`**. Do not invent a `superseded-in-part` status. A status tells readers whether to rely on the document, and marking a mostly-live ADR as replaced tells them to stop reading something they still need.

So:

1. **The older ADR keeps `status: accepted`.**
2. **Its Status section names exactly what is retired:** quote the clause, list any consequences that fall with it, then say what still governs.
3. **The newer ADR records `amends: <older-id>`** (a list if it amends several) and says which clause it replaces.

Reserve `superseded` plus a `supersedes` link for a **whole** ADR being replaced.

## Common Pitfalls

- **Too long** — ADRs are not specs. Keep each section to 2-5 sentences.
- **Missing negative consequences** — Every decision has costs. Be honest.
- **Vague context** — "We needed a better solution" tells nothing. What was broken?
- **Solution in context** — Context describes the problem, not the answer.
- **No spec link** — If a spec drove this decision, always link it.

## Adapt for your repo

The guidance above is the same everywhere. These details are yours to fill in:

- **Location.** Where ADRs live (a common choice is `decisions/` or `docs/adr/`), and the file name pattern, such as `<id>-kebab-case-title.md`.
- **IDs.** Sequential numbers are simple but collide when several agents write at once. A timestamp like `YYMMDD-HHMMSS` needs no coordination.
- **Template.** Point to your template file, if you keep one.
- **Index.** If you keep a manifest or index of ADRs, say which fields it holds (status, relations, last-verified date) and that it must be updated with every new or changed ADR.
- **Commands and checks.** Name any commands that create, review or audit ADRs, and any script that checks the index against the files.
- **Where decisions come from.** If your specs or planning workflow seed ADRs (for example a spec stage in your workflow tool), say so, so extraction happens in one place.
- **Public repos.** If ADRs are public but some decisions involve private details, say what must stay out.
