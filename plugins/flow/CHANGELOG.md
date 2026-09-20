# /flow changelog

Installs of this plugin are pinned to a commit SHA, so a fix here does not reach
you until you **reinstall it** (Marketplace → flow → reinstall, or re-run your
`--plugin-dir` checkout's `git pull`). Each entry below says whether that matters.

## 0.7.1

**Fixes a bug that could trap every session in a repo. Reinstall is recommended.**

- A `/flow auto` drain that died without cleaning up left its `auto-run.json`
  behind still saying `active: true`. The Stop hook trusted it, so every later
  session in that repo — doing entirely unrelated work — got the "DRAINING THE
  READY QUEUE" banner on every single Stop, forever. The hook now checks whether
  the drain's process is actually still running, and deletes the leftover file
  when it is not. A drain that has claimed to be running for more than 24 hours
  is treated the same way, because by then its process number may belong to
  something else entirely.
- The banner told you to output `<promise>ABORT</promise>` to stop, but that was
  a message to the agent while the hook was reading the file, so the banner came
  straight back. `ABORT` (and `PHASE_COMPLETE`) now delete the file too. The
  advertised way out is the real way out.
- A drain you paused on purpose (`/flow:pause`) is never deleted, so
  `/flow:resume` still finds it.

DOR-1679.
