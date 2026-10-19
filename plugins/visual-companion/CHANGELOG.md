# Visual Companion changelog

## 0.1.0

**First release in the DorkOS marketplace.**

- Screens, mockups and clickable prototypes in a browser window beside the chat, on the DorkOS canvas, in light and dark.
- Pins and notes on any part of a screen, and a Send button that hands them back to the agent.
- A director bar to walk through a prototype and a review bar to collect feedback screen by screen.
- Screenshots of each new screen in light and dark, when `playwright-core` and a Chromium are installed.
- The local server listens on this computer only, refuses any other address, and answers only requests addressed to this computer (so a website can't reach it through DNS rebinding).
- A malformed request or an oversized websocket frame is refused without stopping the server, and pages on other local ports can read only notes and review status.
- The session folder gets a `.gitignore`, so notes and screenshots stay out of your commits.
- The DorkOS colours and stylesheet ship built, so it works outside a DorkOS checkout.
