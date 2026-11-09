# app-builder-pack

One skill, `building-dorkos-apps`, for any DorkOS agent asked to build a small app
(a DorkOS extension) for the person it works with.

It covers:

- scaffolding with `create_extension` and picking the smallest template
- checking the build with `test_extension`
- reading `serverStatus` and the log after install, because "compiled" isn't "started"
- telling the person, in plain words, what the app can reach before they allow it
- least privilege: no network, connections, secrets or agent tools unless the request names them
- the person's approval for the first run, every file change and every widened reach

Files:

- `skills/building-dorkos-apps/SKILL.md`: the workflow
- `skills/building-dorkos-apps/pitfalls.md`: mistakes that pass tests and fail in DorkOS
- `skills/building-dorkos-apps/example.md`: a worked example, scaffold to test

The pack runs nothing and holds no keys. It's instructions only.
