# Capabilities & Limitations

What krutrimbox does today, and the boundaries it doesn't cross yet.

## What krutrimbox does

### Runs

- **Explicit runs** target one Target Issue by id — `kb run --issue <number> --agent <codex|claude>` — and route work by assignee, including finding your slice inside a parent epic.
- **Batch runs** — `kb run --agent <codex|claude>` — discover every open Target Issue assigned to you (`assignee:@me`), labeled `ready-for-agent`, with no parent issue.
- `--agent` is required and is the only Agent Backend selector. Runs execute from the target repository root.

### Issues and sequencing

- A **Standalone Target Issue** is implemented directly — its body is a sequence of one.
- A **Parent Target Issue**'s Implementation Issues come from GitHub's native sub-issue links, sorted by issue number.
- The **Done Set** is rebuilt every run from `Refs #<n>` commit footers on the Target Issue Branch; issues already in it are skipped, so any run resumes where the last one stopped.
- A run **pauses** on an open HITL issue (`ready-for-human`) with an idempotent comment asking for a `Refs #<n>` commit.

### Sandboxes and agents

- Work happens in Docker Sandbox **clone mode**: branch checkout, file changes, and commits occur inside the Target Issue Sandbox, never your host working tree.
- Each AFK issue runs in a **fresh, non-resumed** session of the run's Agent Backend (Codex or Claude Code), inside one reusable sandbox per agent.
- GitHub integration is through the GitHub CLI; missing external commands fail naturally.

### Pull request and review

- One Target Issue Branch and one **draft** Target Issue Pull Request per Target Issue.
- Issues stay open during the run and close via `Closes #<n>` keywords when the PR merges.
- After every Implementation Issue is done, a **final review** session runs, the PR is marked ready for review, and the Final Reviewer is routed or tagged.
- The sandbox is removed after a successful completion.
- Operational detail goes to per-run log files; GitHub comments are reserved for actionable states.

## Not yet supported

These are intentional boundaries today, not commitments:

- Semantic verification and project test-command enforcement.
- Structured Sandboxed Agent output — completion is signalled by a successful process exit.
- Automatic retries of failed agent runs.
- Distributed locking and multi-machine runs — the Target Issue Lock is local to one machine.
- Advanced sandbox cleanup policies.
