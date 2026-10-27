# A refused tool in a scheduled run

`<flow-root>` is two folders above this file's `realpath`. `flow <verb>` means
`node --experimental-strip-types "<flow-root>/scripts/flow.ts" <verb>`.

Every scheduled flow skill follows this. Nobody is there to approve a tool during a scheduled run,
so a tool that asks is refused on the spot. **A refused tool never ends the run quietly, and never
as done.** The first time a tool call comes back refused, denied or waiting for an approval:

1. Don't retry it, and don't use another tool to do the same job. Start no new step.
2. If you were working on an item, park it with one question, the way flow always parks. The
   question is "This run was refused `<tool>`. Allow it for this schedule, or should a person do
   this step?". In triage that is `flow triage <id> --park '<question>'`; anywhere else it is
   `flow ask <id>` with that question, the choices "Allow it" and "A person does it", `--pick 2`,
   and the blocked step as `--why`. Your pick is never "Allow it", and if flow says to go ahead
   with your pick, don't: only a person can allow a tool. Parking writes to the tracker, so it may
   be refused too. Either way, name the item in the report and go on to step 3.
3. Run `flow note --kind friction --skill <the scheduled skill's name> "refused <tool> at step <n>"`.
4. End the run. The report's first line is exactly
   `FLOW RUN NEEDS YOU: refused <tool> at step <n>`, followed by what was left undone and every
   item you parked. Never call the run done, finished or complete.

When that question comes back "A person does it", whoever settled it (a deadline included), never
do the step yourself. If the item is claimed (`agent/claimed` or a run record), let go of it with
`flow release <id> --to none --json`, so no later run picks it up. Then hand it to a person
(`assignToHuman`) and stop. If the release is refused, still hand it over and name it in the
report, and never park it again.

Never raise the schedule's `permissions` to get past a refusal. The read tools each schedule needs
are under `metadata.flow-needs` in its `SKILL.md`, and `<flow-root>/docs/refused-tools.mdx` says how
a person allows them.

When a person is watching and declines a tool, that is their answer: follow it instead.
