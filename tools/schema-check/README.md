# schema-check

Repo-wide CI gate. It checks three things about everything in `plugins/`:

1. **Every `SKILL.md` still says what its author meant.** Not just "does it
   parse" — every line the author wrote has to survive the parse still meaning
   what they wrote, setting names included.
2. **Every manifest still validates.** `.claude-plugin/marketplace.json` (against
   the DorkOS schema _and_ the Claude Code standard one), `.claude-plugin/dorkos.json`,
   and any plugin's `.dork/manifest.json`.
3. **Every package states one version.** See [Version agreement](#version-agreement).

Run it:

```bash
cd tools/schema-check
npm ci
npm run check   # the gate
npm test        # its own tests
npm run check:bump -- <base> <head>   # every changed package raised its version
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

**A passing `safeParse` is not the bar, and this is the part worth understanding
before changing anything here.** DorkOS frontmatter is built to absorb bad input:
unknown keys are dropped, and most optional fields end in `.catch(...)`, which
means zod never reports them as invalid — it swallows the value, substitutes a
fallback, and returns success. Five of the twelve settings in a `schedule:` block
work that way (`enabled`, `sticky`, `runtime`, `model`, `effort`), and so does
most of the top-level frontmatter. `enabled` is the one that bites: an unreadable
value falls back to **true**, so `enabled: maybe` arms a schedule its author was
trying to switch off.

Four failure modes, four answers:

| What breaks                                      | What catches it                                          |
| ------------------------------------------------ | -------------------------------------------------------- |
| A rejected **value** (`permissions: acceptEditz`) | `ScheduleBlockSchema.safeParse` fails                    |
| A **swallowed** value (`enabled: maybe`)          | Comparing what was written against what the schema kept  |
| A bad **key** (`permissionz:`, `modle:`)          | Comparison against the schema's own key set              |
| The **whole block** gone, or `schedul:`           | The list in `src/scheduled-skills.ts`                    |

The second answer is generic on purpose: it compares the raw mapping to the
parsed one key by key, so it needs no list of which fields degrade and cannot
fall behind a schema change. Values are compared through upstream's own
`coerceYamlBoolean`, so the YAML 1.1 words DorkOS deliberately understands
(`enabled: no`, `sticky: on`, `enabled: 0`) stay green — this gate is a stricter
question, never a second opinion about what DorkOS accepts. The one field left
out is `schedule` itself, the only one carrying a `.transform()`; it gets the
same comparison one level down, against its own schema.

The fourth needs the list because there is nothing left in the file to complain
about. The list is kept honest in both directions: a skill on it that stops being
schedulable is an error, and a skill with a schedule block that is _not_ on it is
also an error.

## Version agreement

A package can state its version in up to three files:

- `.dork/manifest.json`, which DorkOS reads,
- `.claude-plugin/plugin.json`, which Claude Code reads,
- `package.json`, but only one at the package root that has a `version` field. A
  nested one, like flow's `engine-tests/package.json`, is never read.

Every version that is there must be the same. And when the manifest has a version,
a `plugin.json` that exists must have one too: otherwise Claude Code identifies
the package by commit while DorkOS reports the manifest's number. A package with
only one of these files, or with no version anywhere, passes.

This is DorkOS's own rule, applied before publishing: DorkOS refuses a package
whose manifest and `plugin.json` disagree (`VERSION_MISMATCH`). It exists because
flow shipped with its manifest saying 0.6.0 while `plugin.json` said 0.7.2, so
DorkOS showed one version while Claude Code ran another. The check lives in
`src/versions.ts` and needs no DorkOS schema, so bumping the pin has nothing to do
with it.

## Bump on change

`npm run check:bump -- <base> <head>` fails when a package's files changed
between the two commits but its version did not go up. Claude Code reads a
package's version from `plugin.json` (then the manifest), and once there is one,
an install only updates when that number rises. A change without a bump never
reaches anyone.

- The change is measured from where `head` branched off `base`, so commits that
  landed on `main` in the meantime never count.
- Every file counts, a README or `docs/` page included: it ships in the install.
- A new package passes, and so does a deleted one. Removing a version fails.
- A package that declares no version at either commit is exempt, with a note:
  Claude Code serves it by commit, so every change already reaches people.
- A package is its `marketplace.json` entry name, the name people install. A
  moved directory whose entry keeps its name is still one package; a renamed
  entry is a new package plus a deleted one.

CI runs it on every pull request (base against head) and on every push to `main`
(`before` against `after`), which catches two PRs that each bumped to the same
version.

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
