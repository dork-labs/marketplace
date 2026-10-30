# The proof test

A bug fix (a `signal` item, or any change that fixes a defect) ships one **class-level
test**: it fails on the code before the fix and passes after, and it covers the whole
class of the bug, not the one input that was reported.

## Name the class

Write one sentence that names the class, not the instance. "Paths compare without case
or Unicode folding" is a class; "`APPS/Server` slips past" is an instance of it. The
test enumerates the class: a table of its variants, a property over its input space, or
every caller that shares the flaw. A test that only replays the report fails review.

## Red, then green

1. **Red:** run the test on the code before the fix (write it first, or copy it into a
   scratch worktree at the merge base). Save its output. It must fail for the bug's
   reason, not a missing import.
2. **Green:** run it at the branch head. Save it too.
3. Commit the test, then record it:
   `flow proof <id> --tests <paths> --class "<the sentence>" --command "<cmd>" --red-file <f> --green-file <f>`.

flow checks each test is committed and added or changed on the branch, and that the two
runs differ, then records the proof at HEAD. It runs no test itself.

## The gate

Both hand-offs to review refuse a `signal` item without a proof at that commit (exit 5):
`flow stage <id> review`, and a drain worker's `flow report <id> pushed`. Any later
commit, a review fix included, means record it again. When no class-level test is
possible, do not hand off: park the item and ask a person.

## For the reviewer

Pass the record (`.dork/flow/proof/<id>.json`) with the diff. The reviewer runs the
test at the merge base, confirms it fails, and blocks a test that covers only the
reported instance.
