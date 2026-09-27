---
name: specifying-work
description: The /flow engine's SPECIFY stage — turns a validated ideation artifact into an implementation-ready specification, resolves its open decisions, and seeds draft ADRs. Use when work is ready to move from IDEATE to a frozen spec. PM-agnostic; all tracker I/O routes through the adapter skill.
---

# Specifying Work — the SPECIFY stage

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

SPECIFY turns a validated `specs/<slug>/01-ideation.md` into an implementation-ready
`02-specification.md`, resolves its open decisions, and seeds draft ADRs. Tracker writes
go through the adapter at `adapter.path`; branch only on a `WorkItem`'s `stateCategory`,
never a tracker's state name.

Fill the scaffolds, never inline a template: the spec from
[`templates/docs/specification.md`](../../templates/docs/specification.md), ADRs from
[`templates/docs/adr.md`](../../templates/docs/adr.md).

**Read first:** `AGENTS.md`, the ideation, `specs/manifest.json` and any existing
`specs/<slug>/` files, and the `decisions/` that may constrain the design.

## Steps

1. **Read the ideation:** intent and assumptions, codebase map, root cause (a bug),
   research, resolved decisions.
2. **Validate the problem from first principles.** Not real or not clear: stop and ask.
3. **Resolve open decisions** one question per turn, each with context, a recommended
   option and trade-offs. SPECIFY is an intent stage: when unsure, ask.
4. **Scope:** one spec or several, prerequisites first, what is deferred; map the
   end-to-end flow and blast radius. An ideation that already reads as a design is
   adapted, not re-derived.
5. **Write the spec**, every section filled; carry research forward verbatim where
   precision matters. No time or effort estimates.
6. **Resolve the spec's own open questions**, recorded as struck-through `(RESOLVED)`
   entries with Answer and Rationale. Re-read the file fresh each pass.
7. **Seed draft ADRs** for each decision signal (technology choice, pattern, trade-off,
   rejected alternative, deliberate exclusion): `status: draft`, `extractedFrom: <slug>`,
   with a `decisions/` manifest entry when one exists. Skip if already extracted.
8. **Manifest:** set `specs/manifest.json`'s `<slug>` entry to `specified`.

Do the validation and ADR extraction inline; never depend on slash-command chaining or a
background-agent API.

## Tracker

- On entry: `flow stage <id> specify --checkpoint-file <f>` (Done, Next, Open questions,
  Next command).
- On completion: a breadcrumb `comment` (spec created at `specs/<slug>/02-specification.md`,
  next DECOMPOSE). Untracked or no adapter: skip.

Next: `/flow:decompose`.
