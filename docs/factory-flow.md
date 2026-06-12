# Code Factory Flow

The Code Factory starts from a parent PRD issue that has already been broken into ordered Implementation Issues.

The MVP supports Explicit Runs for a specified PRD and Batch Runs that discover open PRDs labeled `PRD` and `ready-for-agent`. The Code Factory only processes Factory-Owned PRDs authored by `jd-solanki`. Batch Runs process discovered Factory-Owned PRDs sequentially in issue-number order. A HITL pause or issue-level error stops the current PRD but does not stop the rest of the Batch Run unless the factory itself hits a fatal error.

Before discovery or processing, the Code Factory ensures required GitHub labels exist, including `PRD`, `ready-for-agent`, and `ready-for-human`.

Batch Run discovery filters for author `jd-solanki` when listing candidate PRDs, so PRDs authored by other users are skipped by discovery rather than rejected after selection. For the MVP, `jd-solanki` is a top-level constant in the factory implementation, not a user-configurable value.

Explicit Runs also enforce Factory-Owned PRD eligibility. A requested PRD not authored by `jd-solanki` is skipped.

## PRD Setup

1. The PRD issue exists in GitHub and is labeled `PRD` and `ready-for-agent`.
2. The PRD is authored by `jd-solanki`.
3. The PRD has attached sub-issues.
4. Each valid Implementation Issue is labeled `PRD-sub-issue`.
5. Each valid Implementation Issue is linked to the PRD through GitHub's native sub-issue relationship. The Code Factory reads that relationship — the PRD's attached sub-issues and each issue's native `parent_issue_url` — instead of parsing a `## Parent` body section.
6. Each open valid Implementation Issue has exactly one state label: `ready-for-agent` or `ready-for-human`.
7. The Code Factory builds the Implementation Sequence by sorting valid Implementation Issues by GitHub issue number.

## Factory Run

Each Factory Run rebuilds the Implementation Sequence from GitHub state and walks it from first to last.

Before processing a PRD, the Code Factory acquires a PRD Lock. For the MVP, the PRD Lock is local to the single machine running the factory.

If a PRD is already locked, the Code Factory skips it and continues.

The Code Factory uses Docker Sandbox clone mode for PRD Sandboxes. The host repository is the launch/source repository, but PRD Branch checkout, file changes, commits, and pushes happen inside the PRD Sandbox private clone rather than the host working tree.

PRD Sandboxes are created from the Code Factory Sandbox Template, currently `docker.io/library/code-factory-codex:pnpm`, so Sandboxed Agents have repository-required tooling such as `pnpm` available before implementation starts. See `docs/sandbox-template.md` for machine setup and template loading instructions.

The outer TypeScript Code Factory runs implementation git commands inside the PRD Sandbox, not on the host. This includes branch checkout, staging, committing, and pushing.

The outer Code Factory passes the absolute repository path to `sbx create` and uses that same path with `sbx exec --workdir`. In clone mode, the private repository clone is available at that path inside the sandbox; Docker Sandboxes' default exec directory is not guaranteed to be a Git repository.

GitHub mutation commands run from the host through the outer Code Factory's authenticated `gh` session. The Sandboxed Agent may use read-only `gh` commands for inspection, and sandbox git commands mutate only the PRD Sandbox private clone.

For the MVP, sandbox GitHub authentication is assumed to come from the local Docker Sandbox/Codex environment setup. If sandbox `git push` or read-only `gh` inspection fails because credentials are unavailable, the Code Factory treats it as an environment error and stops the current PRD.

The MVP does not use an `in-progress` issue label. Strict sequential execution under the PRD Lock prevents the Code Factory from starting the next AFK Issue until the current AFK Issue reaches Sandbox Success and is closed.

