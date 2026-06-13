# Code Factory

Code Factory is a local orchestrator for GitHub PRDs and their ordered implementation issues. It finds a ready PRD, walks its implementation sequence, delegates AFK work to fresh Codex sessions inside Docker Sandboxes, pauses for human work when needed, and keeps the outer process in charge of GitHub state, commits, pushes, and pull requests.

This README is written for a new machine setup. It assumes you are comfortable copying terminal commands, but not necessarily familiar with Docker Sandboxes yet.

## What You Are Setting Up

Code Factory uses three layers:

1. Your host machine runs the `kb` Node.js CLI from the `krutrimbox` package.
2. Docker Sandboxes creates an isolated PRD Sandbox for agent work.
3. Codex runs inside that sandbox to implement one AFK issue at a time.

The sandbox is intentionally separate from your host working tree. In Docker Sandboxes clone mode, the sandbox gets its own private Git clone. That keeps agent changes away from your current local branch until the outer Code Factory commits and pushes them.

## Prerequisites

Install these before running Code Factory:

- Git
- GitHub CLI, `gh`
- Node.js 20 or newer
- pnpm 10.23.0 or newer
- Docker Desktop or a working Docker Engine
- Docker Sandboxes CLI, `sbx`
- OpenAI/Codex authentication for Docker Sandboxes

On macOS, Docker Sandboxes can be installed with Homebrew:

```sh
brew install docker/tap/sbx
```

On Ubuntu Linux, Docker documents this path:

```sh
curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh
sudo apt-get install docker-sbx
```

After installing `sbx`, sign in:

```sh
sbx login
```

That opens a browser sign-in flow. Docker Sandboxes also prompts for a default network policy on first setup.

## Clone And Install

Clone the repository and install dependencies:

```sh
git clone https://github.com/jd-solanki/krutrimbox.git
cd krutrimbox
pnpm install
pnpm build
```

Check that the local project is healthy:

```sh
pnpm typecheck
pnpm test
```

## Authenticate GitHub For Host And Sandboxes

Code Factory shells out to `gh` for GitHub state and mutations. Make sure `gh` is logged in and points at the right account:

```sh
gh auth status
```

If needed:

```sh
gh auth login
```

The account must be able to read issues, create/edit pull requests, push branches, comment on issues/PRs, and close implementation issues in the target repository.

Docker Sandboxes do not automatically inherit your host GitHub CLI login. Store the host `gh` token as Docker's built-in `github` sandbox secret so `gh` and HTTPS GitHub requests can authenticate inside newly created sandboxes:

```sh
echo "$(gh auth token)" | sbx secret set -g github
```

The `-g` flag stores the secret globally for future sandboxes. Existing sandboxes do not receive newly created or changed global secrets; recreate them after setting the secret, or scope the secret to a specific running sandbox:

```sh
echo "$(gh auth token)" | sbx secret set krutrimbox-prd-1 github
```

## Configure Docker Sandboxes Network Policy

Sandboxes need network access for things like GitHub, package registries, and model/tool calls.

For a non-interactive setup, set the default policy before creating sandboxes:

```sh
sbx policy set-default balanced
```

`balanced` is Docker's recommended starting point. It allows common development services and blocks everything else by default.

Other choices:

```sh
sbx policy set-default allow-all
sbx policy set-default deny-all
```

Use `allow-all` only if you intentionally want unrestricted outbound network access from sandboxes. Use `deny-all` only if you are prepared to add explicit allow rules.

You can inspect network policy activity with:

```sh
sbx policy log
```

## Prepare The Code Factory Sandbox Template

Docker's stock Codex sandbox image includes Codex and Node.js tooling, but this repository expects `pnpm` to be available directly inside the sandbox. We use a custom Docker Sandboxes template so every fresh PRD Sandbox has the same toolchain.

The template is defined in `Dockerfile.sandbox` and installs `pnpm@10.23.0` on top of Docker's Codex sandbox template.

Run this once per machine:

```sh
pnpm sandbox:prepare-template
```

That script runs:

```sh
docker build -f Dockerfile.sandbox -t krutrimbox-codex:pnpm .
docker image save krutrimbox-codex:pnpm -o /tmp/krutrimbox-codex-pnpm.tar
sbx template load /tmp/krutrimbox-codex-pnpm.tar
```

The `sbx template load` step is important. Docker Sandboxes has its own template image store. A successful `docker build` alone does not make the image available to `sbx create --template`.

Verify that Docker Sandboxes can see the template:

```sh
sbx template ls
```

You should see an entry like:

```text
docker.io/library/krutrimbox-codex   pnpm
```

## First Sandbox Smoke Test

Before running the full factory, create a small test sandbox:

```sh
sbx create --clone \
  --template docker.io/library/krutrimbox-codex:pnpm \
  --name krutrimbox-smoke \
  codex \
  "$(pwd)"
```

Check that the repository, GitHub CLI, Codex, and pnpm work inside it:

```sh
sbx exec -w "$(pwd)" krutrimbox-smoke -- git status --short --branch
sbx exec -w "$(pwd)" krutrimbox-smoke -- gh auth status
sbx exec -w "$(pwd)" krutrimbox-smoke -- gh issue list --limit 1
sbx exec -w "$(pwd)" krutrimbox-smoke -- codex --version
sbx exec -w "$(pwd)" krutrimbox-smoke -- pnpm --version
```

