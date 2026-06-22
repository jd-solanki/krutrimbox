# Running krutrimbox

Every run must choose an Agent Backend with the required `--agent` flag (`codex` or `claude`). There is no default — a run never starts without an agent named explicitly.

Run one explicit Target Issue:

```sh
kb run --issue 1 --agent codex
```

Run batch mode for all eligible ready Target Issues, backed by Claude Code:

```sh
kb run --agent claude
```

If you are running from a clone of the repository instead of the globally installed binary, the same commands are available through the package scripts:

```sh
pnpm start run --issue 1 --agent codex
pnpm start run --agent claude
```

The Agent Backend is chosen per run. Because the Done Set is rebuilt from `Refs #<number>` commit footers on the agent-blind Target Issue Branch, you can even resume a Target Issue with a different agent than an earlier run used; each agent gets its own Target Issue Sandbox, whose name embeds the issue number, a repository fingerprint, and the agent (e.g. `krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex`).

## Choosing the base branch

krutrimbox always creates the Target Issue Branch from a clean origin ref, never from whatever your host happens to have checked out. By default that ref is your repository's **default branch** (whatever GitHub reports — `main`, `dev`, `trunk`, …). Pass `--base-branch` to start from a different origin branch:

```sh
kb run --issue 1 --agent codex                     # base = repository default branch
kb run --issue 1 --agent codex --base-branch dev   # base = origin/dev
kb run --agent claude --base-branch dev            # batch mode, all issues based on origin/dev
```

The chosen base drives **both** the branch creation and the Target Issue Pull Request base, so the PR always targets the branch the work was built on. This is useful when you keep `main` as a production branch and integrate day-to-day work on a branch like `dev`. If the named base branch does not exist on origin, the run stops with a clear error.

Because the branch is created from `origin/<base-branch>` (and resumed from `origin/<branch>`), a run is unaffected by your host working tree: you can be on any branch, with uncommitted changes or local commits that are not yet pushed, and none of that leaks into the Target Issue Branch.

## Which issues krutrimbox works on

krutrimbox works on issues assigned to **you** — the GitHub account `gh` is authenticated as — that carry the `ready-for-agent` label. An issue must be assigned to you alone; one assigned to someone else or to several people is skipped. Solo developers who don't assign issues can pass `--implement-unassigned` to also run issues with no assignee.

Batch discovery (`kb run`) finds open `ready-for-agent` issues assigned to you that have no parent issue. A child Implementation Issue can also carry `ready-for-agent`; the no-parent rule prevents it from being discovered as its own Target Issue. To work on your slice of an epic that belongs to a teammate, run the parent explicitly with `kb run --issue <parent>`. See [Issue Ownership & Routing](/guide/concepts/issue-ownership-and-routing) for the full model, including how teams split a parent's sub-issues across people.

A Standalone Target Issue has no attached sub-issues, so krutrimbox treats the Target Issue itself as a sequence-of-one Implementation Issue and implements its body directly. A Parent Target Issue has attached sub-issues — created with [GitHub's native sub-issue feature](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) — so krutrimbox uses the Target Issue body as context and walks those Implementation Issues in issue-number order.

::: tip
krutrimbox reuses your issue titles verbatim: the Target Issue Pull Request title is the Target Issue title, and each commit subject is the title of the Implementation Issue it delivers — the sub-issue title for a Parent Target Issue, or the Target Issue's own title for a Standalone Target Issue. So if you write your Target Issue and sub-issue titles following your commit conventions (for example `feat: add batch mode` or `fix: handle missing footer`), your pull request title and every commit on the branch will follow those conventions automatically — with no extra step.
:::

krutrimbox does not close issues during a run. Each successful AFK or HITL completion is recorded by a `Refs #<issue-number>` commit footer on the Target Issue Branch; the Done Set is rebuilt from those footers on every run and drives resume behavior. The Target Issue Pull Request body carries `Closes #<number>` keywords for the Target Issue and every Implementation Issue, so GitHub closes them when the pull request merges.

For the end-to-end mechanics of a run — sandboxes, commits, pull requests, HITL pauses, and lifecycle hooks — see [Factory Flow](/guide/concepts/factory-flow).