1. Closed Implementation Issues are skipped.
2. An open HITL Issue causes the Code Factory to comment on the parent PRD, tag the PRD author, and exit.
3. Before launching a Sandboxed Agent for an open AFK Issue, the outer Code Factory checks whether any Blocking Issues named in the current issue's `Blocked by` section are resolved.
4. If the outer check finds an unresolved Blocking Issue, the Code Factory comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, and exits the Factory Run.
5. An open AFK Issue whose Blocking Issues are resolved is delegated to a fresh non-resumed Codex session inside a Docker sandbox.
6. The sandboxed Codex session receives the PRD body and the current Implementation Issue body as its task context.
7. Before implementation, the sandboxed Codex session verifies Blocking Issues again with Read-Only GitHub Access.
8. If a Blocking Issue is not resolved, the sandboxed Codex session throws an error; the Code Factory catches that error, comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, and exits the Factory Run.
9. If Blocking Issues are resolved, the sandboxed Codex session checks out or creates the PRD Branch and implements the AFK Issue.
10. After the Sandboxed Agent exits successfully, the outer Code Factory creates a commit with a fixed commit message, includes `Refs #<issue-number>`, pushes the PRD Branch, and creates or reuses the PRD Pull Request using the Authenticated GitHub User.
11. After Sandbox Success, the Code Factory manually closes the completed AFK Issue so later Factory Runs can resume by skipping it.

For the MVP, Sandbox Success trusts the sandboxed Codex session's successful process exit followed by the outer Code Factory committing and pushing the resulting changes. Agent verification can be tightened later if the factory closes issues before work is actually complete.

The fixed commit message is:

```text
chore: code factory implementation

Refs #<issue-number>
```

The Code Factory creates one commit per completed AFK Issue, even when multiple AFK Issues run during the same Factory Run.

For the MVP, the outer Code Factory stages all working tree changes inside the PRD Sandbox private clone after the Sandboxed Agent succeeds. The outer Code Factory is responsible for committing, pushing the PRD Branch, creating or updating the PRD Pull Request, and changing the PRD Pull Request from draft to ready for review.

The MVP treats a successful `codex exec` process exit as the Sandboxed Agent's completion signal. Structured output can be introduced later if the completion signal proves too loose or difficult for the Code Factory to interpret.

Each AFK Issue gets a fresh Codex context window. The Factory Run may reuse the PRD Branch for code continuity, but it must not resume a previous Codex conversation between Implementation Issues.

Sandboxed Codex sessions are launched with explicit non-interactive settings: `--ephemeral --ask-for-approval never --sandbox danger-full-access`. Docker Sandbox clone mode provides the outer isolation boundary; the inner Codex process must not pause for approvals because no human is attached to the AFK Issue session.

Only the outer Code Factory owns GitHub orchestration state and git commit/push operations. The Sandboxed Agent implements the AFK Issue and reports completion, and may use Read-Only GitHub Access for inspection, but must not create commits, push branches, close issues, create or edit the PRD Pull Request, change labels, post comments, or change parent PRD state.

The Code Factory maintains a deterministic PRD Pull Request Body from current GitHub state using `templates/pr-body.md`. The body links the parent PRD with a closing relationship, lists the Implementation Issues as a progress checklist, and includes Code Factory branch and sandbox metadata. The Sandboxed Agent does not edit the PRD Pull Request Body.

The PRD Pull Request is created as a draft and remains draft while any Implementation Issue remains open.

The PRD Branch name is deterministic: `code-factory/prd-<prd-number>`.

The PRD Pull Request title uses a fixed Code Factory format: `Code Factory PRD #<prd-number>: <prd-title>`.

The PRD Pull Request targets the repository default branch.

The Code Factory applies only the `PRD` label to the PRD Pull Request.

When reusing an existing PRD Pull Request, the Code Factory identifies it by the deterministic PRD Branch, not by title.

## Sandboxed Agent Prompt

