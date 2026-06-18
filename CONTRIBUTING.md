# Contributing to krutrimbox

Thanks for your interest in improving krutrimbox! This guide covers local development. For usage, see the [documentation site](https://krutrimbox.pages.dev).

## Prerequisites

- Node.js 20 or newer
- pnpm 10.23.0 or newer

A full krutrimbox run also needs Docker, the Docker Sandboxes CLI (`sbx`), and the GitHub CLI (`gh`) — see [Getting Started](https://krutrimbox.pages.dev/guide/getting-started). You don't need those to build and run the test suite.

## Set up from source

```sh
git clone https://github.com/jd-solanki/krutrimbox.git
cd krutrimbox
pnpm install
pnpm build
```

Check that the project is healthy:

```sh
pnpm typecheck
pnpm test
```

To use your local checkout as the global `kb` binary:

```sh
pnpm build
pnpm pkg:link     # `pnpm pkg:unlink` to remove
```

When running from a clone instead of the installed binary, `pnpm start run …` is equivalent to `kb run …`.

## Project layout

```text
src/
  index.ts                 # CLI entry (Commander)
  commands/                # CLI commands (e.g. run)
  lib/github.ts            # GitHub CLI integration
  lib/factory/             # the orchestration loop
  assets/templates/        # built-in comment / PR-body templates
  assets/prompts/          # built-in Sandboxed Agent prompts
tests/                     # vitest suites
docs/
  vitepress/               # the public documentation site
  adr/                     # Architecture Decision Records
CONTEXT.md                 # domain language / glossary
Dockerfile.sandbox         # parameterized custom sandbox template
```

## Documentation site

The public site is a [VitePress](https://vitepress.dev) project under `docs/vitepress/`.

```sh
pnpm docs:dev       # local dev server with hot reload
pnpm docs:build     # production build (also catches dead links)
pnpm docs:preview   # preview the production build
```

User-facing docs belong on the site (`docs/vitepress/guide/` and `docs/vitepress/concepts/`). Keep `README.md` minimal — it should point at the site, not duplicate it.

## Decisions and domain language

Two files capture the project's thinking, and several authoring skills read them at these fixed paths — keep them where they are:

- **`CONTEXT.md`** — the canonical domain vocabulary. Use these terms (Target Issue, Sandboxed Agent, Done Set, …) consistently in code, tests, and docs.
- **`docs/adr/`** — Architecture Decision Records. When you make a decision that changes how krutrimbox behaves, add a new numbered ADR rather than silently altering an existing one.

## Commits and pull requests

- Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, …). krutrimbox itself reuses issue titles as commit subjects, so the convention is load-bearing.
- Reference the issue a change closes with a `Closes #<number>` footer.
- Run `pnpm typecheck` and `pnpm test` before opening a pull request.
