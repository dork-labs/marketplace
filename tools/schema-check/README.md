# schema-check

Repo-wide CI gate. It checks two things about everything in `plugins/`:

1. **Every `SKILL.md` still says what its author meant.** The frontmatter has to
   parse, and a `schedule:` block has to parse _strictly_ — including its setting
   names, not just their values.
2. **Every manifest still validates.** `.claude-plugin/marketplace.json` (against
   the DorkOS schema _and_ the Claude Code standard one), `.claude-plugin/dorkos.json`,
   and any plugin's `.dork/manifest.json`.

Run it:

```bash
cd tools/schema-check
npm ci
npm run check   # the gate
npm test        # its own tests
```

## Why this exists

DorkOS is forgiving about a broken `schedule:` block on purpose. A skill whose
block will not parse still installs and still works as a plain skill; only the
schedule is dropped, and only the tasks screen complains. That is the right trade
for a file somebody is editing in their own vault.

For a _published_ package it is the wrong one. It means a one-character typo —
`permissions: acceptEditz` — turns a scheduled task into an ordinary skill, ships,
and nothing anywhere goes red. That is DOR-1519, found while reviewing PR #22.

So this gate parses the same blocks the same way DorkOS does, and then refuses
what DorkOS would have shrugged off.

Three failure modes, three answers:

| What breaks                                  | What catches it                                        |
| -------------------------------------------- | ------------------------------------------------------ |
| A bad **value** (`permissions: acceptEditz`) | Strict `ScheduleBlockSchema` parse                     |
| A bad **key** (`permissionz: acceptEdits`)   | Comparison against the schema's own key set            |
| The **whole block** gone, or `schedul:`      | The list in `src/scheduled-skills.ts`                  |

The third one needs the list because there is nothing left in the file to
complain about. The list is kept honest in both directions: a skill on it that
stops being schedulable is an error, and a skill with a schedule block that is
_not_ on it is also an error.

## Where the schemas come from

`@dorkos/skills` and `@dorkos/marketplace` are private workspace packages inside
the DorkOS monorepo. They are not published to npm, so there is nothing to
install. The `dorkos` CLI _is_ published, but its `package validate` command
deliberately reads bundled SKILL.md files with a permissive schema
(`PermissiveSkillFrontmatterSchema = z.unknown()`), so it cannot answer this
question either.

The dorkos repo is public, though. `scripts/fetch-upstream.ts` downloads the
schema modules straight out of it — at the immutable commit pinned in
`upstream.json` — into the gitignored `.upstream/` directory, keeping their
original paths so their relative imports still resolve. The two bare `@dorkos/*`
specifiers those files use are mapped by `paths` in `tsconfig.json` (and derived
from there by `vitest.config.ts`, which is why that file has to stay comment-free
JSON).

**Nothing here is a copy of a DorkOS schema.** This repo can be wrong about which
_commit_ of the schema it validates against; it can never be wrong about what
that schema says. The residual risk is a stale pin: if DorkOS renames a field,
this gate keeps happily accepting the old spelling until somebody bumps
`upstream.json`. That is the same risk a pinned npm dependency carries, and the
bump is a one-line diff.

### Bumping the pin

1. Put the new full 40-character SHA in `upstream.json` (a branch name is
   rejected — it would make the gate enforce something different every run).
2. `npm test`. `tests/upstream-pin.test.ts` walks the real imports of the pinned
   files and fails if `files` is no longer their exact closure, so a module that
   moved or gained an import tells you what to add.
3. `npm run check` against the real `plugins/`.

## What it does not check

- Command files (`commands/**/*.md`). Only `SKILL.md`.
- A plugin's `.claude-plugin/plugin.json` — DorkOS ships no schema for it.
- Whether a plugin _has_ a `.dork/manifest.json`. Most of the seed packages
  predate it and install from `marketplace.json` alone; a manifest that is there
  gets validated, a missing one is not an error.
- Cron semantics. DorkOS itself only shape-checks `cron` at this layer; whether
  the expression means anything is croner's question, answered on the server.
