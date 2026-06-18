# Authentication

krutrimbox needs two kinds of credentials:

- **GitHub** — a write-capable `gh` login for your host, plus a read-only token for sandboxes.
- **Your coding agent** — a login so the agent can reach its model.

If you got here from the [Quickstart](./quickstart) and just want to authenticate and run, follow **[Quick setup](#quick-setup)** — three steps, no theory. The **[How it works](#how-it-works)** section below explains why the GitHub credentials are split and how that split is krutrimbox's security boundary.

## Quick setup

### 1. Log in to GitHub on your host

```sh
gh auth status     # already logged in? you're done
gh auth login      # otherwise, sign in
```

This is the **write-capable** credential krutrimbox uses for every GitHub change. The account must be able to read issues, push branches, and create/edit pull requests in your repo.

### 2. Add a read-only token for sandboxes

[Create](https://github.com/settings/personal-access-tokens) a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) — name it **`krutrimbox`** so it's easy to revoke — scoped to your repository with these **read-only** permissions:

- **Contents** — Read
- **Issues** — Read
- **Pull requests** — Read
- **Metadata** — Read *(mandatory)*

Store it as Docker Sandboxes' global `github` secret:

```sh
echo "$CREATE_READ_ONLY_TOKEN" | sbx secret set -g github
```

The sandbox only ever *reads* GitHub, so this token is deliberately read-only — that's the [security boundary](#why-the-sandbox-token-is-read-only), not an inconvenience.

### 3. Authenticate your coding agent

Only for the agents you'll run with `--agent`. Pick one method per agent:

::: code-group

```sh [Subscription (interactive)]
# Codex — then `sbx run <sandbox>` and complete /login
sbx create codex "$(pwd)"
# Claude Code — then `sbx run <sandbox>` and complete /login
sbx create claude "$(pwd)"
```

```sh [API key]
sbx secret set -g anthropic   # Claude Code; prompts for the key
sbx secret set -g openai      # Codex
```

:::

You log in **once per agent**. The token lives on your host, and every future sandbox authenticates through Docker's proxy — you can delete the throwaway sandbox afterward.

Done — head back to [your first run](./quickstart#your-first-run) in the Quickstart.

---

## How it works

### Two GitHub credentials

krutrimbox uses two separate GitHub credentials, and the split is what keeps the inner agent safe:

| Credential | Where it lives | Used for | Access needed |
| ---------- | -------------- | -------- | ------------- |
| **Host credential** | your `gh` login on the host | every GitHub mutation — create/edit the Target Issue Pull Request, comment, label, request review — **and the Target Issue Branch push** | **write** |
| **Sandbox credential** | Docker's global `github` secret, injected into sandboxes | inside the sandbox only: the clone, `git fetch`/`ls-remote` against origin, and the agent's read-only `gh` inspection | **read-only** |

The outer `kb` process performs all writes on the host. The sandbox only ever reads from GitHub — so the credential injected into it can, and should, be read-only. Keeping it a separate, named token (rather than reusing your host `gh auth token`) makes it least-privilege and independently revocable.

The `-g` flag stores the secret globally for future sandboxes. Existing sandboxes do not receive newly created or changed global secrets; recreate them after setting the secret.

All sandbox git reads go over HTTPS through this `github` secret, so the sandbox never needs your SSH config or keys — even when your repo's `origin` is an SSH remote. See [SSH remotes](./advanced/ssh) for the details.

### Why the sandbox token is read-only

::: warning krutrimbox's security boundary
The inner Sandboxed Agent runs non-interactively with its approval prompts bypassed (`--dangerously-bypass-approvals-and-sandbox` / `--dangerously-skip-permissions`). Its prompt forbids changing GitHub state, but a prompt is guidance, not enforcement. The read-only token *is* the enforcement: even if the agent ignored every instruction, the only GitHub credential it can reach cannot push, comment, label, close, merge, or delete anything. All writes happen on the host, with the host credential, entirely outside the sandbox. This is possible because krutrimbox publishes commits from the host (see [How inner agent runs are authorized](#how-inner-agent-runs-are-authorized)) instead of handing the sandbox a write-capable token.
:::

### The agent credential proxy

The Sandboxed Agent needs its own credentials to reach its model. krutrimbox writes no agent-credential code; authentication is entirely Docker Sandboxes' host-side credential proxy. The token lives on your host (never inside the sandbox), and the proxy injects it into requests from any sandbox — so it survives krutrimbox removing and recreating Target Issue Sandboxes. That's why it's a one-time setup per agent, not per run.

If you sign in with a subscription, the interactive `/login` completes an OAuth flow and the host holds the resulting token. If you use an API key instead (e.g. in CI), the matching service secret (`anthropic` / `openai`) plays the same role with no interactive step.

If a run fails because the inner agent is unauthenticated, krutrimbox treats it as an environment error and stops the current Target Issue, just as it does for missing `gh` credentials.

### How inner agent runs are authorized

krutrimbox launches each Sandboxed Agent non-interactively, with explicit flags so it never pauses for an approval prompt that no human is attached to answer. The exact command depends on the run's Agent Backend:

```sh
# --agent codex
codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox "<prompt>"
# --agent claude
claude -p "<prompt>" --dangerously-skip-permissions
```

This is intentional. The agent process is already running inside a Docker Sandbox private clone, so Docker Sandboxes is the outer isolation boundary. The inner process must not pause for approval because no human is attached to the AFK Issue session. `claude -p` is also a fresh one-shot (never `--continue`/`--resume`), which keeps each AFK Issue's context window fresh.

Because those flags also bypass the agent's own approval prompts, the agent's GitHub reach is constrained by credentials, not prompts. The agent never pushes: it leaves its work as a commit in the sandbox clone, and the outer krutrimbox publishes it from the host — fetching the commit through the Docker-managed `sandbox-<name>` remote and pushing to `origin` with the host credential. The token injected into the sandbox is therefore read-only (see [Why the sandbox token is read-only](#why-the-sandbox-token-is-read-only)), so even with approvals bypassed the agent cannot mutate GitHub.

These flags prevent the agent's own approval prompts. They do not answer ordinary command prompts from tools such as `git`, package managers, or auth flows. That is why the machine setup, GitHub auth, agent auth, network policy, and the sandbox template all need to be prepared before running the factory.
