# schema-check

Repo-wide CI gate. It checks five things about everything in `plugins/`:

1. **Every `SKILL.md` still says what its author meant.** Not just "does it
   parse" — every line the author wrote has to survive the parse still meaning
   what they wrote, setting names included.
2. **Every manifest still validates.** `.claude-plugin/marketplace.json` (against
   the DorkOS schema _and_ the Claude Code standard one), `.claude-plugin/dorkos.json`,
   and any plugin's `.dork/manifest.json`.
3. **Every package states one version.** See [Version agreement](#version-agreement).
4. **No package grants more than it names.** Every command's and skill's
   `allowed-tools` holds to a permission floor. See [Allow rules](#allow-rules).
5. **Nothing runs on its own but the package's own scripts.** Every hook and
   MCP server. See [Hooks and MCP servers](#hooks-and-mcp-servers).

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

| What breaks                                       | What catches it                                         |
| ------------------------------------------------- | ------------------------------------------------------- |
| A rejected **value** (`permissions: acceptEditz`) | `ScheduleBlockSchema.safeParse` fails                   |
| A **swallowed** value (`enabled: maybe`)          | Comparing what was written against what the schema kept |
| A bad **key** (`permissionz:`, `modle:`)          | Comparison against the schema's own key set             |
| The **whole block** gone, or `schedul:`           | The list in `src/scheduled-skills.ts`                   |

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
- `package-lock.json` next to that `package.json`, so a hand-edited
  `package.json` can't drift from its lockfile.

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
package's version from `plugin.json` (then the marketplace entry, then the
commit); DorkOS reads the same, falling back to `.dork/manifest.json`. Once a
package has a version, an install only updates when that number rises, so a
change without a bump never reaches anyone. The check takes the version from
`plugin.json`, then the manifest.

- The change is measured from where `head` branched off `base`, so commits that
  landed on `main` in the meantime never count.
- Every file counts, a README or `docs/` page included: it ships in the install.
- A new package passes, and so does a deleted one. Removing a version fails.
- A package that declares no version at either commit is exempt, with a note:
  Claude Code serves it by commit, so every change already reaches people.
- A package is its `marketplace.json` entry name, the name people install. A
  moved directory whose entry keeps its name is still one package; a renamed
  entry is a new package plus a deleted one. An entry whose directory is still
  there after the entry was dropped (or before it was added) is compared by
  directory, and a directory no entry lists is judged as `plugins/<dir>`.
- A `plugin.json` or manifest at `head` that is not valid JSON fails, naming the file.
- Both commits must be real commits; anything else fails before git sees it.

CI runs it on every pull request (base against head), on every merge-queue run
(the entry's base against the commit the queue built), and on every push to
`main` (`before` against `after`). A queue entry's base is the entry ahead of it
(or `main` when it is first), so two PRs that each bumped a package to the same
version cannot both merge: the second one fails in the queue.

## Allow rules

A command's or skill's `allowed-tools` runs without asking, so a broad rule is
a grant to whatever the agent gets steered into. On Claude Code 2.1.300 a bare
`Write` or `Edit` writes anywhere on disk, `Bash(node:*)` runs `node -e`, and
`Bash(git log:*)` writes files with `--output`. Flow narrowed its own rules in
0.56.0; `src/allowed-tools.ts` holds every package to the same floor.

It is an allow-list: a rule passes only when it matches one of these shapes,
and anything else is refused.

- Only tools on `KNOWN_TOOLS`. A tool nobody has reviewed is refused, bare or
  with a spec (`Monitor` runs a command and can open a WebSocket). The ones
  that are a whole shell or every file write are refused bare: `Bash`,
  `PowerShell`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
- One MCP tool, `mcp__<server>__<tool>`. A bare server or a `*` is refused.
  The server has to be one the package ships in `.mcp.json` or plugin.json's
  `mcpServers` (Claude Code names its tools `mcp__plugin_<package>_<server>__<tool>`).
  A tool on any other server (`mcp__dorkos__mcp_add_server`,
  `mcp__playwright__browser_run_code_unsafe`) needs its exact name in
  `REVIEWED_COMMANDS`. Flow's two DorkOS schedule tools are there.
- `Edit(<path>)`, which also governs `Write`. The path starts with a literal
  folder (`specs/**`), never uses `\`, `%`, `$`, `~` or `..`, and never names a
  file that a tool runs later without asking: no dot-file or dot-folder at all
  (`.husky`, `.githooks`, `.github`, `.vscode`, `.devcontainer`, `.envrc`,
  `.mcp.json`, `.npmrc`, `.dork`, `.git`, `.claude`), and no `package.json`,
  `package.yaml` or `package.json5`, `Makefile`, `GNUmakefile`, `justfile`,
  `Taskfile.yml`, lefthook's configs (`lefthook.yml`, `lefthook-local.yml`,
  `.json`, `.toml`), `lint-staged.config.js` or `commitlint.config.js`, CI
  pipelines (`Jenkinsfile`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`)
  or mise's configs (`mise.toml`, `mise.dev.local.toml`, a `mise/` folder), at
  any depth and in any case. The list isn't every such file, so a reviewer
  still reads each `Edit` rule.
- An `Edit` or read path needs a folder: `Edit(docs/notes.md)`, never
  `Edit(notes.md)`. Claude Code matches a path rule the way `.gitignore` does,
  so a rule with no `/` matches that name at any depth: `Edit(ci.yml)` wrote
  `.github/workflows/ci.yml` on Claude Code 2.1.309, and `Read(config)` would
  match `.git/config`. An exact rule to one of those goes in
  `REVIEWED_COMMANDS`; flow's `.dork/flow/tmp/**` and `.dork/flow/auto-run.json`
  are there. `Edit(./**)` is allowed only for the files listed in
  `PROJECT_WRITERS`, and adding one is a security decision that gets its own
  review.
- `Bash(<exact command>)`, or a `:*` prefix on one of the package's own scripts
  by `${CLAUDE_PLUGIN_ROOT}` (`node --experimental-strip-types
"${CLAUDE_PLUGIN_ROOT}/scripts/x.ts":*` or `${CLAUDE_PLUGIN_ROOT}/scripts/x.sh:*`).
  The script has to be a plain file in the package, not a symlink.
- Any other exact `Bash(<command>)` starts with a word on `SAFE_COMMANDS`,
  commands that only read or print (`ls`, `cat`, `head`, `wc`, `grep` and a
  few more). It's an allow-list because a deny-list of "programs that run
  programs" kept leaking (`python3.12`, `gawk`, `caffeinate -i sh`). The command
  can't chain, pipe, redirect, substitute, quote or glob, and each argument
  gets the same checks as a read path, short-flag values included
  (`-fcredentials`). No long options at all, since a value like
  `--files0-from=` names a file of file names. `grep` takes no `-r`, `-R` or
  `-d`. Anything else goes in `REVIEWED_COMMANDS`, per package,
  as its own reviewed diff, or becomes the package's own script.
- `Read`/`Grep`/`Glob`/`LS`/`NotebookRead(<path>)` stay inside the project and
  start with a literal folder (a leading `*` or `**` reaches dot-files). No `/`,
  `//`, `~`, `$`, `%`, `\`, `..` or whitespace, and no secret file or folder:
  `.ssh`, `.aws`, `.config`, `.dork`, `.git`, `.claude*`, `.env*`, `.envrc`,
  `.npmrc`, `.yarnrc*`, `.netrc`, `.git-credentials`, `id_rsa`, `*.pem`,
  `*.key`, `credentials` and the like.
- `WebFetch` only as `WebFetch(domain:<one literal host>)` with a real
  top-level domain: no IP addresses (`169.254.169.254`), and no `.local`,
  `.internal` or `.localhost`. A bare `WebFetch` can send anything anywhere.
- `SlashCommand(/<package>:<command>)` and `Skill(<package>:<name>)`,
  optionally with `:*`, only for a command or skill the package ships. Either runs it with its own `allowed-tools`, and Claude Code
  runs commands through the Skill tool too, so a grant to someone else's can
  reach whatever that one allows. A bare `SlashCommand` or `Skill` needs a
  `REVIEWED_COMMANDS` entry; flow has both.
- A package's own MCP servers and commands count only when its folder,
  plugin.json's `name` and its marketplace entry's `name` all agree, so no
  package can name itself after another and claim that one's tools.
- `<Tool>(<spec>)` for any other known tool, with no nested parentheses.

A bare `Read`, `Grep`, `Glob`, `LS` or `NotebookRead` is refused: in plain
Claude Code a bare read allow reads `~/.ssh` with no prompt. Scope it to a
folder, as `Read(specs/**)`. Flow's bare reads sit in `REVIEWED_COMMANDS`
until flow moves to folder-scoped reads (DOR-3310). `Agent`/`Task` pass bare.

The known limit: a folder-scoped read like `Read(config/**)` still reads a
secret file inside that folder, such as `config/.env`, because `*` matches
dot-files. The floor keeps reads off the project's root secrets (`.env`,
`.git`, `.claude`, `.dork`) and off named secrets anywhere in the path; it
can't see what a folder happens to hold. Writes have the same limit:
`Edit(specs/**)` or `Edit(src/*.json)` can still write `specs/.envrc` or
`src/package.json`, which
matters where direnv or an npm workspace picks them up. The floor keeps writes
off the root files that run on their own (hooks, CI, editor tasks, `.mcp.json`,
the root `package.json`).

So a read scoped to a folder that often holds secrets (`config`, `secrets`,
`env`, `deploy`, `infra`, `.github`, `certs`, `keys`, `credentials`, `apps`, `packages`) passes
but prints a warning, which CI turns into an annotation on the pull request.
The reviewer confirms nothing secret lives there. It never fails the check.

Only a package root's `node_modules` is skipped; a folder by that name
anywhere else (say `skills/node_modules/`) is walked, since Claude Code loads it.

It reads grants the way Claude Code does, as well as the way DorkOS does, and
both readings have to pass. Claude Code strips a BOM, ends frontmatter at the
first `---` anywhere, retries YAML with tabs as spaces, and splits rules with an
on/off parenthesis flag. It checks every `.md` under `plugins/`, any case and any
depth, dot folders included, plus `allowedTools` in a `plugin.json` or
`marketplace.json` command entry. Frontmatter that mentions `allowed-tools` but
can't be read is an error, not a skip, and so is any symlink under `plugins/`.
A marketplace entry with a local `source` must point at `./plugins/<name>`, so
nothing ships from a folder the walk skips. The floor covers packages shipped
from this repo only: a remote `source` (GitHub, a URL) isn't checked here.
A folder under `plugins/` this check can't read is an error.

## Hooks and MCP servers

`allowed-tools` only says what an agent may do without asking. A plugin's
hooks run on events and its MCP servers start with Claude Code, with no
permission check at all. So `src/package-programs.ts` holds them to the same
allow-list stance (DOR-3311): each one runs one of the package's own scripts,
or it is refused.

- **Hooks** are read from `hooks/hooks.json`, plugin.json's `hooks` (a path, an
  inline value or a list of both), a marketplace entry's `hooks`, and the
  `hooks` in any skill or command frontmatter. A path has to stay inside the
  package and exist. Only `command` hooks pass, as `node` on a `.mjs`, `.cjs`,
  `.js` or `.ts` file, or a `.sh` file, by `${CLAUDE_PLUGIN_ROOT}`, followed only
  by fixed lowercase words or flags. The script has to be a plain file in the
  package. The one thing allowed before the script is a change to the project
  root, as one of the two exact `cd ... && ` prefixes in `PROJECT_CD`. `http`,
  `prompt`, `agent` and `mcp_tool` hooks are refused. So is an object with a
  `hooks` key next to other events: Claude Code runs those events and ignores
  `hooks`, so unwrapping it would skip what runs.
- **MCP servers** are read from `.mcp.json`, plugin.json's `mcpServers` and a
  marketplace entry's `mcpServers`. A server passes only as a local one that runs
  `node "${CLAUDE_PLUGIN_ROOT}/<script>"`, or runs a script by
  `${CLAUDE_PLUGIN_ROOT}` directly, followed by plain words or flags. Remote
  servers (`http`, `sse`), and any `env`, `cwd`, headers or helper, are refused.

- **Language servers, monitors and `bin/` programs** (`.lsp.json`,
  `lspServers`, `monitors/monitors.json`, `monitors`, `experimental.monitors`,
  a `bin/` folder) are refused outright until someone reviews a safe shape. No
  package ships one.

A declaration this check can't read is an error, never a skip. Anything
outside these shapes needs a change to this check, reviewed as its own diff.

## Reading a SKILL.md safely

The popular `gray-matter` library runs any frontmatter block that opens with
`---js` or `---javascript` as code, and can take minutes on a long run of blank
lines. So every read here goes through DorkOS's own reader,
`packages/skills/src/frontmatter.ts` (DOR-2308, DOR-2311), fetched at the pin in
`upstream.json` like the schemas and imported as `@dorkos/skills/frontmatter`
(DOR-2312). It does not use gray-matter. It:

- refuses any frontmatter language but YAML or JSON before parsing anything,
- refuses a block over 32 KB, too many YAML aliases, or a value that expands
  or nests past its limits,
- parses YAML with js-yaml v4, which cannot build code from a YAML tag,
- refuses frontmatter that is a single value or a list rather than `key: value` fields.

This is defense in depth, not the security boundary. The CI job already runs a
pull request's own code by design: its install scripts, the scripts in this
folder, and the DorkOS files `upstream.json` points at. What keeps that safe is
how the job is set up: the `pull_request` trigger (never `pull_request_target`),
a read-only token, no secrets, and GitHub's approval step for runs from outside
contributors. `.github/workflows/schema-check.yml` says the same next to its
`permissions:`. The reader matters for any setup that runs trusted code over
untrusted content, and it keeps a `---js` file from ever counting as a valid
skill (DOR-2310).

Nothing in this repo imports gray-matter;
`tests/frontmatter-confinement.test.ts` fails if anything does. Because the
reader is DorkOS's own file, YAML reads the same here as in DorkOS. One
visible effect of v4:
`0123` is the number 123 and `0o17` is 15, where gray-matter's bundled v3 read 83
and the string `"0o17"`.

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
