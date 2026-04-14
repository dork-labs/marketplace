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
