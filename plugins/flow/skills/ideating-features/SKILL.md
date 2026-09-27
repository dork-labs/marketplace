---
name: ideating-features
description: Turns a feature brief, rough notes, or an existing partial design into a structured ideation artifact and next-step plan. Use when the user wants to explore a feature or shape rough requirements into a structured ideation artifact.
---

# Ideating Features — the IDEATE stage

`<flow-root>` is two folders above this file's `realpath`.

IDEATE turns a brief, rough notes or a partial design into a structured ideation
document in the shape of `<flow-root>/templates/docs/ideation.md`. Next is SPECIFY
(`specifying-work`). Tracker writes go through the adapter at `adapter.path`.

**Read first:** the project's agent guide (`AGENTS.md` or `CLAUDE.md`); with the spec
system, `specs/manifest.json` and any `specs/<slug>/` the user names.

## Steps

1. **Read any source material first** (a file, notes, a partial spec). Keep its concrete
   constraints, numbers and examples; never paraphrase them away.
2. **Classify its maturity:** rough notes → ideate; a partial spec → fast-track to
   SPECIFY; a detailed design → adapt it, do not re-ideate.
3. **Pick a URL-safe slug** consistent with `specs/`.
4. **Intent and assumptions:** restate the brief, list the assumptions, draw the scope.
5. **Discovery:** read the relevant code; research only when needed. Parallel workers
   only when the user asks; otherwise work sequentially.
6. **Decide:** ask bounded questions only for real ambiguity; show trade-offs when
   approaches really differ.
7. **Write it:** intent, sources, assumptions and out-of-scope, codebase findings,
   trade-offs, the recommended direction, and the next step (keep ideating, specify,
   or adapt straight into a spec).

Never depend on slash-command chaining or a background-agent API.
