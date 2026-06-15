# krutrimbox Flow

krutrimbox starts from a Target Issue: an open Factory-Owned issue labeled `ready-for-agent` with no parent issue. A Target Issue can be Standalone, where its own body is the unit of work, or a Parent Target Issue, where native GitHub sub-issues form the ordered Implementation Sequence.

The MVP supports Explicit Runs for a specified Target Issue and Batch Runs that discover eligible Target Issues. Batch Runs process discovered Target Issues sequentially in issue-number order. A HITL pause or issue-level error stops the current Target Issue but does not stop the rest of the Batch Run unless the factory itself hits a fatal error.

Before discovery or processing, krutrimbox ensures required GitHub labels exist: `krutrimbox`, `ready-for-agent`, and `ready-for-human`.

Batch Run discovery filters for author `jd-solanki` when listing candidate Target Issues, so issues authored by other users are skipped by discovery rather than rejected after selection. For the MVP, `jd-solanki` is a top-level constant in the factory implementation, not a user-configurable value.

Explicit Runs also enforce Factory-Owned Target Issue eligibility. A requested Target Issue not authored by `jd-solanki` is skipped.

## Target Issue Setup

1. The Target Issue exists in GitHub, is open, and is labeled `ready-for-agent`.
2. The Target Issue is authored by `jd-solanki`.
3. The Target Issue has no parent issue.
4. If the Target Issue has no attached sub-issues, it is treated as its own single AFK Implementation Issue.
5. If the Target Issue has attached sub-issues, each Implementation Issue is linked through GitHub's native sub-issue relationship.
6. Each open Implementation Issue has exactly one state label: `ready-for-agent` or `ready-for-human`.
7. krutrimbox builds the Implementation Sequence by sorting Implementation Issues by GitHub issue number.

## Factory Run

Each Factory Run rebuilds the Implementation Sequence from GitHub state and the Done Set, then walks it from first to last.

Before processing a Target Issue, krutrimbox acquires a Target Issue Lock. For the MVP, the lock is local to the single machine running the factory.

If a Target Issue is already locked, krutrimbox skips it and continues.

krutrimbox uses Docker Sandbox clone mode for Target Issue Sandboxes. The host repository is the launch/source repository, but Target Issue Branch checkout, file changes, commits, and pushes happen inside the Target Issue Sandbox private clone rather than the host working tree.

Target Issue Sandboxes are created from the krutrimbox Sandbox Template for the run's Agent Backend (`docker.io/library/krutrimbox-codex:pnpm` or `docker.io/library/krutrimbox-claude:pnpm`), so Sandboxed Agents have repository-required tooling such as `pnpm` available before implementation starts. See `docs/sandbox-template.md` for machine setup and template loading instructions.

The outer TypeScript krutrimbox runs implementation git commands inside the Target Issue Sandbox, not on the host. This includes branch checkout, staging, committing, and pushing.

The outer krutrimbox passes the absolute repository path to `sbx create` and uses that same path with `sbx exec --workdir`. In clone mode, the private repository clone is available at that path inside the sandbox; Docker Sandboxes' default exec directory is not guaranteed to be a Git repository.

GitHub mutation commands run from the host through the outer krutrimbox's authenticated `gh` session. The Sandboxed Agent may use read-only `gh` commands for inspection, and sandbox git commands mutate only the Target Issue Sandbox private clone.

For sandbox `gh` access and HTTPS GitHub operations, operators must store the host GitHub CLI token as Docker Sandboxes' built-in `github` secret, as documented in the README. Existing sandboxes created before the secret is configured must be recreated or given a sandbox-scoped `github` secret. If sandbox `git push` or read-only `gh` inspection fails because credentials are unavailable, krutrimbox treats it as an environment error and stops the current Target Issue.

The MVP does not use an `in-progress` issue label. Strict sequential execution under the Target Issue Lock prevents krutrimbox from starting the next AFK Issue until the current AFK Issue reaches Sandbox Success and is committed to the Target Issue Branch.