You should see:

- A valid Git branch/status.
- An authenticated `gh` session that can read repository issues.
- A Codex CLI version.
- `10.23.0` for pnpm.

Remove the smoke sandbox:

```sh
sbx rm --force krutrimbox-smoke
```

## Run Code Factory

Run one explicit PRD:

```sh
pnpm start run --prd 1
```

If you use an alias such as `nr`, this is equivalent:

```sh
nr start run --prd 1
```

Run batch mode for all eligible ready PRDs:

```sh
pnpm start run
```

Once the package is installed globally (`npm i -g krutrimbox`), the same commands are available through the `kb` binary from any repository:

```sh
kb run --prd 1
kb run
```

Code Factory currently processes only Factory-Owned PRDs authored by `jd-solanki`.

## Existing Sandboxes After Auth Or Template Changes

Existing sandboxes keep the template and global secrets they were created with. If you created a PRD Sandbox before preparing the `pnpm` template or before setting the global `github` secret, that old sandbox will not automatically gain the missing tool or credential.

List existing sandboxes:

```sh
sbx ls
```

Check an existing PRD Sandbox:

```sh
sbx exec -w "$(pwd)" krutrimbox-prd-1 -- pnpm --version
sbx exec -w "$(pwd)" krutrimbox-prd-1 -- gh auth status
```

If `pnpm` is not found or `gh` is not authenticated, inspect for uncommitted work first:

```sh
sbx exec -w "$(pwd)" krutrimbox-prd-1 -- git status --short --branch
```

If there is no work to preserve, remove the old sandbox:

```sh
sbx rm --force krutrimbox-prd-1
```

The next factory run will recreate it with the configured template and current global secrets.

## Why Commands Use `-w "$(pwd)"`

In clone mode, Docker Sandboxes exposes the private repository clone at the original host repository path inside the sandbox.

This works:

```sh
sbx exec -w "$(pwd)" krutrimbox-prd-1 -- git status --short --branch
```

This may fail:

```sh
sbx exec krutrimbox-prd-1 -- git status --short --branch
```

Without `-w`, `sbx exec` can start in a default directory that is not a Git repository. Code Factory handles this internally by resolving the host repository path and passing it to `sbx exec --workdir`.

## How Inner Codex Runs Are Authorized

Code Factory launches sandboxed Codex sessions with explicit non-interactive flags:

```sh
codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox "<prompt>"
```

This is intentional. The Codex process is already running inside a Docker Sandbox private clone, so Docker Sandboxes is the outer isolation boundary. The inner Codex process must not pause for approval prompts because no human is attached to the AFK Issue session.

These flags prevent Codex approval prompts. They do not answer ordinary command prompts from tools such as `git`, package managers, or auth flows. That is why the machine setup, GitHub auth, Docker Sandboxes auth, network policy, and custom `pnpm` template all need to be prepared before running the factory.

## Troubleshooting

### `ERROR: default network policy has not been configured`

Set a default policy:

```sh
sbx policy set-default balanced
```

Then rerun the factory.

### `fatal: not a git repository`

When debugging manually, include the sandbox workdir:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
```

The factory does this automatically. If you still see this from the factory, rebuild the CLI:

```sh
pnpm build
```

### `executable file pnpm not found`

Prepare and load the custom sandbox template:

```sh
pnpm sandbox:prepare-template
```

Then recreate any old PRD Sandbox that was created before the template was available:

```sh
sbx rm --force krutrimbox-prd-<number>
```

### `pull failed for image "krutrimbox-codex:pnpm"`

The image was built in Docker but not loaded into Docker Sandboxes' template store. Run:

```sh
pnpm sandbox:load-template
```

Then verify:

```sh
sbx template ls
```

### `gh` cannot connect or is not authenticated

First check host GitHub CLI authentication:

```sh
gh auth status
```

If needed:

```sh
gh auth login
```

Then store the host token for future Docker Sandboxes:

```sh
echo "$(gh auth token)" | sbx secret set -g github
```

If the PRD Sandbox already exists, either remove it after confirming there is no work to preserve:

```sh
sbx exec -w "$(pwd)" krutrimbox-prd-<number> -- git status --short --branch
sbx rm --force krutrimbox-prd-<number>
```

Or apply the secret directly to that running sandbox:

```sh
echo "$(gh auth token)" | sbx secret set krutrimbox-prd-<number> github
```

### A sandbox is left behind after a failure

Code Factory intentionally keeps PRD Sandboxes after HITL pauses and failures so you can inspect them.

List sandboxes:

```sh
sbx ls
```

Inspect a PRD Sandbox:

```sh
sbx exec -w "$(pwd)" krutrimbox-prd-<number> -- git status --short --branch
```

Remove it when you are sure no work needs preserving:

```sh
sbx rm --force krutrimbox-prd-<number>
```

## Useful References

- Main flow: `docs/factory-flow.md`
- Sandbox template setup: `docs/sandbox-template.md`
- Rationale for the custom template: `docs/adr/0012-use-custom-codex-sandbox-template.md`
- Docker Sandboxes template docs: https://docs.docker.com/ai/sandboxes/customize/templates/
