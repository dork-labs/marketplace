# Flow on skill-only runtimes

Each `flow-command-<name>` skill runs `commands/<name>.md` from this package;
`flow-command-flow` is the `/flow` router. Supply the operator's arguments wherever
the body says `$ARGUMENTS`; never pass that placeholder literally. Missing arguments
follow that command's question/default behavior. Read the command body, then its
referenced stage skill and supporting files when requested.

## Paths and routing

Resolve the loaded skill file's real path first, including symlinks: its parent
`skills/` folder belongs to the package root. Substitute that root for
`${CLAUDE_PLUGIN_ROOT}` and `<flow-root>` in file paths and script invocations.
Resolve Markdown links relative to their source file, never the project cwd. Keep scripts' cwd at the project or
selected worktree; the plugin folder is not the project.

When instructions name `/flow:<name>`, read `flow-command-<name>/SKILL.md` instead
if slash commands are unavailable; `/flow` means `flow-command-flow`. An OpenCode
project command is `/flow-<name>` when projected; global sharing supplies skills
only. Prefer these skill entry points across runtimes. The existing scheduled
`flow-groom` skill differs from the interactive `flow-command-groom` entry.

## Tools and authority

Command frontmatter describes Claude Code's tool restrictions, not a grant on
another runtime. Use only tools available and authorized in this session;
keep the command's read-only boundaries, isolated tracker writes and confirmation
gates. Missing authority: report the blocked step and stop dependent work.
Never enable a schedule or raise a permission mode to make a command succeed.
Dork (`doe`) supplies builder shell only in `bypassPermissions`;
`default` and `acceptEdits` cannot run Flow's shell steps. Report that limitation
and leave mode changes to the operator.

- If you don't have `AskUserQuestion`, ask the same question in chat and wait.
  Headless approval gates stop; ordinary headless defaults remain as documented.
- If you don't have `TaskList`, `TaskGet`, `TaskCreate` or `TaskUpdate`, use
  `specs/<slug>/03-tasks.json`: select by id/slug, preserve full descriptions and
  dependencies, and persist `status` as `pending`, `in_progress` or `completed`
  (missing means pending). Match an API task id back to its canonical JSON id;
  tracker identifiers are separate. Regenerate the Markdown projection; resume
  from these files and `04-implementation.md`, without claiming a live task display.
- If you don't have `EnterWorktree`, use `scripts/spec-worktree.sh <SLUG>` from
  the package, with the existing isolation policy. Verify its returned directory
  and branch, and run every edit there. Failure stops implementation. Without
  `ExitWorktree`, report the path and leave it intact for the operator.
- If you don't have `Task`/`Agent`, use authorized native delegation with explicit
  model selection; if absent, work serially and record the limitation. Independent
  review still needs another reviewer or a person; never approve your own work.
- If you don't have `ToolSearch`, inspect the session's tool catalog/discovery
  surface; never invent a tool. Missing DorkOS schedule tools retain the commands'
  manual Schedules-page fallback.

## Loop limits

Skill delivery does not add hooks. OpenCode and Dork have no Flow Stop/PostToolUse
hook execution; Codex's hook payload and session-identity parity remain unproved.
Use explicit `continue` ticks, stopping after each, instead of creating the `auto`
sentinel on these runtimes. This does not enable or change any host schedule.
OpenCode skill discovery still needs a live probe. Dork's launcher supports
manual runs and their reviewer; vendor fleet rotation does not select Dork.
