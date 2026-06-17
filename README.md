# Krutrimbox

Krutrimbox is a code factory: a local orchestrator for agent-ready GitHub issues. It discovers Target Issues labeled `ready-for-agent` that have no parent issue, implements standalone Target Issues directly or walks their ordered Implementation Issues, delegates AFK work to fresh Sandboxed Agent sessions inside Docker Sandboxes, pauses for human work when needed, and keeps the outer process in charge of GitHub state, commits, pushes, and pull requests.

This README is written for a new machine setup. It assumes you are comfortable copying terminal commands, but not necessarily familiar with Docker Sandboxes yet.

## What You Are Setting Up

krutrimbox uses three layers:

1. Your host machine runs the `kb` Node.js CLI from the `krutrimbox` package.
2. Docker Sandboxes creates an isolated Target Issue Sandbox for agent work.
3. The Sandboxed Agent runs inside that sandbox to implement one AFK issue at a time.

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

krutrimbox uses **two separate GitHub credentials**, and the split is what keeps the inner agent safe:

| Credential | Where it lives | Used for | Access needed |
| ---------- | -------------- | -------- | ------------- |
| **Host credential** | your `gh` login on the host | every GitHub mutation — create/edit the Target Issue Pull Request, comment, label, request review — **and the Target Issue Branch push** | **write** |
| **Sandbox credential** | Docker's global `github` secret, injected into sandboxes | inside the sandbox only: the clone, `git fetch`/`ls-remote` against origin, and the agent's read-only `gh` inspection | **read-only** |

The outer `kb` process performs all writes on the host. The sandbox only ever reads from GitHub — so the credential injected into it can, and should, be read-only.

### Host credential (write)

Make sure `gh` is logged in and points at the right account:

```sh
gh auth status
# if needed:
gh auth login
```

The account must be able to read issues, create/edit pull requests, push branches, and comment on issues/PRs in the target repository.

### Sandbox credential (read-only)

Docker Sandboxes do not inherit your host GitHub CLI login. Store a **read-only** token as Docker's built-in global `github` secret so `gh` and HTTPS git can authenticate inside sandboxes:

```sh
echo "$READ_ONLY_TOKEN" | sbx secret set -g github
```

Create a dedicated fine-grained personal access token for this — name it **`krutrimbox`** so it is easy to find and revoke later — scoped to the target repository with only read permissions: **Contents: Read**, **Issues: Read**, **Pull requests: Read**, **Metadata: Read** (Metadata is mandatory). That is everything the sandbox needs. Keeping it a separate, named, read-only token (rather than reusing your host `gh auth token`) means the credential inside the sandbox is least-privilege and independently revocable.

> [!IMPORTANT]
> **Why a read-only token — krutrimbox's security boundary.** The inner Sandboxed Agent runs non-interactively with its approval prompts bypassed (`--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions`). Its prompt forbids changing GitHub state, but a prompt is guidance, not enforcement. The read-only token *is* the enforcement: even if the agent ignored every instruction, the only GitHub credential it can reach cannot push, comment, label, close, merge, or delete anything. All writes happen on the host, with the host credential, entirely outside the sandbox. This is possible because krutrimbox publishes commits from the host (see "How Inner Agent Runs Are Authorized") instead of handing the sandbox a write-capable token.

The `-g` flag stores the secret globally for future sandboxes. Existing sandboxes do not receive newly created or changed global secrets; recreate them after setting the secret, or scope the secret to a specific running sandbox:

```sh
echo "$READ_ONLY_TOKEN" | sbx secret set krutrimbox-issue-1-codex github
```

Because all sandbox git reads go over HTTPS through this `github` secret, krutrimbox rewrites the cloned sandbox's `origin` to its HTTPS GitHub form before any remote operation. This means a host repo whose `origin` is an SSH remote — including an `~/.ssh/config` alias such as `git@github-personal:owner/repo.git` — works unchanged; the sandbox never needs your SSH config or keys. A real (dotted) SSH host is preserved for GitHub Enterprise, while an alias host resolves to `github.com`. The Target Issue Branch push runs on the host instead, using your host git credentials directly, so an SSH `origin` works there too.

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

### Choosing the base branch

krutrimbox always cuts the Target Issue Branch from a clean origin ref, never from whatever your host happens to have checked out. By default that ref is your repository's **default branch** (whatever GitHub reports — `main`, `dev`, `trunk`, …). Pass `--base-branch` to start from a different origin branch:

```sh
kb run --issue 1 --agent codex                 # base = repository default branch
kb run --issue 1 --agent codex --base-branch dev   # base = origin/dev
kb run --agent claude --base-branch dev            # batch mode, all issues based on origin/dev
```

The chosen base drives **both** the branch cut and the Target Issue Pull Request base, so the PR always targets the branch the work was built on. This is useful when you keep `main` as a production branch and integrate day-to-day work on a branch like `dev`. If the named base branch does not exist on origin, the run stops with a clear error.

Because the branch is cut from `origin/<base-branch>` (and resumed from `origin/<branch>`), a run is unaffected by your host working tree: you can be on any branch, with uncommitted changes or local commits that are not yet pushed, and none of that leaks into the Target Issue Branch.

krutrimbox currently processes only Factory-Owned Target Issues authored by `jd-solanki`.

Batch discovery finds open issues authored by `jd-solanki` with the `ready-for-agent` label and excludes any issue that has a parent issue. A child Implementation Issue can also carry `ready-for-agent`; the no-parent rule prevents it from being discovered as its own Target Issue.

