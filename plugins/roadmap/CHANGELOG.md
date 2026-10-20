# Roadmap changelog

## 0.1.1

- Web links on a card now show the site they really go to, such as "Spec · docs.google.com ↗". A link's name can no longer hide where it leads.
- The README now says plainly who can see the board: everyone signed in to this DorkOS, including agents and guests who can use extensions. A later version will limit that.

## 0.1.0

**First release.**

- A Roadmap tab in the right panel, read-only, laid out for a phone-width panel: what needs a decision first, then what changed, then Now, Next and Later (Later folded).
- Reads `roadmap/roadmap.json` and its commit history from one GitHub repo. Each change shows who made it and the commit subject as the reason, or "No reason given".
- A change that lands while you're looking waits behind a "moved 2 cards · Show" pill, so nothing moves under you.
- A file that stops parsing, a lost connection or an expired token keeps the last good board on screen, dimmed, under one line that says what happened.
- The decisions lane only links to where each ask is answered. It has no approve or deny buttons.
- Its server code runs in its own process and may reach api.github.com and nothing else. The token stays on this computer.
