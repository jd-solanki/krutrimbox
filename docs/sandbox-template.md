# Sandbox Template Setup

Code Factory PRD Sandboxes use Docker Sandboxes clone mode and a custom Codex template image.

## Why this exists

Docker's stock Codex sandbox template includes the Codex CLI and Node.js tooling, but this repository expects `pnpm` to be available for package scripts. During debugging, the factory reached the Sandboxed Agent step successfully, but the sandbox environment did not have `pnpm` on `PATH`. That made the next failure an environment bootstrap problem rather than an implementation problem.

The custom template keeps AFK Issue runs deterministic: each fresh Codex session starts with the same toolchain surface, and the Sandboxed Agent can focus on the issue instead of installing project tooling.

## Template Image

The template is defined in `Dockerfile.sandbox`:

```Dockerfile
FROM docker/sandbox-templates:codex

USER root
RUN npm install -g pnpm@10.23.0

USER agent
```

The factory default template is:

```text
docker.io/library/code-factory-codex:pnpm
```

Override it for experiments with:

```sh
CODE_FACTORY_SANDBOX_TEMPLATE=<image-ref> nr start run --prd <number>
```

## Preparing a Machine

Run this once per machine, and rerun it whenever `Dockerfile.sandbox` changes:

```sh
pnpm sandbox:prepare-template
```

That script does two things:

```sh
docker build -f Dockerfile.sandbox -t code-factory-codex:pnpm .
docker image save code-factory-codex:pnpm -o /tmp/code-factory-codex-pnpm.tar
sbx template load /tmp/code-factory-codex-pnpm.tar
```

The `sbx template load` step matters. Docker Sandboxes has its own template image store, so a successful `docker build` alone does not make the image available to `sbx create --template`.

Verify the loaded template:

```sh
sbx template ls
```

The loaded image should appear as:

```text
docker.io/library/code-factory-codex   pnpm
```

## Existing Sandboxes

Existing PRD Sandboxes keep the template they were created from. If a PRD Sandbox was created before this template was loaded, it will not gain `pnpm` automatically.

Before replacing a sandbox, inspect it for uncommitted work:

```sh
sbx exec -w "$(pwd)" code-factory-prd-<number> -- git status --short --branch
```

If there is no work to preserve, recreate it from the new template:

```sh
sbx rm --force code-factory-prd-<number>
nr start run --prd <number>
```

The factory will create the replacement sandbox with the configured template.

## Workspace Path

The factory passes the absolute repository path to both `sbx create` and `sbx exec --workdir`.

Clone-mode sandboxes expose the private repository clone at the original host path inside the sandbox. A plain `sbx exec <sandbox> -- git status` starts in Docker Sandboxes' default directory, which may not be a Git repository. Use this shape when debugging manually:

```sh
sbx exec -w "$(pwd)" code-factory-prd-<number> -- git status --short --branch
```
