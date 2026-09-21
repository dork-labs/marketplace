# Ephemeral Infra

One skill, for a bug almost every repo has and nobody notices until the disk fills.

When a script starts a Docker container, a VM, a cloud sandbox or a temp database, it usually cleans up with an exit handler. That handler does not run when the process is killed, and on a machine running several agents at once, kills are ordinary. A detached container also outlives whatever started it. So every killed run leaks, quietly, forever.

One repo reached 1,025 orphaned volumes and 110.6 GB before anyone looked.

The fix is not a bigger disk or a tidier exit handler. It is:

- label everything you create, with the creating process and its start time
- sweep leftovers at the **start** of the next run, because a later run is the only actor that can clean up after a kill
- decide by whether the owner is still alive, and use age only when ownership is unknowable

The skill covers the shape, the traps (recycled process ids, anonymous volumes, deterministic names that break parallel runs), and how to test a sweep without deleting someone's running test.

## Install

From the DorkOS Marketplace, at project scope. Claude Code users can also load it directly:

```bash
claude --plugin-dir <marketplace-checkout>/plugins/ephemeral-infra
```

## What's inside

| Skill | Use it when |
| --- | --- |
| `running-ephemeral-infrastructure` | writing or reviewing code that starts a container, VM, sandbox or temp database, or when a machine is filling up with old ones |

MIT.
