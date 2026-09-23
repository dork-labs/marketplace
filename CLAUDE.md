# DorkOS Marketplace

## What This Is

The official DorkOS marketplace repository — a catalog of packages (agents, plugins, skill-packs, adapters) that extend DorkOS. Currently in bootstrap phase (v0.1.0) with 9 seed packages. Serves as both the canonical regression fixture for the marketplace validator and the publication hub for DorkOS packages.

This repo is also the workspace for the `dork-os-marketing` agent, which handles DorkOS marketing tasks.

## What DorkOS Is

DorkOS is the operating system for autonomous AI agents. It provides scheduling, communication, discovery, and a control center so that AI coding agents (Claude Code, Cursor, Codex) can work autonomously — overnight, across projects, coordinated with each other.

**Core thesis:** "Intelligence doesn't scale. Coordination does."

**Tagline:** "You slept. They shipped."

**Four pillars:**
- **Tasks** — Schedule and dispatch agent work (cron-based)
- **Relay** — Message bus between agents and humans (Telegram, Slack, webhooks)
- **Mesh** — Agent discovery and coordination across projects
- **Console** — Web dashboard to chat with and control all agents

**Two upcoming modules:**
- **Loop** — Continuous improvement engine (agents spot what's working, test ideas)
- **Wing** — Personal productivity pack (cross-session context persistence)

**Key facts:**
- Open source, MIT licensed, self-hosted, no telemetry
- Built on Claude Agent SDK + MCP
- Tech stack: TypeScript, React 19, Vite 6, Express, SQLite, Turborepo monorepo
- Website: https://dorkos.ai
- GitHub: https://github.com/dork-labs/dorkos
- npm: `dorkos`
- Contact: hey@dorkos.ai
- Creator: Dorian Collier / Dork Labs
- Current version: v0.37.0

## Repository Structure

```
marketplace/
├── CLAUDE.md                # This file
├── README.md                # Project overview
├── .claude-plugin/
│   ├── marketplace.json     # CC-standard marketplace index (all plugins listed)
│   └── dorkos.json          # DorkOS sidecar (type, layers, icon, pricing per plugin)
├── .dork/
│   ├── manifest.json        # Agent manifest for this project
│   ├── SOUL.md              # Agent personality traits
│   └── NOPE.md              # Agent safety boundaries
└── plugins/                 # Individual packages
    ├── code-reviewer/       # Agent: PR reviews, Slack notifications
    ├── security-auditor/    # Agent: Security audits, vulnerability checks
    ├── docs-keeper/         # Agent: Keeps docs in sync with code
    ├── linear-integration/  # Plugin: Two-way sync with Linear
    ├── posthog-monitor/     # Plugin: Analytics for agent runs
    ├── security-audit-pack/ # Skill-pack: Security audit tasks
    ├── release-pack/        # Skill-pack: Release management workflows
    ├── discord-adapter/     # Adapter: Discord notifications/commands
    └── marketplace-dev/     # Skill-pack: How to develop marketplace packages
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

The three checks below run on every pull request, every merge-queue run (`merge_group`) and
every push to `main`, with no `paths:` filter and no job-level `if:`. That is what lets a
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
- `scripts-test.yml`, check **`script fixtures`**. Runs the fixture suites in `scripts/`:
  the auto-merge arming gate and the two `.claude/hooks` guards.
- `merge-tail.yml`, scheduled. Arms auto-merge on finished pull requests nobody armed (see
  below). It needs the `dorkos-merge-tail` GitHub App's secrets and fails loudly without them.

## Landing changes

- **One checkout, one writer.** Several agents work this repo at once. Make every code change
  in its own worktree (`/worktree:create <branch>`, from `origin/main`), never in the shared
  `main` checkout, and never create a worktree from inside one. The `working-in-worktrees`
  skill has the mechanics.
- **Nothing lands on `main` except through a pull request**, squash-merged. Never push to
  `main` directly; force pushes and deleting `main` are refused.
- **Review the pushed branch, then open the PR.** The adversarial review runs against the
  branch before a PR exists, calibrated by `REVIEW.md`; open the PR once it converges. The
  `creating-pull-requests` skill has the order, the local gates and the PR watcher.
- **Bump what you change.** Any change under `plugins/<name>/`, a README or doc included,
  raises that package's version in every file that declares it (`plugin.json`,
  `.dork/manifest.json`, `package.json`) and adds a `CHANGELOG.md` entry where the package
  keeps one. `skills and manifests` fails the PR otherwise.
- **Arm your own PR once it is open and reviewed:** `gh pr merge --auto --squash <n>`.
  It merges by itself when the required checks pass. While `main` requires branches to be up
  to date, a PR that falls behind waits until you run `gh pr update-branch <n>`.
- **What merges by itself, and what does not.** `merge-tail.yml` arms a PR only when every
  signal is good (the rules are `scripts/should-arm-automerge.sh`, pinned by its fixtures). It
  never arms a draft; a PR labelled `hold`, `do-not-merge`, `wip` or `blocked`; a conflicting
  PR or one whose mergeability GitHub has not worked out yet; a PR with changes requested or
  an unresolved review thread; or a PR with any check failing, cancelled or still running. The
  labels mean the same in dork-labs/dorkos. Put `hold` on a green PR you do not want landed.
  Never admin-merge past a red or missing check.
- **Tracker routing.** Work for this repo is tracked in Linear team DOR (the same team as
  dorkos), and an item that lands here carries the **`repo/marketplace`** label (group `repo`).
  An item with no `repo` label lands in dork-labs/dorkos. This repo is public: nothing from a
  private repo belongs in a commit, a PR body or an issue here.

## Related Resources

- **Core codebase:** `../core/` — The DorkOS monorepo (apps, packages, services)
- **Meta docs:** `../core/meta/` — Brand foundation, personas, value architecture, website copy
- **Decisions:** `../core/decisions/` — Architecture Decision Records
- **Contributing:** `../core/contributing/` — Internal dev guides
- **Research:** `../core/research/` — 140+ research reports
- **Website:** `../core/apps/site/` — Next.js 16 marketing site + Fumadocs docs
- **Docs content:** `../core/docs/` — MDX documentation for the docs site

## Brand & Marketing Context

### Target Personas
- **Kai Nakamura** (Primary) — 28-35, senior full-stack / indie hacker. Ships daily, runs 10-20 agent sessions/week. Frustrated by session isolation, agents forgetting context, can't run overnight.
- **Priya Sharma** (Secondary) — 30-40, staff engineer / technical architect. Manages architecture across services. Frustrated by context-switching, no cross-client session visibility.
- **Jordan Wells** (Anti-persona) — Non-technical PM/marketing. Wants pretty ChatGPT. Explicitly out of scope.
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
Uses "The Panel" — 5 advertising/design legends as creative agent personas (Ogilvy, Jobs, Godin, Ive, Wieden) to develop copy through structured rounds. Decisions documented in `../core/meta/website-copy/decisions.md`.
