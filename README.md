# Krutrimbox

> A code factory for agent-ready GitHub issues.

Krutrimbox is a local orchestrator. It discovers Target Issues labeled `ready-for-agent` that have no parent issue, implements standalone Target Issues directly or walks their ordered sub-issues, delegates AFK work to fresh Sandboxed Agent sessions (Codex or Claude Code) inside Docker Sandboxes, pauses for human work when needed, and keeps the outer process in charge of GitHub state, commits, pushes, and pull requests.

The sandbox only ever **reads** GitHub. All writes happen on the host with your credential, so a stray agent can never mutate GitHub state — that read-only boundary is krutrimbox's core safety property.

## Documentation

**Full documentation lives at [krutrimbox.pages.dev](https://krutrimbox.pages.dev).**

- [Getting Started](https://krutrimbox.pages.dev/guide/getting-started) — prerequisites, install, and one-time setup
- [Running krutrimbox](https://krutrimbox.pages.dev/guide/running) — day-to-day usage
- [Factory Flow](https://krutrimbox.pages.dev/concepts/factory-flow) — how a run works end to end

## Quick install

```sh
npm install --global krutrimbox
kb --help
```

Then follow [Getting Started](https://krutrimbox.pages.dev/guide/getting-started) to authenticate GitHub and your agent, set the sandbox network policy, and build the sandbox template.

```sh
kb run --issue 1 --agent codex   # one explicit Target Issue
kb run --agent claude            # batch mode, all eligible issues
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local development, building, testing, and how the project's decisions are recorded.
