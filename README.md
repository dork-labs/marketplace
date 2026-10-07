# DorkOS Marketplace

The official marketplace for [DorkOS](https://dorkos.ai). DorkOS: build and run your business with an agent team.

This repo holds the packages you can add to DorkOS. Each one gives your agents something new:

- **Agents:** a ready-made agent with its own job, like reviewing pull requests.
- **Plugins:** commands, skills, hooks and extensions for your agents. The [flow](plugins/flow) workflow plugin is one.
- **Skill packs:** bundles of skills, which are written instructions that teach an agent how to do one kind of task.
- **Adapters:** bridges that let your agents send and receive messages through another service.
- **Shapes:** one install that sets up DorkOS for a job, such as working your Linear issues.

The full list, with a description of each, is in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json). Some listings are early and hold little more than a description so far.

## Install a package

DorkOS lists this marketplace by default, so there is nothing to set up.

1. Open DorkOS and click **Marketplace** in the sidebar.
2. Click a package to see what it will add and what it is allowed to do.
3. Click **Install** and confirm.

You can also install from a terminal, using the package's name:

```bash
dorkos marketplace install flow
```

The [Marketplace guide](https://dorkos.ai/docs/marketplace) covers updates, removing packages, and installing for one agent instead of all of them.

## How this repo is laid out

Each package lives in its own folder under `plugins/<name>/`, with a `README.md` that describes it. Two files at the top list every package:

- `.claude-plugin/marketplace.json` is the catalog: each package's name, folder, description and tags.
- `.claude-plugin/dorkos.json` adds what DorkOS needs on top: the package type, icon and category.

One package, `lifeos-starter`, lives in its own repository, and the catalog points to it there.

## Contributing

Changes land through a pull request. Before you open one, read:

- [`CLAUDE.md`](CLAUDE.md) for how changes land, the checks every pull request must pass, and the rule that any change to a package raises its version.
- [`REVIEW.md`](REVIEW.md) for what review looks for.

The [publishing guide](https://dorkos.ai/docs/marketplace/publishing) explains how to build and validate a package of your own. The `marketplace-dev` skill pack in this repo walks an agent through the same steps.

## License

Every package in the catalog is listed under the MIT license.
