# Use a custom per-agent sandbox template

krutrimbox uses a custom Docker Sandboxes template image for Target Issue Sandboxes instead of the stock `docker/sandbox-templates:<agent>` image, one custom image per Agent Backend.

The stock agent sandbox images provide the agent CLI, Node.js, npm, and Corepack, but they do not put this repository's required package manager, `pnpm`, directly on `PATH`. Sandboxed Agents are expected to run repository commands such as the package scripts in `package.json`, and making every agent discover or bootstrap `pnpm` during implementation would make AFK runs slower, less deterministic, and more likely to fail for environment reasons rather than product reasons.

The custom images are built from a single parameterized `Dockerfile.sandbox` whose `BASE` build argument selects the agent's stock template, and each installs `pnpm@10.23.0`. `BASE` is required and has no default — mirroring the required `--agent` flag (ADR-0016) so a bare `docker build` cannot silently produce a Codex image for a Claude run; an unset `BASE` fails at parse time. The default template for each Agent Backend is `docker.io/library/krutrimbox-codex:pnpm` (`BASE=docker/sandbox-templates:codex`) and `docker.io/library/krutrimbox-claude:pnpm` (`BASE=docker/sandbox-templates:claude`). Operators may override the resolved image with `KRUTRIMBOX_SANDBOX_TEMPLATE` when testing another template. (If a stock agent image already ships `pnpm`, that agent can default to the stock image and skip the custom build.)

Docker Sandboxes does not automatically use images from the local Docker image cache. A locally built template must be saved and loaded into the Docker Sandboxes template store with `sbx template load` before `sbx create --template ...` can use it. The package scripts `sandbox:build-template`, `sandbox:load-template`, and `sandbox:prepare-template` capture that setup.

Sandboxed Codex sessions run through `codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox`. The no-approval setting is required because krutrimbox runs Codex non-interactively; an approval prompt would otherwise hang or fail the AFK Issue. The bypass is scoped by the outer Docker Sandbox clone, not by the host machine, and avoids Codex's inner sandbox blocking package installs, tests, read-only GitHub inspection, or other commands the Sandboxed Agent may need.

Existing sandboxes keep the template they were created from. If the template changes, remove and recreate affected Target Issue Sandboxes after preserving any needed work.
