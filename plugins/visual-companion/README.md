# Visual Companion

Show a person what you mean instead of describing it. The agent puts screens,
mockups, comparisons and clickable prototypes in a browser window beside the
chat. The person looks, clicks, leaves notes on the exact spot they want
changed, and presses **Send**. The agent gets it back and keeps going.

Made for DorkOS: screens open on the DorkOS canvas, in the DorkOS look, in light
and dark. It also works in any browser on this computer.

## What it does

- **Screens.** The agent writes a page; it appears within a second, with a
  history to step back through.
- **Pins and notes.** The person points at any part of a screen and writes what
  should change. Notes stay on the screen.
- **Send.** One button hands the notes and choices back to the agent, which wakes
  up and works on them. Nothing is sent until the person presses it.
- **Prototypes.** Clickable flows, with a director bar to walk through them and a
  review bar to collect feedback screen by screen.
- **Screenshots.** Each new screen can be captured in light and dark, so the
  agent can check its own work.

## Install

In DorkOS: **Marketplace → Visual Companion → Install**. Or from a terminal:

```bash
dorkos marketplace install visual-companion
```

It needs **Node.js 20 or later**. Nothing else to set up.

**Screenshots** need `playwright-core` and a Chromium. Without them, screens still
show; only the screenshots are skipped. To turn them on, in the package folder:

```bash
npm install
npx playwright install chromium
```

## Use it

Ask the agent to show you something: "show me two layouts for this page", "mock
up the empty state", "let me click through the signup flow". It starts the
companion, opens the screen, and tells you where to look.

## What runs on your computer

**Any page this renders can message the agent that owns it. Don't open pages you don't trust.**
It's made for one person on one machine: there are no share or guest links.

This package runs code. When the agent uses it, it starts a small local web
server written in Node (`skills/visual-companion/scripts/server.cjs`), with no
dependencies of its own.

- **This computer only.** The server listens on `127.0.0.1` (or `::1` /
  `localhost`) and refuses any other address. It also answers only requests
  addressed to `localhost`, `127.0.0.1` or `[::1]` on its own port, so a website
  can't reach it by pointing its own domain at your computer. To see it from
  another machine, forward the port, for example `ssh -L <port>:localhost:<port>`.
- **Pages from other local ports can read, but need a token to write.** A page
  served from another port on this computer can read the notes, the session
  folder's path and the id of the chat it wakes. Writing a note or pressing Send
  from there needs the token the agent created for that review. A page the
  companion itself renders needs no token, which is why the warning above matters.
- **It stops on its own** after four hours idle (`vc stop` stops it at once).
- **What it writes.** Its session folder in your project, `.dork/visual-companion/`,
  which gets a `.gitignore` so notes and screenshots stay out of your commits.
  Started by hand without a session folder (`BRAINSTORM_DIR`), the server uses
  `/tmp/brainstorm`. Rebuilding the styles (below) writes
  `skills/visual-companion/scripts/assets/`.

The package lists no tools to run without asking, so each command it runs goes
through your usual permission prompts.

## Rebuilding the styles (optional)

The DorkOS colours and stylesheet ship built, in
`skills/visual-companion/scripts/assets/`. If you work on DorkOS itself and change
its styles, rebuild them from your checkout:

```bash
skills/visual-companion/scripts/vc build --dorkos <path-to-dorkos>
```

## Developing

```bash
npm ci
npm test
```

The tests drive a real headless Chromium (about two minutes).

## License

MIT. Portions come from [superpowers](https://github.com/obra/superpowers) by
Jesse Vincent, also MIT; see `NOTICE`.
