# Use a custom Codex sandbox template

The Code Factory uses a custom Docker Sandboxes template image for PRD Sandboxes instead of the stock `docker/sandbox-templates:codex` image.

The stock Codex sandbox image provides the Codex CLI, Node.js, npm, and Corepack, but it does not put this repository's required package manager, `pnpm`, directly on `PATH`. Sandboxed Agents are expected to run repository commands such as the package scripts in `package.json`, and making every agent discover or bootstrap `pnpm` during implementation would make AFK runs slower, less deterministic, and more likely to fail for environment reasons rather than product reasons.

The custom image is built from `Dockerfile.sandbox`, extends `docker/sandbox-templates:codex`, and installs `pnpm@10.23.0`. The factory creates PRD Sandboxes with `--template docker.io/library/code-factory-codex:pnpm` by default. Operators may override that image with `CODE_FACTORY_SANDBOX_TEMPLATE` when testing another template.

Docker Sandboxes does not automatically use images from the local Docker image cache. A locally built template must be saved and loaded into the Docker Sandboxes template store with `sbx template load` before `sbx create --template ...` can use it. The package scripts `sandbox:build-template`, `sandbox:load-template`, and `sandbox:prepare-template` capture that setup.

Sandboxed Codex sessions run through `codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox`. The no-approval setting is required because Code Factory runs Codex non-interactively; an approval prompt would otherwise hang or fail the AFK Issue. The bypass is scoped by the outer Docker Sandbox clone, not by the host machine, and avoids Codex's inner sandbox blocking package installs, tests, read-only GitHub inspection, or other commands the Sandboxed Agent may need.

Existing sandboxes keep the template they were created from. If the template changes, remove and recreate affected PRD Sandboxes after preserving any needed work.
