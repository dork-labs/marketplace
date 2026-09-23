# `/flow` configuration

Your `/flow` settings live in your project, in `.agents/flow/`. This folder in the
plugin holds only the templates, the schema and this guide. Settings split in two:
team policy is committed and shared by everyone on the repo, and this machine's
credentials and overrides are never committed.

## The config triad

| File                                                      | Committed?       | Purpose                                                                                                         |
| --------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `.agents/flow/config.json`                                | yes              | Shared team defaults. Pure behavioral policy: stages, autonomy, gates, dispatch, and so on. Carries NO secrets. |
| `.agents/flow/config.local.json`                          | no (git ignores) | Per-machine secrets and overrides. Holds your tracker credentials plus any field you want to override locally.  |
| `.agents/flow/.gitignore`                                 | yes              | Written by flow. Makes git ignore `config.local.json`.                                                          |
| `config.example.json`, `config.local.example.json` (here) | from the plugin  | The templates `/flow:init` fills in.                                                                            |

### Getting started

Run `/flow:init`. It writes both files for you. By hand:

```bash
node --experimental-strip-types "<flow-root>/scripts/config-files.ts" prepare
cp "<flow-root>/config/config.local.example.json" .agents/flow/config.local.json
# then edit config.local.json and fill in your values
```

`prepare` creates `.agents/flow/`, writes the `.gitignore`, and asks git to prove
the local file is ignored before you put a token in it.

Delete any block in `config.local.json` you do not need. If your host already
supplies tracker auth (for example through a connected MCP server or CLI
connection), you can omit `secrets.trackerToken` entirely and keep only the
account handle.

## Where the files live, and why

Plugin hosts replace a plugin's folder when they update it. Claude Code installs
each version into its own cache folder, so anything written inside the plugin is
left behind on the next update. Your settings therefore never live in the plugin.

The project is the one place that works everywhere:

- **It survives every update**, under DorkOS, Claude Code, or anything else.
- **Team policy can be committed** with the code it governs.
- **Each project keeps its own settings**, even when one flow install serves
  several projects (each names its own tracker team).
- **Scripts can find it** from the project folder alone. Claude Code's
  `${CLAUDE_PLUGIN_DATA}` is none of these: it is one folder per user shared by
  every project, it is never in the repo, and the shell commands a skill runs
  cannot see it.

`scripts/config-files.ts` is the one place that decides which files flow reads.
It looks in this order, and the first `config.json` wins:

1. **Your checkout's** `.agents/flow/`.
2. **The main checkout's** `.agents/flow/`, when you are in a linked git worktree.
   `config.local.json` is ignored by git, so it never reaches a new worktree;
   flow finds it in the main checkout instead, and new files are written there.
3. **Inside the plugin** (settings from flow before 0.8.0): its own `config/`
   folder, or, right after a Claude Code update, the previous version's folder.
   Both files are read from the same folder.

If none of these has a `config.json`, flow is not configured yet and `/flow`
sends you to `/flow:init`.

### Moving settings out of the plugin

The first `/flow` or `/flow:init` after updating runs
`config-files.ts migrate`. It copies `config.local.json` byte for byte (readable
only by you) and then `config.json` into `.agents/flow/`, pointing the copy's
`$schema` at the published schema so your editor still checks it. It never
overwrites a file already in `.agents/flow/`: if one differs, it stops and names
both files, and flow keeps reading the old ones until you decide. It never
deletes the old files either, because another project may use the same install.
Once your project has its own `config.json`, the old files are no longer read
for it; delete them when no project needs them. Commit `.agents/flow/config.json`
and `.agents/flow/.gitignore`.

## Precedence

When the engine resolves a config value, later layers override earlier ones:

```
environment variable  >  config.local.json  >  config.json  >  schema defaults
```

1. **Environment variables** (highest). The right place for secrets in CI or
   ephemeral environments where writing a file is undesirable. The engine reads
   `FLOW_`-prefixed variables (for example `FLOW_TRACKER_TOKEN`,
   `FLOW_TRACKER_ACCOUNT`), and they win over both files.
2. **`config.local.json`** (per-machine). Deep-merges over `config.json`. Use it
   for your credentials and for any local override (for example forcing
   `autonomy.default` to `manual` on your own machine).
3. **`config.json`** (committed). The shared team defaults.
4. **Schema defaults** (lowest). Every field has a resolved default declared in
   the schema, so any field absent from all of the above still resolves to a
   sensible value.

### How secrets and overrides coexist

The behavioral policy schema lists every key flow knows, so it flags unknown
keys: editors underline them, and flow's config check reports them as warnings
(it ignores them rather than rejecting the file). It deliberately contains no
credential fields, so the loader handles `config.local.json` in two parts:

- The `secrets` block is read out-of-band as adapter credentials. It is never
  passed through the policy schema, so it can hold whatever your tracker adapter
  needs.
- Every other key (for example `identity`, `autonomy`) deep-merges over
  `config.json` and is validated against the policy schema like the committed
  file.

## `tracker` names an adapter, not a supported product

`tracker` is a **slug**, not a fixed list. It is the `<tracker>` in
`skills/<tracker>-adapter/SKILL.md` — the adapter skill every stage skill and
command routes its tracker reads and writes through. So the value has exactly one
job: name a directory. It must be lowercase letters, digits and dashes, starting
with a letter (`^[a-z][a-z0-9-]*$`).

