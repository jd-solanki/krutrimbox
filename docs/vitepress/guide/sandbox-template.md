# Sandbox Template

Sandbox templates are **optional** — but most projects need one.

Docker Sandboxes ships a default image per agent that includes the agent CLI and Node.js. That is enough only if your project builds and tests with nothing more than those tools. The moment your project needs something else — `pnpm`, `uv` for Python, the Go toolchain, a system package — the agent won't find it inside the sandbox, and the run fails at an environment step instead of on the actual issue.

A custom template fixes that: bake your project's toolchain into an image once, and every fresh Target Issue Sandbox starts with the same tools on `PATH`.

::: tip krutrimbox's own example
The krutrimbox repository is a `pnpm` project, and `pnpm` isn't in the default image — so krutrimbox ships a `pnpm` template as its example. The files and scripts below are that example. Use them as a model and swap in whatever **your** project needs.
:::

## Build a template

A template is just the agent's stock image plus your tools. Here is the example krutrimbox uses (`Dockerfile.sandbox`). The `BASE` build argument selects the agent's stock image, and the `RUN` line is where you add your toolchain:

```Dockerfile
# check=skip=InvalidDefaultArgInFrom
ARG BASE
FROM ${BASE}

USER root
RUN npm install -g pnpm@10.23.0   # 👈 replace with your project's tooling
USER agent
```

`BASE` selects the agent's stock template:

- `docker/sandbox-templates:codex` — for `--agent codex`
- `docker/sandbox-templates:claude-code` — for `--agent claude`

Build the image, then load it into Docker Sandboxes' own template store. A plain `docker build` is not enough: `sbx` keeps a separate store, so `sbx template load` is what makes the image available to `sbx create --template`.

```sh
# Example for the codex agent — repeat with the claude-code BASE for --agent claude
docker build -f Dockerfile.sandbox --build-arg BASE=docker/sandbox-templates:codex -t my-template:codex .
docker image save my-template:codex -o /tmp/my-template-codex.tar
sbx template load /tmp/my-template-codex.tar
```

Verify the image is loaded:

```sh
sbx template ls
```

Rebuild and reload whenever your `Dockerfile.sandbox` changes.

::: tip
In the krutrimbox repository these three steps are wrapped as `pnpm sandbox:prepare-template:codex` / `:claude` (or `pnpm sandbox:prepare-template` for both). Those scripts are specific to krutrimbox's own repo — for your project, run the commands above or wrap them in your own scripts.
:::

## Point krutrimbox at your template

By default krutrimbox derives the template name from the agent:

```text
docker.io/library/krutrimbox-codex:pnpm     # --agent codex
docker.io/library/krutrimbox-claude:pnpm    # --agent claude
```

If you named your image something else (recommended for your own project), set `KRUTRIMBOX_SANDBOX_TEMPLATE` to override the resolved image for any agent:

```sh
KRUTRIMBOX_SANDBOX_TEMPLATE=my-template:codex kb run --issue 1 --agent codex
```

## Smoke test

Optional, but worth doing once: create a throwaway sandbox and confirm your tools are present before a full run.

```sh
sbx create --clone --template my-template:codex --name krutrimbox-smoke codex "$(pwd)"

sbx exec -w "$(pwd)" krutrimbox-smoke -- git status --short --branch   # a valid Git repo
sbx exec -w "$(pwd)" krutrimbox-smoke -- gh auth status               # authenticated reader
sbx exec -w "$(pwd)" krutrimbox-smoke -- pnpm --version               # 👈 your tool

sbx rm --force krutrimbox-smoke
```

## Workspace path

krutrimbox passes the absolute repository path to both `sbx create` and `sbx exec --workdir`.

Clone-mode sandboxes expose the private repository clone at the original host path inside the sandbox. A plain `sbx exec <sandbox> -- git status` starts in Docker Sandboxes' default directory, which may not be a Git repository. Use this shape when debugging manually:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
```

See [Troubleshooting](./troubleshooting) for replacing existing sandboxes after template or credential changes.
