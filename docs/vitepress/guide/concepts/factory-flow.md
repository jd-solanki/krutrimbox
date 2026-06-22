# krutrimbox Flow

krutrimbox starts from a Target Issue: an open issue labeled `ready-for-agent`, assigned to the Operator, with no parent issue. A Target Issue can be Standalone, where its own body is the unit of work, or a Parent Target Issue, where sub-issues form the ordered Implementation Sequence. Sub-issues are discovered through [GitHub's native sub-issue feature](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues) — the built-in parent/child relationship, not task-list checkboxes or `## Parent` body sections (ADR-0001).

The MVP supports Explicit Runs for a specified Target Issue and Batch Runs that discover eligible Target Issues. Batch Runs process discovered Target Issues sequentially in issue-number order. A HITL pause or issue-level error stops the current Target Issue but does not stop the rest of the Batch Run unless the factory itself hits a fatal error.

Before discovery or processing, krutrimbox ensures required GitHub labels exist: `krutrimbox`, `ready-for-agent`, and `ready-for-human`.

Batch Run discovery filters for issues assigned to the Operator (`assignee:@me`) when listing candidate Target Issues, so issues assigned to other users — or to nobody — are not discovered. The Operator is the authenticated `gh` user; a solo developer who labels but does not assign can run with `--implement-unassigned` to also pick up zero-assignee issues.

Explicit Runs are entered by the parent issue id (`kb run --issue <parent>`) and route work by assignee. See [Issue Ownership & Routing](./issue-ownership-and-routing) for the full ownership model, the Due Issue walk, and how teams split a Parent Target Issue's sub-issues across people (ADR-0017, ADR-0018, ADR-0019).

## Target Issue Setup

1. The Target Issue exists in GitHub, is open, and is labeled `ready-for-agent`.
2. The Target Issue is assigned to the Operator (or the run uses `--implement-unassigned` for a zero-assignee issue).
3. The Target Issue has no parent issue.
4. If the Target Issue has no attached sub-issues, it is treated as its own single AFK Implementation Issue.
5. If the Target Issue has attached sub-issues, each Implementation Issue is linked through GitHub's native sub-issue relationship.
6. Each open Implementation Issue has exactly one state label: `ready-for-agent` or `ready-for-human`.
7. krutrimbox builds the Implementation Sequence by sorting Implementation Issues by GitHub issue number.

## Factory Run

Each Factory Run rebuilds the Implementation Sequence from GitHub state and the Done Set, then walks it from first to last.

Before processing a Target Issue, krutrimbox acquires a Target Issue Lock. For the MVP, the lock is local to the single machine running the factory.

If a Target Issue is already locked, krutrimbox skips it and continues.

krutrimbox uses Docker Sandbox clone mode for Target Issue Sandboxes. The host repository is the launch/source repository, but Target Issue Branch checkout, file changes, and commits happen inside the Target Issue Sandbox private clone rather than the host working tree. The push to `origin` is the exception: it runs on the host (see below) so the sandbox never needs a write credential. The Target Issue Branch is created from a clean origin ref (`origin/<base-branch>`, or `origin/<branch>` on resume), never from the sandbox clone's checked-out HEAD, so host working-tree state and local unpushed commits never leak into it.

Target Issue Sandboxes are created from the krutrimbox Sandbox Template for the run's Agent Backend (`docker.io/library/krutrimbox-codex:pnpm` or `docker.io/library/krutrimbox-claude:pnpm`), so Sandboxed Agents have repository-required tooling such as `pnpm` available before implementation starts. See [Sandbox Template](/guide/sandbox-template) for machine setup and template loading instructions.

The outer TypeScript krutrimbox runs implementation git commands inside the Target Issue Sandbox: branch checkout, staging, and committing. Publishing the commit is split out — the host fetches the new commit from the Docker-managed `sandbox-<name>` remote that clone mode exposes, then pushes it to `origin` with the host's own git credentials. Keeping the push on the host is what lets the injected sandbox `github` secret be read-only.

The outer krutrimbox passes the absolute repository path to `sbx create` and uses that same path with `sbx exec --workdir`. In clone mode, the private repository clone is available at that path inside the sandbox; Docker Sandboxes' default exec directory is not guaranteed to be a Git repository.

GitHub mutation commands run from the host through the outer krutrimbox's authenticated `gh` session. The Sandboxed Agent may use read-only `gh` commands for inspection, and sandbox git commands mutate only the Target Issue Sandbox private clone.

For sandbox `gh` access and HTTPS GitHub reads, operators store a read-only token as Docker Sandboxes' built-in `github` secret, as documented in [Authentication](/guide/authentication); the host push uses the operator's own `gh`/git credentials and is the only write path. Existing sandboxes created before the secret is configured must be recreated or given a sandbox-scoped `github` secret. If the host push or the sandbox's read-only `gh`/`fetch` fails because credentials are unavailable, krutrimbox treats it as an environment error and stops the current Target Issue.

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
10. After the Sandboxed Agent exits successfully, the outer krutrimbox creates a commit whose subject is the Implementation Issue title, includes `Refs #<issue-number>`, pushes the Target Issue Branch, and creates or reuses the Target Issue Pull Request using the Authenticated GitHub User.
11. krutrimbox does not close the completed issue. The branch footer moves it into the Done Set, and GitHub closes it only when the pull request merges.

Sandbox Success trusts the Sandboxed Agent session's successful process exit followed by the outer krutrimbox committing and pushing the resulting changes. Agent verification can be tightened later.

The commit message uses the Implementation Issue title as its subject, with the Issue Reference Footer below. For a Standalone Target Issue the subject is the Target Issue's own title; for a Parent Target Issue each commit's subject is the title of the sub-issue it delivers:

```text
<implementation-issue-title>

Refs #<issue-number>
```

krutrimbox creates one commit per completed AFK Issue, even when multiple AFK Issues run during the same Factory Run.

The outer krutrimbox stages all working tree changes inside the Target Issue Sandbox private clone after the Sandboxed Agent succeeds. The outer krutrimbox is responsible for committing, pushing the Target Issue Branch, creating or updating the Target Issue Pull Request, and changing the Target Issue Pull Request from draft to ready for review.

The MVP treats a successful Sandboxed Agent process exit (`codex exec` or `claude -p`, per the run's Agent Backend) as the completion signal. Structured output can be introduced later if the completion signal proves too loose or difficult for krutrimbox to interpret.

Each AFK Issue gets a fresh Sandboxed Agent context window. The Factory Run may reuse the Target Issue Branch for code continuity, but it must not resume a previous agent conversation between Implementation Issues.

Sandboxed Agent sessions are launched with explicit non-interactive settings per Agent Backend: `codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox` or `claude -p --dangerously-skip-permissions`. Docker Sandbox clone mode provides the outer isolation boundary; the inner agent process must not pause for approvals because no human is attached to the AFK Issue session.

Only the outer krutrimbox owns GitHub orchestration state and git commit/push operations. The Sandboxed Agent implements the AFK Issue and reports completion, and may use Read-Only GitHub Access for inspection, but must not create commits, push branches, close issues, create or edit the Target Issue Pull Request, change labels, post comments, or change Target Issue state.

krutrimbox maintains a deterministic Target Issue Pull Request Body from current GitHub state using the built-in `templates/pull-request-body.md` (overridable via the `pullRequestBody` Template Slot). The body contains `Closes #<issue-number>` keywords for the Target Issue and every Implementation Issue, lists the Implementation Issues as a Done Set checklist, and includes krutrimbox branch and sandbox metadata. The Sandboxed Agent does not edit the Target Issue Pull Request Body.

The Target Issue Pull Request is created as a draft and remains draft while any Implementation Issue remains open.

The Target Issue Branch name is deterministic: `krutrimbox/issue-<target-issue-number>`.

The Target Issue Pull Request title is the Target Issue title verbatim.

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

HITL comments on the Target Issue use the built-in `templates/hitl-pause-comment.md` (overridable via the `hitlPauseComment` Template Slot) with a Factory Comment Marker keyed by the Target Issue and HITL Issue. krutrimbox injects the marker outside the template body, so a custom comment template cannot break idempotency: repeated Factory Runs update or skip the existing marked comment instead of posting duplicate comments.

Helpful error comments on AFK Issues use `templates/afk-error-comment.md` with Factory Comment Markers keyed by the issue and error class, so repeated Factory Runs update or skip the existing marked comment instead of posting duplicate comments.

The MVP does not automatically retry failed Sandboxed Agent runs. If the Sandboxed Agent exits non-zero or the outer krutrimbox fails to commit or push, krutrimbox comments on the current AFK Issue with a helpful idempotent error comment, leaves the issue open, keeps the Target Issue Sandbox for debugging, and exits the Factory Run.

If commit or push fails after the Sandboxed Agent exits successfully, krutrimbox treats the issue as incomplete. The error comment includes the Target Issue Sandbox name, Target Issue Branch name, failed command summary, cleanup command, and rerun command.

Factory Run logs are written to per-Target-Issue log files under `.krutrimbox/logs`. Durable GitHub comments are reserved for actionable states such as HITL pauses, unresolved blockers, and AFK issue errors.

## Lifecycle Hooks

krutrimbox fires named lifecycle hooks (via [`hookable`](https://github.com/unjs/hookable)) at key points, and a repository attaches **Hook Actions** to them under the `hooks` key in `.krutrimbox/config.json`, keyed by hook name (see [Configuration](/guide/configuration#hooks)). The first hook is `pull-request:ready`: when every Implementation Issue in the Implementation Sequence is in the Done Set, krutrimbox marks the Target Issue Pull Request **ready for review** — the only built-in behavior — and then fires `pull-request:ready` against the now-ready pull request. With no actions configured, krutrimbox only marks the pull request ready.

Marking the pull request ready is also the run-once guard: a later Factory Run, or Batch re-discovery of a completed-but-unmerged Target Issue, finds a ready pull request and skips the hook. Actions run in order and fail fast — the first failing action aborts with an error naming it, and because the pull request is already ready, the operator fixes the action and re-runs.

A Hook Action is one of three kinds:

- **Agent action** — a fresh non-resumed Sandboxed Agent session (the run's Agent Backend) in the same Target Issue Sandbox, driven by an operator-authored prompt. It runs with Read-Only GitHub Access, so it gathers context itself (for example `gh pr diff`) and never mutates GitHub. Its text output is captured for later actions as `{{steps.<id>.output}}`; if it changed code, the outer krutrimbox commits and pushes that change from the host with a message referencing the action (no `Refs` footer, so it stays out of the Done Set).
- **Comment action** — the outer krutrimbox posts the action's body, with variables interpolated, as a pull request comment.
- **Command action** — the outer krutrimbox runs one allowlisted `gh` command on the host with the Operator's credential.

As with implementation, every GitHub write happens on the host: Agent Action commits and Command Actions run host-side, while the sandbox keeps Read-Only GitHub Access.

The Target Issue remains open while implementation is in progress. The Target Issue and its Implementation Issues close when the Target Issue Pull Request is merged using GitHub's linked pull request behavior.

krutrimbox leaves Target Issue labels unchanged when the Target Issue Pull Request becomes ready for review.

krutrimbox never merges the Target Issue Branch into the default branch. A human performs the final merge and may choose the final squash commit message.

## Sandbox Cleanup

The Factory Run uses a deterministic Target Issue Sandbox name derived from the Target Issue number: `krutrimbox-issue-<target-issue-number>`. When the Target Issue completes and its `pull-request:ready` hook finishes, krutrimbox removes the Target Issue Sandbox it created automatically. When the Factory Run exits for HITL or an error, it keeps the Target Issue Sandbox for debugging and includes the cleanup command in the relevant comment or log.