The default is `linear`, the **reference adapter shipped in this repo**
(`skills/linear-adapter/`). Any other value names an adapter `/flow:init`
generated for you: init picks the tracker with you, writes
`skills/<tracker>-adapter/SKILL.md`, and does not finish until that adapter passes
the conformance harness. Setting `tracker` to `github` or `jira` is therefore a
setup step, not a request for support that has to be added upstream.

The slug is deliberately permissive for that reason. Before, this field was a
closed list containing only `linear` — so a tracker init had just recommended,
generated and verified could not be written into the config it was generated for,
and the only workaround was editing plugin source that the next plugin update
overwrote.

## Schema and editor validation

`config.json` references `config.schema.json` through its `$schema` key, which
gives editors inline validation and autocomplete for the behavioral policy. The
key is the schema's published URL
(`https://raw.githubusercontent.com/dork-labs/marketplace/main/plugins/flow/config/config.schema.json`),
because a path into the plugin would not resolve from your project and would name
one machine's install folder in a committed file. `/flow` itself checks the file
against the copy of the schema in the plugin you have installed.

`config.schema.json` is **generated**, not hand-written. The authoritative schema
is the engine's `config-schema.ts` (the Zod source of truth); the JSON Schema
artifact is produced from it. Never hand-edit `config.schema.json`. To change the
config shape, edit the Zod schema and regenerate the JSON Schema artifact.

The schema describes the file you write, not the config the loader resolves from
it: any field with a default may be left out, and takes that default. A
`config.json` written by an older flow therefore stays valid when a newer flow adds
a field. An unknown key never makes the file invalid either: flow ignores it and
reports it as a warning naming its path, so a misspelled field is surfaced rather
than silently dropped. Editors still underline it, because the schema lists every
key flow knows.

`config.local.json` and its `.example` intentionally do not reference
`config.schema.json`: the `secrets` block lives outside the strict policy schema,
so pointing the local file at the schema would flag those fields as errors. The
policy fields you override there are still validated once the loader merges them
over `config.json`.

## The review rubric is a file, not a config value

Two blocks decide how much scrutiny a change gets on its way past a human, and
they are easy to confuse because both are called `review`:

| Block          | When it fires                          | What it controls                                                          |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| `review`       | in VERIFY, **before** the PR is opened | The adversarial machine review: on/off, which rubric, how many reviewers. |
| `gates.review` | **after** a human approves             | The auto-merge ladder: CI, conflicts, re-approval.                        |

`review.rubric` (default `REVIEW.md`) is a **path to a file**, not the rubric
itself. It resolves against the repo root; outside a repo it resolves against the
current directory, and an absolute path is used as-is. Keeping the rubric in a file rather than in config is deliberate:
a rubric is prose that grows with the repo — its hard rules, its severity
calibration, the things its CI already enforces — and prose belongs in a file a
person edits and reviews, not in a JSON string. `/flow:init` scaffolds one from
`<flow-root>/templates/review-rubric.md` when the path does not exist yet, with
placeholder sections for you to fill in. If the file is missing at review time,
the reviewer still runs, on general review discipline alone; it degrades, it does
not block.

`review.reviewers` (default `1`) is how many independent reviewer agents each
review dispatches. Raise it for changes with a wide blast radius; every extra
reviewer costs another full read of the diff. Their findings are **pooled, not
polled**: any blocking finding blocks unless it is rebutted, so a second reviewer
who misses a defect never cancels out the one who found it.

## Model tiers are committed; model names are not

The `models` block is split down the same line as everything else here, and for
the same reason.

| Half              | Lives in            | Holds                                                                                                   |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `models.tiers`    | `config.json`       | Which class of delegated work runs on which tier: `implementation`, `review`, `analysis`, `mechanical`. |
| `models.bindings` | `config.local.json` | Which real model each tier means **on this machine**: `workhorse` and `fast`.                           |

Tiers are roles, not models. `workhorse` means "the strong general-purpose model
this machine can reach"; `fast` means "the cheap quick one". Which models those
are depends on the machine, the harness, and what a vendor is shipping this
month — none of which belongs in a file everyone on the repo shares. So the
committed half names no model, and the plugin ships **no** default binding.
`/flow:init` asks you to rank the models your harness can reach and writes the
answer to `config.local.json`.

The defaults put the three judgment classes (`implementation`, `review`,
`analysis`) on `workhorse` and `mechanical` work — searches, scaffolds, renames,
log triage — on `fast`. Mechanical work has a checkable answer, so a cheaper
model that gets it wrong gets caught; a weak reviewer just misses things quietly.

Nothing here fails closed. A machine with only one model binds both tiers to it
and the policy becomes a no-op. A missing binding falls back to whatever model
your harness would have used anyway, and the run says that it did — a silent
fallback would look exactly like a policy that worked.

## Why `config.json` has no secrets

`config.json` is committed and shared, so it must stay free of tokens, API keys,
and account handles. The behavioral policy schema reflects this: identity
resolves at runtime (`agent: "auto"`, `reviewer: null`) rather than shipping a
real account, and there is no credential field anywhere in the committed config.
Anything secret or machine-specific belongs in `config.local.json` (gitignored)
or in a `FLOW_`-prefixed environment variable.

The same rule covers the **tracker-connection coordinates**. `connection.team`
(`key` + `id`) and `connection.workspace.slug` are non-secret, but they are
deployment-specific, so the committed default ships them as `null` placeholders —
a real team id in the shared template would re-hardcode the very agnosticism the
adapter is built to preserve. `/flow:init` discovers the real values and writes
them to `config.local.json`. Only `connection.transport` (which access path is
primary — `cli` or `mcp`) is shared policy and stays in the committed file. The
concrete tracker adapter reads all of these from config rather than naming a team
or workspace inline.