For each AFK Issue, the Code Factory generates a strict per-issue prompt for the fresh Codex session. The prompt includes the full parent PRD body, the current AFK Issue body, earlier Implementation Issue numbers, titles, and current state, lightweight future Implementation Issue context, the PRD Branch name, and explicit boundaries that the Sandboxed Agent may inspect GitHub with read-only commands but must not mutate GitHub state, create commits, push branches, or process future Implementation Issues. Lightweight future context includes issue numbers, titles, type, and blocked-by relationships, not full future issue bodies.

The custom prompt must instruct the Sandboxed Agent to work on exactly one AFK Issue: the current issue. The Sandboxed Agent must not implement future Implementation Issues, even when future issue metadata is included for awareness.

The Sandboxed Agent prompt is a versioned prompt template under `prompts/`, such as `prompts/afk-issue.md`, rather than an ad hoc shell string.

## HITL Resume

When a Factory Run stops at a HITL Issue, a human resolves the issue outside the Code Factory and closes it. A later Factory Run against the same PRD skips the closed HITL Issue and continues to the next open Implementation Issue.

The Code Factory does not remove `ready-for-agent` from the parent PRD when it stops at a HITL Issue. If the parent PRD is discovered again before the HITL Issue is closed, the next Factory Run reaches the same open HITL Issue and exits again.

HITL comments on the parent PRD use `templates/hitlpause-comment.md` with a Factory Comment Marker keyed by the PRD and HITL Issue. Repeated Factory Runs update or skip the existing marked comment instead of posting duplicate comments.

Helpful error comments on AFK Issues use `templates/afk-error-comment.md` with Factory Comment Markers keyed by the issue and error class, so repeated Factory Runs update or skip the existing marked comment instead of posting duplicate comments.

The MVP does not automatically retry failed Sandboxed Agent runs. If the Sandboxed Agent exits non-zero or the outer Code Factory fails to commit or push, the Code Factory comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, keeps the PRD Sandbox for debugging, and exits the Factory Run.

If commit or push fails after the Sandboxed Agent exits successfully, the Code Factory treats the issue as incomplete. The error comment includes the PRD Sandbox name, PRD Branch name, failed command summary, cleanup command, and rerun command.

Factory Run logs are terminal output only. Durable GitHub comments are reserved for actionable states such as HITL pauses, unresolved blockers, and AFK issue errors.

## Final Review

When every Implementation Issue in the Implementation Sequence is closed, the Code Factory starts a fresh non-resumed `codex exec` session inside the same PRD Sandbox to review the PRD Pull Request diff against the parent PRD and Implementation Issue intent. The review session outputs a Markdown review body, and the outer Code Factory posts it as a normal PR comment on the PRD Pull Request using `templates/final-review-comment.md`. The final review PR comment uses a Factory Comment Marker so repeated Factory Runs update or skip the existing comment.

The final review session may use read-only `gh` commands for inspection, but it must not mutate files or GitHub state. The outer Code Factory captures the review Markdown, posts or updates the PR comment through host `gh`, marks the PRD Pull Request ready for review, and routes or tags the Final Reviewer.

After the review comment is posted, the Code Factory marks the PRD Pull Request ready for review and requests review from the PRD Author when they differ from the PR Author; when they are the same user, the Code Factory tags the PRD Author in a comment instead of requesting self-review.

Future review prompts may invoke a project-local review skill from `.agents/skills`.

The parent PRD remains open while implementation is in progress. The parent PRD is closed when the final PRD Pull Request is merged using GitHub's linked pull request behavior.

The Code Factory leaves parent PRD labels unchanged when the PRD Pull Request becomes ready for review.

The Code Factory never merges the PRD Branch into the default branch. A human performs the final merge and may choose the final squash commit message.

## Sandbox Cleanup

The Factory Run uses a deterministic PRD Sandbox name derived from the PRD issue number: `code-factory-prd-<prd-number>`. When the PRD completes and final review routing is done, the Code Factory removes the PRD Sandbox automatically. When the Factory Run exits for HITL or an error, it keeps the PRD Sandbox for debugging and includes the cleanup command in the relevant comment or log.
