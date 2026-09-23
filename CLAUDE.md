# DorkOS Marketplace

## What This Is

The official DorkOS marketplace repository — a catalog of packages (agents, plugins, skill-packs, adapters) that extend DorkOS. Currently at marketplace version 0.1.0, listing 15 packages in `.claude-plugin/marketplace.json`. Serves as both the canonical regression fixture for the marketplace validator and the publication hub for DorkOS packages.

This repo is also the workspace for the `dork-os-marketing` agent, which handles DorkOS marketing tasks.

## What DorkOS Is

DorkOS is the operating system for autonomous AI agents. It provides scheduling, communication, discovery, memory, and one place for every AI agent you run, so coding agents (Claude Code, Codex, OpenCode, side by side) can work autonomously — overnight, across projects, coordinated with each other.

**Tagline:** "You, Multiplied." (hero surfaces)

**Manifesto line:** "Intelligence doesn't scale. Coordination does." (essays and anti-positioning only, never a hero opening)

**Banned in user-facing prose:** "mission control" and "cockpit" (retired 2026-08, DOR-1517). Say "one place" or "one window".

**Four pillars:**
- **Tasks** — Schedule and dispatch agent work (cron-based)
- **Relay** — Message bus between agents and humans (Telegram, Slack, webhooks)
- **Mesh** — Agent discovery and coordination across projects
- **Console** — Web dashboard to chat with and control all agents

**Related products:**
- **Loop** — a separate product, the autonomous improvement engine (github.com/dork-labs/loop)
- **Wing** — vision only, with no code yet; never market it as "coming soon"

**Key facts:**
- Open source, MIT licensed, self-hosted; telemetry is off unless you turn it on
- Runs Claude Code, Codex and OpenCode agents; speaks MCP
- Tech stack: TypeScript, React 19, Vite 6, Express, SQLite, Turborepo monorepo
- Website: https://dorkos.ai
- GitHub: https://github.com/dork-labs/dorkos
- npm: `dorkos`
- Contact: hey@dorkos.ai
- Creator: Dorian Collier / Dork Labs
- Current version: v0.81.0 (check `git tag` in the dorkos repo; this line goes stale)

## Repository Structure

```
marketplace/
├── CLAUDE.md                # This file
├── README.md                # Project overview
├── .claude-plugin/
│   ├── marketplace.json     # CC-standard marketplace index (all plugins listed)
│   └── dorkos.json          # DorkOS sidecar (type, layers, icon, pricing per plugin)
├── .dork/
│   ├── agent.json           # Agent manifest for this project
│   ├── SOUL.md              # Agent personality traits
│   └── NOPE.md              # Agent safety boundaries
├── scripts/                 # Fixture-pinned guard and gate scripts (run by scripts-test.yml)
├── tools/schema-check/      # The `skills and manifests` gate
└── plugins/<name>/          # One folder per package; marketplace.json is the list
```

## Package Types

| Type | Description | Examples |
|------|-------------|---------|
| **agent** | Full AI agent with persona, skills, tasks | code-reviewer, security-auditor, docs-keeper |
| **plugin** | Claude Code extension with commands/hooks/UI | linear-integration, posthog-monitor |
| **skill-pack** | Bundles of reusable SKILL.md expertise files | security-audit-pack, release-pack |
| **adapter** | Integration bridge for external services | discord-adapter |

## Key Manifests

- **marketplace.json** — CC-standard registry. Lists all plugins with name, source path (`./plugins/<name>`), description, author, license, category, tags.
- **dorkos.json** — DorkOS sidecar (ADR-0236). Adds type, layers, icon, pricing, featured status per plugin.
- Each plugin has its own `.dork/manifest.json` and `.claude-plugin/plugin.json`.

## Validation

```bash
dorkos package validate       # Validates individual package manifests
dorkos marketplace validate   # Validates the full registry (CC compat + sidecar schema)
```

## CI

All three checks below are required on `main`. Each runs on every pull request, every
merge-queue run (`merge_group`) and every push to `main`, with no `paths:` filter and no
job-level `if:`. That is what lets a
check be required: a required check that skips a PR, or never reports on the queue's run,
leaves the PR waiting forever. Keep it that way, or un-require the check first.

- `flow-tests.yml`, check **`flow plugin`** (required). Checks that
  `plugins/flow/config/config.schema.json` still matches the Zod schema it is generated from,
  then runs the flow plugin's typecheck, tests and format check. No other plugin has its own
  checks yet.
- `schema-check.yml`, check **`skills and manifests`** (required). Repo-wide. Validates every
  plugin's `SKILL.md` frontmatter and `schedule:` blocks, plus the marketplace/sidecar/package
  manifests, against the real DorkOS Zod schemas, downloaded from the public dorkos repo at
  the commit pinned in `tools/schema-check/upstream.json`. It exists because DorkOS
  deliberately degrades a broken `schedule:` block to no schedule at all, so a one-character
  typo used to ship a scheduled task that silently never runs (DOR-1519). Read
  `tools/schema-check/README.md` before touching a schedule block or bumping the pin.
  It also fails when a package's `.dork/manifest.json`, `.claude-plugin/plugin.json` and
  root `package.json` versions disagree, or the manifest has a version and `plugin.json`
  has none; and when a package's files changed without its declared version going up
  (`npm run check:bump`). A package that declares no version is exempt; declaring one opts in.
