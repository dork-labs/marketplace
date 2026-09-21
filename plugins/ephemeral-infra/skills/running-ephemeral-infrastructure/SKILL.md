---
name: running-ephemeral-infrastructure
description: 'Starting and cleaning up throwaway infrastructure from a script or test: Docker containers, volumes and networks, VMs, cloud sandboxes, temp databases, emulators. Use when writing or reviewing code that creates one of those, or when a machine is running out of disk and old containers or sandboxes are piling up.'
---

# Running ephemeral infrastructure

One rule holds this whole skill up:

> Cleanup that depends on your process exiting is not cleanup. Label what you create, and sweep at the start of the next run.

## Why the obvious approach fails

The usual shape looks correct:

```bash
trap cleanup EXIT
docker run -d --name "$db" postgres:17-alpine
```

It leaks anyway, because `trap ... EXIT` does not run on `SIGKILL`. Nothing does. And on a machine running several agents at once, kills are ordinary, not exceptional:

- the OS kills the biggest process under memory pressure
- a watchdog kills a run that stalled
- the harness reaps an agent when its turn ends
- someone closes the terminal

A detached container is worse than a leaked temp file, because it **outlives the thing that started it**. The parent dies; the container keeps running, holding its data directory.

Measured, real: one repo reached **1,025 orphaned volumes and 110.6 GB** of Postgres data directories, from a script whose cleanup was written correctly. That is roughly 1,025 runs that did not exit cleanly.

The same hole exists for a cloud sandbox left running, a VM snapshot nobody deletes, an emulator that outlives its test, and a temp schema in a shared database.

## The shape that works

**1. Never create anonymous resources.** An anonymous Docker volume carries no labels, belongs to nobody, and can never be reclaimed by owner. Name it, and if the image declares a `VOLUME`, mount your named one over that path so no anonymous one is minted.

**2. Stamp everything you create** with three things:

| Stamp | Why |
| --- | --- |
| a marker label | so a sweep is exact, not a name-prefix guess |
| the creating process id **and its start time** | so a later run can ask "is the owner still alive?" |
| a creation timestamp | the fallback when ownership is unknowable |

The start time is what makes the pid trustworthy. Process ids get recycled, and a live process wearing a dead run's number must not inherit its resources. Compare the start-time **string** from the same command at stamp time and at check time, and you never write a date parser.

**3. Sweep at the START of every run, not only at the end.** A later run is the only actor that can clean up after a kill. Your own exit handler stays, for the normal case.

**4. Decide by ownership, then age.**

```
owner process gone    -> orphan. Remove it, however young.
owner process alive   -> in use. Leave it, however old.
owner unknowable      -> remove once older than a generous floor.
```

Age alone is wrong in both directions. It waits out the floor before reclaiming a plainly dead run, and it eventually kills a slow live one mid-test. Ownership answers both correctly, and age stays only for the cases ownership cannot reach, such as a resource created from a different Docker context or by another user, which has no local process to ask about.

**5. Never reuse one deterministic name per project or per checkout.** It is tempting, because it bounds growth to one resource. It also breaks the moment two suites run at once in the same checkout, and it lets one run inherit another's half-written database. Keep names unique; fix the lifecycle instead.

**6. A sweep must never fail its caller.** No daemon, no permission, nothing to sweep: exit clean and say nothing. Whoever called you is about to need that daemon and will report its absence far better than you can. A line of output on every run also trains the eye to skip the line that matters.

## Writing the sweep safely

A sweep is the rare piece of infrastructure code whose failure mode is **deleting something**, not missing something. Bias every unknown toward keeping.

- **If you cannot read a resource's labels, keep it.** Treat a failed inspect as "unknown", never as "unstamped, therefore old, therefore delete".
- **Know where labels actually live.** In Docker they are under `.Config.Labels` for a container but at the top level for a volume or a network. Read the wrong path and every resource looks unstamped, which an age fallback turns into "delete everything". This exact bug shipped in a first draft and was caught by a real smoke test, not by fixtures.
- **Remove in dependency order**: containers first, then the volumes and networks they held.
- **Make the age floor generous and configurable.** A slow suite on a loaded machine is the thing you must not outrun. Two hours is a reasonable default.

## Testing it

Fixtures must pin the **keep** side at least as hard as the sweep side. A sweep that deletes nothing costs disk; a sweep that deletes too much costs someone's running test.

Cover, at minimum:

- a dead owner's resource is reclaimed even when it is seconds old
- a live owner's resource survives even when it is a day old
- a recycled pid does not shield a dead run's resources
- an unreadable resource is kept
- the stamp a creator writes reads back as alive (the round trip)

Stub the infrastructure command so the fixtures need no daemon, but **do not stub the liveness check** — it is the whole point, and a stubbed one only proves the stub agrees with itself. Model the label paths per resource kind in the stub, or it cannot catch the most dangerous bug in the file.

Then mutate the real script and confirm the fixtures go red. A green suite against a broken sweep is worse than no suite.

## One trap that is not about cleanup

Stamping with your own script's process id, when a caller invoked you to get the stamps, marks everything as owned by a process that exits the same instant. The next sweep reads every live run as an orphan and deletes it. The owner is always the **caller's** pid, passed in explicitly.

## Reviewing someone else's code

Ask four questions:

1. What happens to this resource if the process is `SIGKILL`ed right here?
2. Is it labelled well enough for a stranger to reclaim it correctly?
3. Does anything ever run that reclaim, or is it only ever the exit path?
4. If the sweep gets its labels wrong, does it leak or does it delete?

If the answer to the last one is "delete", that is the bug to fix first.
