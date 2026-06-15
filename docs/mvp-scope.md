# MVP Scope

The MVP proves the krutrimbox orchestration loop for Factory-Owned Target Issues before tightening agent verification.

## In Scope

- Run krutrimbox against one explicit Target Issue when the issue is authored by `jd-solanki`.
- Run krutrimbox in Batch Run mode to discover open Target Issues authored by `jd-solanki`, labeled `ready-for-agent`, and lacking a parent issue.
- Provide `kb run --issue <number>` for Explicit Runs and `kb run` for Batch Runs.
- Assume the CLI is run from the target repository root.
- Use Docker Sandbox clone mode so Target Issue Branch checkout, file changes, commits, and pushes happen inside the Target Issue Sandbox rather than the host working tree.
- Use GitHub CLI as the GitHub integration layer. Missing required external commands fail naturally through command execution.
- Treat a Standalone Target Issue as a sequence-of-one Implementation Issue whose body is the work.
- Discover Implementation Issues from a Parent Target Issue's native GitHub sub-issue links.
- Sort Implementation Issues by GitHub issue number.
- Rebuild the Done Set from `Refs #<issue-number>` commit footers on the Target Issue Branch.
- Skip Implementation Issues that are already in the Done Set.
- Stop on an open HITL Issue with an idempotent Target Issue comment that asks the human to push a `Refs #<issue-number>` commit.
- Run each open AFK Issue in a fresh non-resumed `codex exec` session inside one reusable Target Issue Sandbox.
- Use one Target Issue Branch and one draft Target Issue Pull Request for the Target Issue.
- Keep issues open during the run; close them only through `Closes #<issue-number>` keywords when the pull request merges.
- Run a final fresh Codex review session after all Implementation Issues are in the Done Set.
- Mark the Target Issue Pull Request ready for review and route or tag the Final Reviewer.
- Remove the Target Issue Sandbox after successful completion.
- Use per-run log files for operational output and GitHub comments only for actionable states.

## Deferred

- Semantic verification and project test command enforcement.
- Structured Sandboxed Agent output.
- Automatic retries.
- Distributed locking.
- Multi-machine Factory Runs.
- Advanced cleanup policies.
