# Artifacts from the 2026-09-25/26 Maintenance drain

These are the hand-written tools that ran 15 items through 10 merged PRs, each with an independent adversarial review. They are the seed for `flow drain` and `flow watch` (step 2 of `../01-ideation.md`). The paths in them are placeholders.

- `WORKER_BRIEF.md` walks one resumable worker through claim, worktree, build, push, review fixes, PR, land and DONE.
- `REVIEWER_BRIEF.md` is for the independent reviewer, who reviews the exact pushed SHA against `REVIEW.md`.
- `watch.sh` watches PRs and exits when one merges, goes red, or leaves the merge queue.
