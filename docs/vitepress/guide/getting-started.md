# Getting Started

This section covers the one-time setup in full. If you just want to see krutrimbox work first, start with the [Quickstart](./quickstart) and come back here for the details.

## What you are setting up

krutrimbox uses three layers:

1. **Your host** runs the `kb` CLI and owns every GitHub write — commits, pushes, pull requests, comments, labels.
2. **Docker Sandboxes** gives each issue an isolated Target Issue Sandbox with a private clone of your repo.
3. **The Sandboxed Agent** (Codex or Claude Code) runs inside that sandbox and implements one issue at a time.

The sandbox is intentionally separate from your host working tree. In clone mode it gets its own private Git clone, so agent changes stay away from your current branch until the outer krutrimbox commits and pushes them.

krutrimbox is **language-agnostic**: it orchestrates issues and Git/GitHub state, and the agent writes whatever language your project uses. The only host requirement tied to a language is Node.js — and that is only because the `kb` CLI is distributed on npm, not because your project must be JavaScript.

## Setup checklist

Complete these once per machine:

1. **Install the prerequisites and the CLI** — [Quickstart › Prerequisites](./quickstart#prerequisites) lists everything and the per-OS `sbx` install.
2. **[Authentication](./authentication)** — a write-capable GitHub login on the host, a read-only token for sandboxes, and your agent's credentials.
3. **[Network Policy](./network-policy)** — let sandboxes reach GitHub, package registries, and your model.
4. **[Sandbox Template](./sandbox-template)** — *optional, but usually needed:* bake your project's toolchain into the sandbox image.

Once those are done, you're ready to [run krutrimbox](./running).

## Prepare your repository

krutrimbox writes per-run state into a `.krutrimbox/` directory in your repository — log files and lock files. Add those generated subdirectories to the repository's `.gitignore` so they're never committed:

```txt
.krutrimbox/logs/
.krutrimbox/locks/
```

Everything else under `.krutrimbox/` — `config.json`, comment templates, and prompt extensions — is shared team policy that you *do* commit. See [Configuration](./configuration) for what the directory can hold.
