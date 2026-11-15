# MiniApp Builder

An agent that builds and maintains your team's mini apps inside DorkOS. Give it
an agreed spec; it builds in small phases, shows what works and keeps a learnings log.

Requires **App Builder Pack ^1.0.0**, which supplies the `building-dorkos-apps`
workflow. This package adds the agent's charter and personality; it ships no skills.

A person approves every app it builds, every later change and any extra access.
Public actions also wait for your security reviewer. The agent never posts or
publishes on external platforms itself, and leaves platform repos to their owner.
