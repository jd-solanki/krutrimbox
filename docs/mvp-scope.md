# MVP Scope

The MVP proves the Code Factory orchestration loop before tightening agent verification.

## In Scope

- Run the Code Factory against an explicit PRD number when the PRD is authored by `jd-solanki`.
- Run the Code Factory in Batch Run mode to discover open PRDs authored by `jd-solanki` and labeled `PRD` and `ready-for-agent`, then process them sequentially in issue-number order.
- Implement the Code Factory as a small TypeScript Node.js CLI under `.ai/resources/code-factory/` that may use Commander for command parsing.
- Provide `code-factory run --prd <number>` for Explicit Runs and `code-factory run` for Batch Runs.
- Assume the CLI is run from the target repository root.
- Use Docker Sandbox clone mode so PRD Branch checkout, file changes, commits, and pushes happen inside the PRD Sandbox rather than the host working tree.
- Use GitHub CLI as the GitHub integration layer. Missing required external commands fail naturally through command execution.
- Discover valid Implementation Issues from attached sub-issues whose `## Parent` section references the PRD.
- Sort Implementation Issues by GitHub issue number.
- Skip closed Implementation Issues.
- Stop on an open HITL Issue with an idempotent parent PRD comment.
- Run each open AFK Issue in a fresh non-resumed `codex exec` session inside one reusable PRD Sandbox.
- Use one PRD Branch and one draft PRD Pull Request for the PRD.
- Close AFK Issues after Sandbox Success.
- Run a final fresh Codex review session after all Implementation Issues are closed.
- Mark the PRD Pull Request ready for review and route or tag the Final Reviewer.
- Remove the PRD Sandbox after successful completion.
- Use terminal output for run logs and GitHub comments only for actionable states.

## Deferred

- Semantic verification and project test command enforcement.
- Structured Sandboxed Agent output.
- Automatic retries.
- Distributed locking.
- Multi-machine Factory Runs.
- Advanced cleanup policies.
