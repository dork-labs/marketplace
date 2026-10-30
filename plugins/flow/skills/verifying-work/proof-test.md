# The proof test

A bug fix (a `signal` item, or any change that fixes a defect) ships one **class-level
test**: it fails on the code before the fix and passes after, and it covers the whole
class of the bug, not the one input that was reported.

## Name the class

Write one sentence that names the class, not the instance. "Paths compare without case
or Unicode folding" is a class; "`APPS/Server` slips past" is an instance of it. The
test enumerates it: a table of variants, a property over the inputs, or every caller
sharing the flaw.

## Red, then green

1. **Red:** run the test on the code before the fix (write it first, or copy it into a
   scratch worktree at the merge base). Save its output. It must fail for the bug's
   reason, not a missing import.
2. **Green:** run it at the branch head. Save it too.
3. Commit the test, then record it:
   `flow proof <id> --tests <paths> --class "<the sentence>" --command "<cmd>" --red-file <f> --green-file <f>`.

flow checks each test is committed and added or changed on the branch, and that the runs
differ. It runs no test itself.

## The gate

Both hand-offs to review refuse a `signal` item without a proof at that commit (exit 5):
`flow stage <id> review`, and a drain worker's `flow report <id> pushed`. Any later
commit, a review fix included, means record it again. When no class-level test is
possible, waive it at that commit: `flow proof <id> --waive "<reason>"`.

## For the reviewer

flow puts the proof or waiver in the reviewer's brief; put a waiver's reason in the PR
body too. The reviewer runs the test at the merge base, confirms it fails, and blocks a
test covering only the reported instance, or a waiver whose reason does not hold.
