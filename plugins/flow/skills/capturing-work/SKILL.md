---
name: capturing-work
description: The /flow engine's CAPTURE stage — quick, low-commitment intake of a new piece of work into the tracker as an idea, without doing full triage or evaluation. Use when the goal is to get a thought captured cleanly so it survives, not to assess, classify deeply, or plan it. Generalizes the legacy /linear:idea capture flow (retired in spec #257); PM-agnostic.
---

# Capturing Work — the CAPTURE stage

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

CAPTURE turns a raw thought into a low-commitment work item. It does not evaluate,
prioritize or plan: that is TRIAGE (`triaging-work`). Its one write is `flow create`,
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
   flow create --title '<title>' --description '<text>' \
     --label type/idea --label origin/human --key <key> --json
   ```

   - a concise, actionable, imperative-voice **title**, in single quotes, with
     no single quote inside it;
   - the input as the description, with its source path if it came from a file.
     Only one plain line goes in `--description '<text>'`. Text with more lines,
     or any of `` ` `` `$` `'` `"` `\`, breaks a shell argument: write it to
     `.dork/flow/tmp/<key>.md` in the project and pass `--description-file`
     instead (flow deletes that file once the item is filed);
   - `type/idea` always: TRIAGE re-classifies it. `origin/human`: the operator
     had the thought;
   - `--key`: a short, specific slug, so a retried capture returns the first
     item instead of filing twice;
   - no priority or size: those come at TRIAGE.

4. **Report** `<identifier> - <title>` and that it awaits triage. When
   `created` is false, say it was already captured and show that item's
   `title`; if it is a different idea, capture again with a more specific key.

## Guardrails

- **Do not triage here**, and do not expand scope: one thought in, one idea out.
- Capturing is cheap to undo: ask only for the one missing detail that blocks a
  meaningful item.
- **If `flow create` fails** (exit 3: this tracker cannot create items through
  flow; exit 4: the tracker is unreachable or lacks a label), surface its
  message plainly and stop. Never fabricate a capture, and never reach the tracker another way.
