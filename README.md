# Krutrimbox

Krutrimbox is a code factory: a local orchestrator for agent-ready GitHub issues. It discovers Target Issues labeled `ready-for-agent` that have no parent issue, implements standalone Target Issues directly or walks their ordered Implementation Issues, delegates AFK work to fresh Codex sessions inside Docker Sandboxes, pauses for human work when needed, and keeps the outer process in charge of GitHub state, commits, pushes, and pull requests.

This README is written for a new machine setup. It assumes you are comfortable copying terminal commands, but not necessarily familiar with Docker Sandboxes yet.

## What You Are Setting Up

krutrimbox uses three layers:

1. Your host machine runs the `kb` Node.js CLI from the `krutrimbox` package.
2. Docker Sandboxes creates an isolated Target Issue Sandbox for agent work.
3. Codex runs inside that sandbox to implement one AFK issue at a time.

The sandbox is intentionally separate from your host working tree. In Docker Sandboxes clone mode, the sandbox gets its own private Git clone. That keeps agent changes away from your current local branch until the outer krutrimbox commits and pushes them.

## Prerequisites

Install these before running krutrimbox:

- Git
- GitHub CLI, `gh`
- Node.js 20 or newer
- pnpm 10.23.0 or newer
- Docker Desktop or a working Docker Engine
- Docker Sandboxes CLI, `sbx`
- Authentication for at least one Agent Backend (Codex and/or Claude Code) in Docker Sandboxes — see "Authenticate Your Agent For Sandboxes"

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

## Clone And Build From Source

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

## Install krutrimbox

If you want the `kb` CLI on your machine instead of running from a clone, install the package globally:

```sh
npm install --global krutrimbox
```

Or with pnpm:

```sh
pnpm add --global krutrimbox
```

After install, confirm the binary is available:

```sh
kb --help
```

If you are developing from this repository and want your local checkout linked as the global `kb` binary, run:

```sh
pnpm build
pnpm pkg:link
```

## Authenticate GitHub For Host And Sandboxes

krutrimbox shells out to `gh` for GitHub state and mutations. Make sure `gh` is logged in and points at the right account:

```sh
gh auth status
```

If needed:

```sh
gh auth login
```

The account must be able to read issues, create/edit pull requests, push branches, and comment on issues/PRs in the target repository.

Docker Sandboxes do not automatically inherit your host GitHub CLI login. Store the host `gh` token as Docker's built-in `github` sandbox secret so `gh` and HTTPS GitHub requests can authenticate inside newly created sandboxes:

```sh
echo "$(gh auth token)" | sbx secret set -g github
```

The `-g` flag stores the secret globally for future sandboxes. Existing sandboxes do not receive newly created or changed global secrets; recreate them after setting the secret, or scope the secret to a specific running sandbox:

```sh
echo "$(gh auth token)" | sbx secret set krutrimbox-issue-1 github
```

Because all sandbox git access goes over HTTPS through this `github` secret, krutrimbox rewrites the cloned sandbox's `origin` to its HTTPS GitHub form before any remote operation. This means a host repo whose `origin` is an SSH remote — including an `~/.ssh/config` alias such as `git@github-personal:owner/repo.git` — works unchanged; the sandbox never needs your SSH config or keys. A real (dotted) SSH host is preserved for GitHub Enterprise, while an alias host resolves to `github.com`.

## Authenticate Your Agent For Sandboxes

The Sandboxed Agent inside each Target Issue Sandbox needs its own credentials to reach its model. krutrimbox writes no agent-credential code; authentication is entirely Docker Sandboxes' host-side credential proxy, and it is a **one-time setup per agent**. The token lives on your host (never inside the sandbox) and the proxy injects it into requests from any sandbox, so it survives krutrimbox removing and recreating Target Issue Sandboxes — you log in once, not per run.

Authenticate only the agents you intend to run with `--agent`.

If you use a subscription (no API key), sign in interactively once. Create a throwaway sandbox for the agent, attach, and run `/login`:

```sh
# Codex
sbx create codex "$(pwd)"   # then `sbx run <sandbox>` and complete `/login`
# Claude Code
sbx create claude "$(pwd)"  # then `sbx run <sandbox>` and complete `/login`
```

