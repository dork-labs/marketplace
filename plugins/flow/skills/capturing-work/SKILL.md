---
name: capturing-work
description: The /flow engine's CAPTURE stage — quick, low-commitment intake of a new piece of work into the tracker as an idea, without doing full triage or evaluation. Use when the goal is to get a thought captured cleanly so it survives, not to assess, classify deeply, or plan it. Generalizes the legacy /linear:idea capture flow (retired in spec #257); PM-agnostic.
---

# Capturing Work — the CAPTURE stage

> **What this is.** The first stage on the `/flow` spine
> (`CAPTURE → TRIAGE → IDEATE → …`, spec §1). CAPTURE turns a raw thought into a
> durable, low-commitment work item so it stops living in the operator's head and
> starts living in the tracker. It deliberately does **not** evaluate, classify
> beyond "this is an idea," prioritize, or plan — that is TRIAGE's job
> (`triaging-work`).
>
> A thin `/flow:capture` command and a PM-driven transition are two
> **triggers** for this one skill (spec §1).

## The one rule: every tracker write goes through `flow`

CAPTURE never names a tracker API or tool. Its one write is `flow create`
(`flow` means `node --experimental-strip-types "<flow-root>/scripts/flow.ts"`),
which signs the description and lands the item in the tracker's intake state.

## Process

1. **Take the input as the work description.** The trigger supplies it (the
   `/flow:capture` argument, or the PM transition's source item). If the input is
   a file path, read the file and use its contents as the description, noting the
   source path.
2. **Capture, don't evaluate.** If the input is too thin to make a meaningful
   item, ask for the **single** missing detail and stop — do not expand scope,
   classify deeply, or research. (CAPTURE is an intent stage: when genuinely
   unsure, lean toward asking — spec §5 stage bias.)
3. **Create the item:**

   ```bash
   flow create --title "<title>" --description "<text>" \
     --label type/idea --label origin/human --key <key> --json
   ```

   - a concise, actionable, imperative-voice **title**;
   - the input as the description, with its source path if it came from a file
     (long text goes in `--description-file <file>`);
   - `type/idea` always: CAPTURE is the lowest-commitment entry point, and TRIAGE
     re-classifies it. `origin/human`: the operator had the thought;
   - `--key`: a short slug of the thought, so a retried capture returns the first
     item (`created: false`) instead of filing it twice;
   - no priority or size: commitment and sizing come at TRIAGE, and no priority
     sorts last in dispatch.

4. **Report** the item as `<identifier> - <title>` and say it awaits triage.

## Guardrails

- **Do not triage or evaluate here.** No alignment check, feasibility judgment,
  duplication search, prioritization, or planning. If the operator actually wants
  classification or routing, this is the wrong stage — use `triaging-work` (the
  TRIAGE stage).
- **Do not expand scope** beyond what the operator described. One thought in → one
  idea captured.
- **Reversible + confident → proceed silently** (spec §5 calibration ladder):
  capturing a single idea is cheap to undo, so don't over-ask. Ask only for the
  one missing detail that blocks creating a meaningful item.
- **If `flow create` fails** (exit 3: this tracker cannot create items through flow; exit 4:
  the tracker is unreachable or lacks a label), surface its message plainly and
  stop. Never fabricate a capture, and never reach the tracker another way.

## Stage handoff

CAPTURE's only successor is TRIAGE. A captured idea sits in the intake/backlog
state until `triaging-work` evaluates it (accept / reject / needs-research /
needs-refinement) and routes it onward. CAPTURE never skips ahead to IDEATE,
SPECIFY, or EXECUTE.
