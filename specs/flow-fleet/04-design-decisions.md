# Design decisions

Visual companion session, 2026-09-26. The chosen mockup is saved at [`design/account-display.html`](design/account-display.html). Open it in any browser; it uses its own inline styles.

## 1. Showing which Claude account a session is on (DorkOS)

**Problem:** today the account only appears in a tooltip on the runtime chip, so it's hard to tell which account a session is spending.

**Options:**

- **A.** A new account chip in the status bar.
- **B.** The account name folded into the runtime chip.
- **C.** A's chip, plus a color dot on every session in the sidebar and a name badge in the session header.

**Chosen: C**, with one rule from the operator: **it only appears when more than one Claude Code account is configured.** With one account, nothing new shows and the UI stays as it is today.

## Final design (for implementers)

**When it shows:** `runtimes.claudeCode.accounts` has 2 or more entries, and the session's runtime is Claude Code. Otherwise, render nothing new.

**Account identity:**

- Each account gets a **short name** (its existing `label`) and a **color**.
- The color is chosen in Settings → Runtimes, with a stable default picked from a small fixed palette by position.
- Colors are used only as small dots or badges, never as backgrounds for large areas.

**1. Status-bar account chip** (next to the runtime chip)

- Content: the color dot, the account name, and two tiny vertical bars (5-hour window, then weekly window) filled to their used percentage.
- **Near a limit** (the account reports `allowed_warning`, or any window at 90% or more): an amber chip whose text names the window, e.g. "Acct 3 · 91% of week".
- **Out** (`rejected`): a red chip naming the reset, e.g. "Acct 4 · out until Tue 3pm".
- **Click → popover:**
  - the account name and plan type
  - one row per window with its percentage, a bar, and a local reset time
  - the tracker item the session serves, if any, and whether the session started on this account
  - a **"Continue on another account →"** action (checkpoint, then a new session on the best eligible account, in the same worktree)
- **Before launch** (the account is still a hint): the chip is the existing account picker, restyled to match.

**2. Sidebar session rows:** a color dot at the start of every Claude Code session row. A session whose account is out gets a soft red row tint and the state text "out · handing off" (or "out · waiting for reset" when handoff is set to `ask`).

**3. Session header:** a small outlined badge after the title, with the dot and the account name.

**Data it needs:**

- the session's account, which the session list already has
- the per-account usage store (spec §6.1): each window's `usedPct` and `resetsAt`, plus its status
- the session's tracker link (spec §6.7)

**Accessibility:**

- Color is never the only signal. The account name is always in the chip and the header badge, and each sidebar dot carries the account name as its accessible label and tooltip.
- Amber and red states also say what happened in words.