After the OAuth flow completes, the host holds the token and every future Target Issue Sandbox authenticates through the proxy. You can remove the throwaway sandbox.

If you prefer an API key (e.g. CI), store it as the matching Docker Sandboxes service secret instead, and skip the interactive `/login`:

```sh
sbx secret set -g anthropic   # Claude Code; prompts for the key
sbx secret set -g openai      # Codex
```

If a run fails because the inner agent is unauthenticated, krutrimbox treats it as an environment error and stops the current Target Issue, just as it does for missing `gh` credentials.

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

## Prepare krutrimbox Sandbox Template

Docker's stock agent sandbox images include the agent CLI and Node.js tooling, but this repository expects `pnpm` to be available directly inside the sandbox. We use a custom Docker Sandboxes template per Agent Backend so every fresh Target Issue Sandbox has the same toolchain.

A single parameterized `Dockerfile.sandbox` installs `pnpm@10.23.0` on top of the agent's stock template, selected by the `BASE` build argument (`docker/sandbox-templates:codex` or `docker/sandbox-templates:claude-code`).

Prepare only the agents you run. For Codex:

```sh
pnpm sandbox:prepare-template:codex
```

For Claude Code:

```sh
pnpm sandbox:prepare-template:claude
```

Or prepare both at once:

```sh
pnpm sandbox:prepare-template
```

Each `sandbox:prepare-template:<agent>` script runs, for example:

```sh
docker build -f Dockerfile.sandbox --build-arg BASE=docker/sandbox-templates:codex -t krutrimbox-codex:pnpm .
docker image save krutrimbox-codex:pnpm -o /tmp/krutrimbox-codex-pnpm.tar
sbx template load /tmp/krutrimbox-codex-pnpm.tar
```

The `sbx template load` step is important. Docker Sandboxes has its own template image store. A successful `docker build` alone does not make the image available to `sbx create --template`.

Verify that Docker Sandboxes can see the templates:

```sh
sbx template ls
```

You should see an entry for each agent you prepared:

```text
docker.io/library/krutrimbox-codex    pnpm
docker.io/library/krutrimbox-claude   pnpm
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

## Run krutrimbox

Every run must choose an Agent Backend with the required `--agent` flag (`codex` or `claude`). There is no default — a run never starts without an agent named explicitly.

Run one explicit Target Issue:

```sh
pnpm start run --issue 1 --agent codex
```

If you use an alias such as `nr`, this is equivalent:

```sh
nr start run --issue 1 --agent codex
```

Run batch mode for all eligible ready Target Issues, backed by Claude Code:

```sh
pnpm start run --agent claude
```

Once `krutrimbox` is installed globally, the same commands are available through the `kb` binary from any repository:

```sh
kb run --issue 1 --agent codex
kb run --agent claude
```

The Agent Backend is chosen per run. Because the Done Set is rebuilt from `Refs #<number>` commit footers on the agent-blind Target Issue Branch, you can even resume a Target Issue with a different agent than an earlier run used; each agent gets its own Target Issue Sandbox (`krutrimbox-issue-<number>-<agent>`).

krutrimbox currently processes only Factory-Owned Target Issues authored by `jd-solanki`.

Batch discovery finds open issues authored by `jd-solanki` with the `ready-for-agent` label and excludes any issue that has a parent issue. A child Implementation Issue can also carry `ready-for-agent`; the no-parent rule prevents it from being discovered as its own Target Issue.

A Standalone Target Issue has no attached sub-issues, so krutrimbox treats the Target Issue itself as a sequence-of-one Implementation Issue and implements its body directly. A Parent Target Issue has attached sub-issues, so krutrimbox uses the Target Issue body as context and walks those Implementation Issues in issue-number order.

krutrimbox does not close issues during a run. Each successful AFK or HITL completion is recorded by a `Refs #<issue-number>` commit footer on the Target Issue Branch; the Done Set is rebuilt from those footers on every run and drives resume behavior. The Target Issue Pull Request body carries `Closes #<number>` keywords for the Target Issue and every Implementation Issue, so GitHub closes them when the pull request merges.

