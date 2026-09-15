# safety-hooks

Three small guards that check every shell command an agent runs, and refuse the
few that destroy other people's work. Everything else runs untouched, so agents
keep working on their own.

| Guard | Refuses | Why |
| --- | --- | --- |
| `git-guard` | `git stash` (push, pop, drop, clear) and checkouts or restores that throw away uncommitted changes | The stash is shared by every worktree. A stash or pop in one can wipe out another agent's work. |
| `process-guard` | Killing processes by name (`pkill`, `killall`) or signalling every process | Agents, test runs and your own servers share process names. A kill by name hits all of them. |
| `file-guard` | Shell commands that read or write paths your `.claude/settings.json` denies | Claude Code's deny rules cover its own Read and Edit tools, not `cat .env` in a shell. This closes that gap. |

A refused command comes back with a message saying why and what to do instead,
so the agent can carry on. Safe look-alikes stay allowed: `git stash list`,
`git checkout main`, `kill <pid>`.

A message that only mentions a blocked command is usually fine. A commit message
in single quotes, or a body passed with `-F` or `--body-file`, can say "never run
`git stash` here" without being refused. One shape stays strict on purpose: a
quoted heredoc inside `$(...)` whose text has a code span inside parentheses,
because older bash ends the `$(...)` at that `)`. You will most often meet it in
`git commit -m "$(cat <<'EOF' ... EOF)"`. The workaround is to put the text in a
file first:

- commit messages: `git commit -F <file>`
- PR bodies: `gh pr create --body-file <file>`

## Setup

Install the plugin. `git-guard` and `process-guard` work with no setup.

`file-guard` enforces the `permissions.deny` rules in your project's
`.claude/settings.json`. With no rules it guards nothing. A starting point:

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./**/*.key)",
      "Read(./**/*.pem)",
      "Edit(./.git/**)",
      "Write(./.git/**)"
    ]
  }
}
```

`.env.example` is always allowed.

## Requirements

Node.js on your `PATH`, and `git` for `git-guard`. On Node 22 or newer,
`file-guard` uses Node's own glob matching; older versions use a built-in
fallback. The guards were tested on Node 22.

## Proving it works

Each shell guard ships with a fixture suite that runs every case through the
guard's real entry point, and also runs blocked commands in a real shell with a
harmless stand-in to prove the guard and the shell agree:

```bash
bash scripts/test-git-guard.sh
bash scripts/test-process-guard.sh
```

## Where these come from

Written for [DorkOS](https://github.com/dork-labs/dorkos), where each rule
followed a real incident: stashes that wiped a teammate's worktree, and a kill
by name that took down the operator's dev server. MIT licensed.
