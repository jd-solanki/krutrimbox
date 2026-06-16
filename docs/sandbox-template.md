# Sandbox Template Setup

krutrimbox Target Issue Sandboxes use Docker Sandboxes clone mode and a custom template image per Agent Backend.

## Why this exists

Docker's stock agent sandbox templates include the agent CLI and Node.js tooling, but this repository expects `pnpm` to be available for package scripts. During debugging, the factory reached the Sandboxed Agent step successfully, but the sandbox environment did not have `pnpm` on `PATH`. That made the next failure an environment bootstrap problem rather than an implementation problem.

The custom template keeps AFK Issue runs deterministic: each fresh Sandboxed Agent session starts with the same toolchain surface, and the agent can focus on the issue instead of installing project tooling.

## Template Image

A single parameterized `Dockerfile.sandbox` builds one image per Agent Backend. The `BASE` build argument selects the agent's stock template; the `pnpm` layer is identical for every agent, so it lives in one place. `BASE` is **required** and has no default — mirroring the required `--agent` flag, so a bare `docker build` can never silently produce the wrong agent image (an unset `BASE` fails at parse time). Always build through the `sandbox:prepare-template:<agent>` scripts:

```Dockerfile
# check=skip=InvalidDefaultArgInFrom
ARG BASE
FROM ${BASE}

USER root
RUN npm install -g pnpm@10.23.0

USER agent
```

The factory default template is derived from the run's Agent Backend:

```text
docker.io/library/krutrimbox-codex:pnpm     # --agent codex
docker.io/library/krutrimbox-claude:pnpm    # --agent claude
```

Override the resolved image for experiments with `KRUTRIMBOX_SANDBOX_TEMPLATE` (applies regardless of agent):

```sh
KRUTRIMBOX_SANDBOX_TEMPLATE=<image-ref> nr start run --issue <number> --agent codex
```

## Preparing a Machine

Run this once per machine for each agent you use, and rerun it whenever `Dockerfile.sandbox` changes:

```sh
pnpm sandbox:prepare-template:codex
pnpm sandbox:prepare-template:claude
# or both:
pnpm sandbox:prepare-template
```

Each per-agent script does two things, for example for Codex:

```sh
docker build -f Dockerfile.sandbox --build-arg BASE=docker/sandbox-templates:codex -t krutrimbox-codex:pnpm .
docker image save krutrimbox-codex:pnpm -o /tmp/krutrimbox-codex-pnpm.tar
sbx template load /tmp/krutrimbox-codex-pnpm.tar
```

The `sbx template load` step matters. Docker Sandboxes has its own template image store, so a successful `docker build` alone does not make the image available to `sbx create --template`.

Verify the loaded templates:

```sh
sbx template ls
```

The loaded images should appear as:

```text
docker.io/library/krutrimbox-codex    pnpm
docker.io/library/krutrimbox-claude   pnpm
```

## Existing Sandboxes

Existing Target Issue Sandboxes keep the template they were created from. If a Target Issue Sandbox was created before this template was loaded, it will not gain `pnpm` automatically.

Before replacing a sandbox, inspect it for uncommitted work:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
```

If there is no work to preserve, recreate it from the new template:

```sh
sbx rm --force krutrimbox-issue-<number>-<agent>
nr start run --issue <number>
```

The factory will create the replacement sandbox with the configured template.

## Workspace Path

The factory passes the absolute repository path to both `sbx create` and `sbx exec --workdir`.

Clone-mode sandboxes expose the private repository clone at the original host path inside the sandbox. A plain `sbx exec <sandbox> -- git status` starts in Docker Sandboxes' default directory, which may not be a Git repository. Use this shape when debugging manually:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
```