## Project Configuration Directory

Repositories may keep shared krutrimbox configuration in `.krutrimbox/`. Commit files that define team policy, such as config and comment templates. Template override paths in `.krutrimbox/config.json` are relative to `.krutrimbox/`, and omitted template slots use the built-in defaults:

```text
.krutrimbox/
  config.json
  templates/
    pull-request-body.md
    hitl-pause-comment.md
```

```json
{
  "templates": {
    "pullRequestBody": "templates/pull-request-body.md",
    "hitlPauseComment": "templates/hitl-pause-comment.md"
  }
}
```

Keep runtime state local. Add only these generated subdirectories to the target repository's `.gitignore`:

```gitignore
.krutrimbox/logs/
.krutrimbox/locks/
```

## Existing Sandboxes After Auth Or Template Changes

Existing sandboxes keep the template and global secrets they were created with. If you created a Target Issue Sandbox before preparing the `pnpm` template or before setting the global `github` secret, that old sandbox will not automatically gain the missing tool or credential.

List existing sandboxes:

```sh
sbx ls
```

Check an existing Target Issue Sandbox:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- pnpm --version
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- gh auth status
```

If `pnpm` is not found or `gh` is not authenticated, inspect for uncommitted work first:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- git status --short --branch
```

If there is no work to preserve, remove the old sandbox:

```sh
sbx rm --force krutrimbox-issue-1
```

The next factory run will recreate it with the configured template and current global secrets.

## Why Commands Use `-w "$(pwd)"`

In clone mode, Docker Sandboxes exposes the private repository clone at the original host repository path inside the sandbox.

This works:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- git status --short --branch
```

This may fail:

```sh
sbx exec krutrimbox-issue-1 -- git status --short --branch
```

Without `-w`, `sbx exec` can start in a default directory that is not a Git repository. krutrimbox handles this internally by resolving the host repository path and passing it to `sbx exec --workdir`.

## How Inner Agent Runs Are Authorized

krutrimbox launches each Sandboxed Agent non-interactively, with explicit flags so it never pauses for an approval prompt that no human is attached to answer. The exact command depends on the run's Agent Backend:

```sh
# --agent codex
codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox "<prompt>"
# --agent claude
claude -p "<prompt>" --dangerously-skip-permissions
```

This is intentional. The agent process is already running inside a Docker Sandbox private clone, so Docker Sandboxes is the outer isolation boundary. The inner process must not pause for approval because no human is attached to the AFK Issue session. `claude -p` is also a fresh one-shot (never `--continue`/`--resume`), which keeps each AFK Issue's context window fresh.

These flags prevent the agent's own approval prompts. They do not answer ordinary command prompts from tools such as `git`, package managers, or auth flows. That is why the machine setup, GitHub auth, agent auth, network policy, and custom `pnpm` template all need to be prepared before running the factory.

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

Then recreate any old Target Issue Sandbox that was created before the template was available:

```sh
sbx rm --force krutrimbox-issue-<number>-<agent>
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

If the Target Issue Sandbox already exists, either remove it after confirming there is no work to preserve:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
sbx rm --force krutrimbox-issue-<number>-<agent>
```

Or apply the secret directly to that running sandbox:

```sh
echo "$(gh auth token)" | sbx secret set krutrimbox-issue-<number>-<agent> github
```

### A sandbox is left behind after a failure

krutrimbox intentionally keeps Target Issue Sandboxes after HITL pauses and failures so you can inspect them.

List sandboxes:

```sh
sbx ls
```

Inspect a Target Issue Sandbox:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
```

Remove it when you are sure no work needs preserving:

```sh
sbx rm --force krutrimbox-issue-<number>-<agent>
```

## Useful References

- Main flow: `docs/factory-flow.md`
- Sandbox template setup: `docs/sandbox-template.md`
- Rationale for the custom template: `docs/adr/0012-use-custom-codex-sandbox-template.md`
- Docker Sandboxes template docs: <https://docs.docker.com/ai/sandboxes/customize/templates/>