A Standalone Target Issue has no attached sub-issues, so krutrimbox treats the Target Issue itself as a sequence-of-one Implementation Issue and implements its body directly. A Parent Target Issue has attached sub-issues, so krutrimbox uses the Target Issue body as context and walks those Implementation Issues in issue-number order.

> [!TIP]
> krutrimbox reuses your issue titles verbatim: the Target Issue Pull Request title is the Target Issue title, and each commit subject is the title of the Implementation Issue it delivers — the sub-issue title for a Parent Target Issue, or the Target Issue's own title for a Standalone Target Issue. So if you write your Target Issue and sub-issue titles following your commit conventions (for example `feat: add batch mode` or `fix: handle missing footer`), your pull request title and every commit on the branch will follow those conventions automatically — with no extra step.

krutrimbox does not close issues during a run. Each successful AFK or HITL completion is recorded by a `Refs #<issue-number>` commit footer on the Target Issue Branch; the Done Set is rebuilt from those footers on every run and drives resume behavior. The Target Issue Pull Request body carries `Closes #<number>` keywords for the Target Issue and every Implementation Issue, so GitHub closes them when the pull request merges.

## Project Configuration Directory

krutrimbox ships its built-in prompts and templates as readable Markdown files inside the installed package, so the same defaults apply whether you run from npm or from source. Repositories may keep shared krutrimbox configuration in `.krutrimbox/` and commit files that define team policy, such as `config.json` and comment templates:

```text
.krutrimbox/
  config.json
  templates/
    pull-request-body.md
    hitl-pause-comment.md
  prompts/
    afk-issue.md
    final-review.md
```

`.krutrimbox/config.json` may partially override Template Slots by their friendly names. Override paths are resolved relative to `.krutrimbox/`, and any omitted slot falls back to the built-in default:

```json
{
  "templates": {
    "pullRequestBody": "templates/pull-request-body.md",
    "hitlPauseComment": "templates/hitl-pause-comment.md"
  }
}
```

The supported Template Slots, aligned with their built-in Markdown filenames, are:

| Template Slot        | Built-in Markdown                      | Used for                              |
| -------------------- | -------------------------------------- | ------------------------------------- |
| `pullRequestBody`    | `templates/pull-request-body.md`       | the Target Issue Pull Request body    |
| `hitlPauseComment`   | `templates/hitl-pause-comment.md`      | the HITL pause comment                |
| `afkErrorComment`    | `templates/afk-error-comment.md`       | the AFK issue error comment           |
| `finalReviewComment` | `templates/final-review-comment.md`    | the final review comment              |

### Prompt Extensions

Sandboxed Agent prompts are **not** overridable — krutrimbox owns their safety
boundaries. But each built-in prompt accepts an **append-only Prompt Extension**:
a Markdown file whose contents are injected at the tail of the prompt inside a
`<repository_instructions>` XML tag. Use it to add repository policy or invoke
skills available in your agent setup, without touching krutrimbox's own prompt.

Configure extensions under the `prompts` key, keyed by prompt name. Paths resolve
relative to `.krutrimbox/` (same path-escape and symlink guards as templates), and
any prompt you omit simply renders an empty instructions block:

```json
{
  "prompts": {
    "afkIssue": "prompts/afk-issue.md",
    "finalReview": "prompts/final-review.md"
  }
}
```

| Prompt name   | Built-in Markdown            | Injected into                        |
| ------------- | ---------------------------- | ------------------------------------ |
| `afkIssue`    | `prompts/afk-issue.md`       | the AFK Issue implementation prompt  |
| `finalReview` | `prompts/final-review.md`    | the final review prompt              |

Extensions can only **add** instructions; the built-in prompt states that its own
boundaries take precedence, so a Prompt Extension can never relax them. Extension
content is injected verbatim and is not scanned for `{{placeholders}}`.

A few invariants stay owned by krutrimbox and are not configurable:

- **Prompts are never overridden.** Project Configuration may append Prompt Extensions, but the built-in prompt body and its safety boundaries always stand.
- **Factory Comment Markers are injected by krutrimbox** outside your template, so a custom comment body cannot break idempotent comment updates.
- **Invalid configuration fails fast.** Unknown top-level keys, unknown Template Slots, malformed JSON, missing override files, and paths that escape `.krutrimbox/` stop the run with a clear error rather than silently falling back.

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

Because those flags also bypass the agent's own approval prompts, the agent's GitHub reach is constrained by credentials, not prompts. The agent never pushes: it leaves its work as a commit in the sandbox clone, and the outer krutrimbox publishes it from the host — fetching the commit through the Docker-managed `sandbox-<name>` remote and pushing to `origin` with the host credential. The token injected into the sandbox is therefore read-only (see "Authenticate GitHub For Host And Sandboxes"), so even with approvals bypassed the agent cannot mutate GitHub.

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

This can be either credential (see "Authenticate GitHub For Host And Sandboxes"). First check the host GitHub CLI login that the outer process uses for all writes:

```sh
gh auth status
```

If needed:

```sh
gh auth login
```

If instead the failure is inside a sandbox, (re)store the **read-only** `krutrimbox` token as the global `github` secret for future Docker Sandboxes:

```sh
echo "$READ_ONLY_TOKEN" | sbx secret set -g github
```

If the Target Issue Sandbox already exists, either remove it after confirming there is no work to preserve:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
sbx rm --force krutrimbox-issue-<number>-<agent>
```

Or apply the secret directly to that running sandbox:

```sh
echo "$READ_ONLY_TOKEN" | sbx secret set krutrimbox-issue-<number>-<agent> github
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
