---
name: capturing-work
description: The /flow engine's CAPTURE stage — quick intake of a new piece of work into the tracker as an idea, filed already triaged (a MoSCoW priority, a size, a project, proof and a done-when, checked for duplicates) but not routed or readied. Use when the goal is to get a thought captured cleanly so it survives, not to route, research, or plan it. Generalizes the legacy /linear:idea capture flow (retired in spec #257); PM-agnostic.
---

# Capturing Work — the CAPTURE stage

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

CAPTURE turns a raw thought into a work item that is triaged as it is filed: a
type, a MoSCoW priority, a size, a project, proof and a done-when, and no duplicate.
It does not plan or ready the item: that is TRIAGE (`triaging-work`). Its one write
is `flow create`, which refuses an item missing any of those, signs the description
and lands it in the tracker's intake state.

## Process

1. **Take the input as the work description.** The trigger supplies it (the
   `/flow:capture` argument, or the PM transition's source item). If the input is
   a file path, read the file and use its contents as the description, noting the
   source path.
2. **Capture, don't plan.** If the input is too thin to fill the fields below,
   ask for the **single** missing detail and stop — do not expand scope or
   research. (CAPTURE is an intent stage: when genuinely unsure, lean toward
   asking — spec §5 stage bias.)
3. **Bucket, size and place it** by _The MoSCoW buckets_ in
   `<flow-root>/skills/triaging-work/SKILL.md`, or the repo's own rubric where its
   agent instructions name one. A Won't is not filed: say so and stop. The size is on
   the tracker's own estimate scale. The project is one of the team's; if none fits,
   use the default or maintenance project the repo's rubric names, else ask.
4. **Create the item.** Never add `agent/*` or `stage/*` labels: TRIAGE decides.

   ```bash
   flow create --title '<title>' --description-file .dork/flow/tmp/<key>.md \
     --label type/idea --label origin/human --priority <1-4> --size <n> \
     --for-project '<project>' --key <key> --json
   ```

   - a concise, actionable, imperative-voice **title**, in single quotes, with
     no single quote inside it;
   - the description in `.dork/flow/tmp/<key>.md` (flow deletes it once the item
     is filed): the input, with its source path if it came from a file, then a
     `## Proof` section (what was seen or asked: a log line, `file:line`, a
     failing command, steps, or the operator's own words) and a `## Done when`
     section (one to three lines you can check), then one line saying what you
     searched for duplicates (`Searched: <words>`). A one-line
     `--description '<text>'` cannot hold all that: use the file;
   - `type/idea` always: TRIAGE re-classifies it. `origin/human`: the operator
     had the thought;
   - `--key`: a short, specific slug, so a retried capture returns the first
     item instead of filing twice.

   `flow create` names every problem in one message (exit 2): fix them and run it
   again. **A `nearMatches` list in its JSON** names open items with a near-matching
   title: read each. The same work: comment on it with what is new (`flow comment`)
   and report that instead of filing. Different work: run again with
   `--not-duplicate-of <ids>` naming every one it listed.

5. **Report** `<identifier> - <title>`, its bucket, and that it awaits triage.
   When `created` is false, say it was already captured and show that item's
   `title`; if it is a different idea, capture again with a more specific key.

## Guardrails

- **Do not triage here**, and do not expand scope: one thought in, one idea out.
- Capturing is cheap to undo: ask only for the one missing detail that blocks a
  meaningful item.
- **Small follow-ups from one review or one PR are one item** with a checklist,
  not one item each.
- **If `flow create` fails** (exit 3: this tracker cannot create items through
  flow; exit 4: the tracker is unreachable or lacks a label), surface its
  message plainly and stop. Never fabricate a capture, and never reach the tracker another way.