1. Implementation Issues in the Done Set are skipped.
2. An open HITL Issue causes krutrimbox to comment on the Target Issue, tag the Target Issue Author, and exit.
3. Before launching a Sandboxed Agent for an open AFK Issue, the outer krutrimbox checks whether any Blocking Issues named in the current issue's `Blocked by` section are resolved.
4. If the outer check finds an unresolved Blocking Issue, krutrimbox comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, and exits the Factory Run.
5. An open AFK Issue whose Blocking Issues are resolved is delegated to a fresh non-resumed Sandboxed Agent session (the run's Agent Backend) inside a Docker sandbox.
6. The Sandboxed Agent session receives the Target Issue body and the current Implementation Issue body as its task context.
7. Before implementation, the Sandboxed Agent session verifies Blocking Issues again with Read-Only GitHub Access.
8. If a Blocking Issue is not resolved, the Sandboxed Agent session throws an error; krutrimbox catches that error, comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, and exits the Factory Run.
9. If Blocking Issues are resolved, the Sandboxed Agent session checks out or creates the Target Issue Branch and implements the AFK Issue.
10. After the Sandboxed Agent exits successfully, the outer krutrimbox creates a commit with a fixed commit message, includes `Refs #<issue-number>`, pushes the Target Issue Branch, and creates or reuses the Target Issue Pull Request using the Authenticated GitHub User.
11. krutrimbox does not close the completed issue. The branch footer moves it into the Done Set, and GitHub closes it only when the pull request merges.

Sandbox Success trusts the Sandboxed Agent session's successful process exit followed by the outer krutrimbox committing and pushing the resulting changes. Agent verification can be tightened later.

The fixed commit message is:

```text
chore: krutrimbox implementation

Refs #<issue-number>
```

krutrimbox creates one commit per completed AFK Issue, even when multiple AFK Issues run during the same Factory Run.

The outer krutrimbox stages all working tree changes inside the Target Issue Sandbox private clone after the Sandboxed Agent succeeds. The outer krutrimbox is responsible for committing, pushing the Target Issue Branch, creating or updating the Target Issue Pull Request, and changing the Target Issue Pull Request from draft to ready for review.

The MVP treats a successful Sandboxed Agent process exit (`codex exec` or `claude -p`, per the run's Agent Backend) as the completion signal. Structured output can be introduced later if the completion signal proves too loose or difficult for krutrimbox to interpret.

Each AFK Issue gets a fresh Sandboxed Agent context window. The Factory Run may reuse the Target Issue Branch for code continuity, but it must not resume a previous agent conversation between Implementation Issues.

Sandboxed Agent sessions are launched with explicit non-interactive settings per Agent Backend: `codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox` or `claude -p --dangerously-skip-permissions`. Docker Sandbox clone mode provides the outer isolation boundary; the inner agent process must not pause for approvals because no human is attached to the AFK Issue session.

Only the outer krutrimbox owns GitHub orchestration state and git commit/push operations. The Sandboxed Agent implements the AFK Issue and reports completion, and may use Read-Only GitHub Access for inspection, but must not create commits, push branches, close issues, create or edit the Target Issue Pull Request, change labels, post comments, or change Target Issue state.

krutrimbox maintains a deterministic Target Issue Pull Request Body from current GitHub state using `templates/pr-body.md`. The body contains `Closes #<issue-number>` keywords for the Target Issue and every Implementation Issue, lists the Implementation Issues as a Done Set checklist, and includes krutrimbox branch and sandbox metadata. The Sandboxed Agent does not edit the Target Issue Pull Request Body.

The Target Issue Pull Request is created as a draft and remains draft while any Implementation Issue remains open.

The Target Issue Branch name is deterministic: `krutrimbox/issue-<target-issue-number>`.

The Target Issue Pull Request title uses a fixed krutrimbox format: `krutrimbox #<target-issue-number>: <target-issue-title>`.

The Target Issue Pull Request targets the repository default branch.

krutrimbox applies only the `krutrimbox` label to the Target Issue Pull Request.

When reusing an existing Target Issue Pull Request, krutrimbox identifies it by the deterministic Target Issue Branch, not by title.

## Sandboxed Agent Prompt

For each AFK Issue, krutrimbox generates a strict per-issue prompt for the fresh Sandboxed Agent session. The prompt includes the full Target Issue body, the current AFK Issue body, earlier Implementation Issue numbers, titles, and current state, lightweight future Implementation Issue context, the Target Issue Branch name, and explicit boundaries that the Sandboxed Agent may inspect GitHub with read-only commands but must not mutate GitHub state, create commits, push branches, or process future Implementation Issues. Lightweight future context includes issue numbers, titles, type, and blocked-by relationships, not full future issue bodies.

The custom prompt must instruct the Sandboxed Agent to work on exactly one AFK Issue: the current issue. The Sandboxed Agent must not implement future Implementation Issues, even when future issue metadata is included for awareness.

The Sandboxed Agent prompt is a versioned prompt template under `prompts/`, such as `prompts/afk-issue.md`, rather than an ad hoc shell string.

## HITL Resume

When a Factory Run stops at a HITL Issue, a human resolves the issue outside krutrimbox and pushes a `Refs #<issue-number>` commit to the Target Issue Branch. A later Factory Run against the same Target Issue skips the Done Set issue and continues to the next open Implementation Issue.

krutrimbox does not remove `ready-for-agent` from the Target Issue when it stops at a HITL Issue. If the Target Issue is discovered again before the HITL footer exists, the next Factory Run reaches the same open HITL Issue and exits again.

HITL comments on the Target Issue use `templates/hitlpause-comment.md` with a Factory Comment Marker keyed by the Target Issue and HITL Issue. Repeated Factory Runs update or skip the existing marked comment instead of posting duplicate comments.

Helpful error comments on AFK Issues use `templates/afk-error-comment.md` with Factory Comment Markers keyed by the issue and error class, so repeated Factory Runs update or skip the existing marked comment instead of posting duplicate comments.

The MVP does not automatically retry failed Sandboxed Agent runs. If the Sandboxed Agent exits non-zero or the outer krutrimbox fails to commit or push, krutrimbox comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, keeps the Target Issue Sandbox for debugging, and exits the Factory Run.

If commit or push fails after the Sandboxed Agent exits successfully, krutrimbox treats the issue as incomplete. The error comment includes the Target Issue Sandbox name, Target Issue Branch name, failed command summary, cleanup command, and rerun command.

Factory Run logs are written to per-Target-Issue log files under `.krutrimbox/logs`. Durable GitHub comments are reserved for actionable states such as HITL pauses, unresolved blockers, and AFK issue errors.

## Final Review

When every Implementation Issue in the Implementation Sequence is in the Done Set, krutrimbox starts a fresh non-resumed Sandboxed Agent session (the run's Agent Backend) inside the same Target Issue Sandbox to review the Target Issue Pull Request diff against the Target Issue and Implementation Issue intent. The review session outputs a Markdown review body, and the outer krutrimbox posts it as a normal pull request comment using `templates/final-review-comment.md`. The final review comment uses a Factory Comment Marker so repeated Factory Runs update or skip the existing comment.

The final review session may use read-only `gh` commands for inspection, but it must not mutate files or GitHub state. The outer krutrimbox captures the review Markdown, posts or updates the pull request comment through host `gh`, marks the Target Issue Pull Request ready for review, and routes or tags the Final Reviewer.

After the review comment is posted, krutrimbox marks the Target Issue Pull Request ready for review and requests review from the Target Issue Author when they differ from the pull request author; when they are the same user, krutrimbox tags the Target Issue Author in a comment instead of requesting self-review.

Future review prompts may invoke a project-local review skill from `.agents/skills`.

The Target Issue remains open while implementation is in progress. The Target Issue and its Implementation Issues close when the Target Issue Pull Request is merged using GitHub's linked pull request behavior.

krutrimbox leaves Target Issue labels unchanged when the Target Issue Pull Request becomes ready for review.

krutrimbox never merges the Target Issue Branch into the default branch. A human performs the final merge and may choose the final squash commit message.

## Sandbox Cleanup

The Factory Run uses a deterministic Target Issue Sandbox name derived from the Target Issue number: `krutrimbox-issue-<target-issue-number>`. When the Target Issue completes and final review routing is done, krutrimbox removes the Target Issue Sandbox automatically. When the Factory Run exits for HITL or an error, it keeps the Target Issue Sandbox for debugging and includes the cleanup command in the relevant comment or log.
