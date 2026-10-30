# The proof test — every bug fix ships one

A bug fix (a `signal` item, or any change that fixes a defect) ships one **class-level
test**: it fails on the code before the fix and passes after, and it covers the whole
class of the bug, not the one input that was reported.

## Name the class

Write one sentence that names the class, not the instance. "Paths compare without case
or Unicode folding" is a class; "`APPS/Server` slips past" is an instance of it. The
test enumerates the class: a table of its variants, a property over its input space, or
every caller that shares the flaw. A test that only replays the report fails review.

## Red, then green

1. **Red:** run the test on the code before the fix (write it first, or run it in a
   scratch worktree at the merge base with only the test copied in). Save the output to
   a file. It must fail for the bug's reason, not a missing import.
2. **Green:** run it at the branch head. Save that output too.
3. Commit the test, then record it:
   `flow proof <id> --tests <paths> --class "<the sentence>" --command "<cmd>" --red-file <f> --green-file <f>`.

flow checks each test is committed and changed on the branch, and that the two runs
differ, then records the proof at HEAD. It runs no test itself.

## The gate

`flow stage <id> review` refuses a `signal` item without a proof recorded at the head
(exit 5). Any later commit, a review fix included, means record it again. When no
class-level test is possible, do not hand off: park the item and ask a person.

## For the reviewer

Pass the record (`.dork/flow/proof/<id>.json`) with the diff. The reviewer runs the
test at the merge base and confirms it fails, and blocks when the test covers only the
reported instance.
