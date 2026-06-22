# Why krutrimbox

Coding agents are good at implementing a well-specified issue. The hard part is everything *around* that: giving the agent a safe place to work, stopping it from touching your GitHub state, sequencing dependent work, and handing off to a human when a step genuinely needs one. krutrimbox is the orchestration layer that handles all of it.

## The problem

Pointing an agent straight at your working tree is risky. It can change files you didn't expect, and if you hand it a GitHub token it can push, comment, close, or merge on your behalf. Doing it by hand for every issue is tedious: you create branches, write prompts, review diffs, open PRs, and track what's already done.

## How krutrimbox helps

**Isolation by default.** Every issue runs inside a Docker Sandbox with its own private clone of your repo. Agent changes never touch your working tree until krutrimbox commits and pushes them from the host.

**A read-only security boundary.** The only GitHub credential inside the sandbox is read-only. Every write — branch push, PR create/edit, comment, label, review request — happens on your host with your own credential. Even if the agent ignored every instruction, it *cannot* mutate GitHub state. See [Authentication](./authentication) for how the boundary is enforced.

**Issue-driven and resumable.** krutrimbox discovers issues by label and assignee, implements a standalone issue directly or walks a parent's ordered sub-issues, and rebuilds its "done" set from `Refs #<n>` commit footers on the branch. Any run can resume where the last one stopped — even with a different agent.

**Human-in-the-loop where it matters.** An issue labeled `ready-for-human` pauses the run with an idempotent comment. A person finishes it and pushes a commit, and the next run picks up automatically.

**Language-agnostic.** krutrimbox orchestrates; it doesn't build. The `kb` CLI is written in Node + TypeScript, but the issues it implements can live in any language. You make project tooling available to the agent through the [sandbox template](./sandbox-template), not by changing krutrimbox.

## How it fits together

For the full mechanics of a run — branch creation, sandbox lifecycle, commits, pull request, HITL pauses, and lifecycle hooks — see [Factory Flow](./concepts/factory-flow).