- `scripts-test.yml`, check **`script fixtures`** (required). Runs the fixture suites for
  the auto-merge arming gate, the three `.claude/hooks` guards (git, process, admin merge),
  the wrapper that makes those guards refuse rather than skip when node is missing, and the
  PR watcher.

## Landing changes

- **One checkout, one writer.** Several agents work this repo at once. Make every code change
  in its own worktree (`/worktree:create <branch>`, from `origin/main`), never in the shared
  `main` checkout, and never create a worktree from inside one. The `working-in-worktrees`
  skill has the mechanics.
- **Nothing lands on `main` except through a pull request and the merge queue**, squash-merged.
  Never push to `main` directly; force pushes and deleting `main` are refused. The queue runs
  the required checks again on your PR on top of `main` and everything ahead of it, then
  merges. Being behind `main` blocks nothing, so never update a branch to satisfy a gate.
  Never admin-merge: `.claude/hooks/merge-guard.mjs` refuses the admin flag on `gh pr merge`
  and the other direct-merge spellings.
- **Review the pushed branch, then open the PR.** The adversarial review runs against the
  branch before a PR exists, calibrated by `REVIEW.md`; open the PR once it converges. The
  `creating-pull-requests` skill has the order, the local gates and the PR watcher.
- **Bump what you change.** Any change under `plugins/<name>/`, a README or doc included,
  raises that package's version in every file that declares it (`plugin.json`,
  `.dork/manifest.json`, `package.json`) and adds a `CHANGELOG.md` entry where the package
  keeps one. `skills and manifests` fails the PR otherwise.
- **Arm your own PR once it is open and reviewed:** `gh pr merge --auto --squash <n>`.
  It goes into the queue and merges by itself when the required checks pass. Nothing else
  arms PRs yet, so an unarmed PR sits open.
- **What may merge by itself.** The rules are `scripts/should-arm-automerge.sh`, pinned by its
  fixtures: a PR is armed only when every signal is good. Never arm a draft; a PR labelled
  `hold`, `do-not-merge`, `wip` or `blocked`; a conflicting PR or one whose mergeability GitHub
  has not worked out yet; a PR with changes requested or an unresolved review thread; or a PR
  with any check failing, cancelled or still running. The labels mean the same in
  dork-labs/dorkos. A scheduled `merge-tail` workflow that applies these rules to every open
  PR arrives once the `dorkos-merge-tail` GitHub App is set up on this repo (DOR-2270);
  until then, authors arm their own.
- **Tracker routing.** Work for this repo is tracked in Linear team DOR (the same team as
  dorkos), and an item that lands here carries the **`repo/marketplace`** label (group `repo`).
  An item with no `repo` label lands in dork-labs/dorkos. This repo is public: nothing from a
  private repo belongs in a commit, a PR body or an issue here.

## Related Resources

Paths assume the dorkos repo is checked out beside this one, as `../dorkos/`.

- **Core codebase:** `../dorkos/` — The DorkOS monorepo (apps, packages, services)
- **Meta docs:** `../dorkos/meta/` — Brand foundation, personas, value architecture, website copy
- **Decisions:** `../dorkos/decisions/` — Architecture Decision Records
- **Contributing:** `../dorkos/contributing/` — Internal dev guides
- **Research:** `../dorkos/research/` — 370+ research reports
- **Website:** `../dorkos/apps/site/` — Next.js 16 marketing site + Fumadocs docs
- **Docs content:** `../dorkos/docs/` — MDX documentation for the docs site

## Brand & Marketing Context

### Target Personas
- **Kai Nakamura** (Primary) — 28-35, senior full-stack / indie hacker. Ships daily, runs 10-20 agent sessions/week. Frustrated by session isolation, agents forgetting context, can't run overnight.
- **Priya Sharma** (Secondary) — 30-40, staff engineer / technical architect. Manages architecture across services. Frustrated by context-switching, no cross-client session visibility.
- **Ikechi** (Secondary) — non-developer founder who ships apps by directing agents; an operator, not a programmer.
- **Lil** (Horizon, not a launch target) — privacy-first non-technical professional.
- **Jordan Wells** (Anti-persona) — wants a hosted chat app. The line is operator mentality (won't own and run their own system), not technical skill.
- **AI-Native Dev Shop** (ICP) — 1-10 devs, bootstrapped/seed-stage, already paying for Claude Pro/Team API.

### Brand Voice
- Confident, technical, minimal, sharp, honest
- "Built by dorks. For dorks. Run by you."
- Embrace "dork" as someone who cares too much about something most people don't care about at all
- Pro-human positioning: agents augment developers, not replace them
- No enterprise jargon, no AI hype, no "revolutionary" language

### Key Pain Themes (from customer research)
1. Terminal Isolation — agents stuck in terminal, can't manage remotely
2. No Background/Scheduled Execution — can't run overnight, Mac sleep problem
3. Agent Communication — agents can't notify or coordinate with each other
4. Session Memory/Context Loss — agents forget everything between sessions
5. Trust and Transparency — safety concerns with autonomous execution
6. Self-Hosted/Open Source Identity — developers want control and privacy

### Competitive Position
DorkOS is NOT: an agent, a wrapper, a hosted service, a replacement for Claude Code.
DorkOS IS: the infrastructure layer that makes agents autonomous — the coordination system, not the intelligence.

### Website Creative Process
Uses "The Panel" — 5 advertising/design legends as creative agent personas (Ogilvy, Jobs, Godin, Ive, Wieden) to develop copy through structured rounds. Decisions documented in `../dorkos/meta/website-copy/decisions.md`.
