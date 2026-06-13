# Krutrimbox

Krutrimbox is a code factory that turns approved PRDs and their ordered implementation issues into coordinated agent work, human handoffs, and final review routing.

## Language

**krutrimbox**:
A GitHub-driven orchestrator that finds ready PRDs, walks their ordered sub-issues, delegates AFK issues to fresh isolated agent sessions, pauses on HITL issues, and coordinates review handoffs.
_Avoid_: autonomous krutrimbox, factory, coding agent

**Sandboxed Agent**:
The fresh Codex session delegated to implement one AFK Issue inside the PRD Sandbox. It changes code and reports completion, but does not own GitHub issue state.
_Avoid_: worker, implementer, inner agent

**Read-Only GitHub Access**:
Permission for a Sandboxed Agent to inspect GitHub state with non-mutating GitHub CLI commands while leaving issue, pull request, and label mutations to krutrimbox.
_Avoid_: GitHub access, gh permissions, live state

**PRD**:
A GitHub issue containing an approved product and implementation plan plus its ordered implementation issues.
_Avoid_: spec, plan, parent ticket

**Factory Run**:
One execution attempt by krutrimbox against a PRD using the current state of its implementation issues. A PRD can have multiple Factory Runs when human input pauses progress and later unblocks the next actionable issue.
_Avoid_: trigger, retry, loop

**Explicit Run**:
A Factory Run started for one specified PRD.
_Avoid_: manual run, single run, targeted run

**Batch Run**:
A Factory Run mode that discovers open PRDs labeled `PRD` and `ready-for-agent` and processes them one at a time.
_Avoid_: sweep, queue run, all run

**Implementation Issue**:
A PRD sub-issue, linked to its PRD through GitHub's native sub-issue relationship, that represents one ordered slice of work for a PRD. An Implementation Issue is either agent-ready or requires human input before krutrimbox can continue.
_Avoid_: task, ticket, child issue

**Implementation Sequence**:
The ordered set of Implementation Issues that krutrimbox evaluates and completes for a PRD.
_Avoid_: issue list, checklist, queue

**Blocking Issue**:
An Implementation Issue listed in another Implementation Issue's `Blocked by` section and expected to be resolved before that dependent issue begins.
_Avoid_: blocked task, dependency, prerequisite

**AFK Issue**:
An Implementation Issue labeled `ready-for-agent`, meaning it is ready for an agent to implement without human interaction.
_Avoid_: autonomous issue, agent issue, ready issue

**HITL Issue**:
An Implementation Issue labeled `ready-for-human`, meaning krutrimbox must pause until a human provides the required input or completes the required human work.
_Avoid_: human issue, blocked issue, manual issue

**Resolved Issue**:
An Implementation Issue that is closed in GitHub. krutrimbox treats closed Implementation Issues as already handled when a later Factory Run resumes a PRD.
_Avoid_: done issue, completed task, skipped issue

**Issue Reference Footer**:
A non-closing commit footer in the form `Refs #<issue-number>` that links a commit to an Implementation Issue without relying on GitHub's PR-merge auto-close behavior.
_Avoid_: closes footer, closing keyword, auto-close footer

**PRD Branch**:
The shared branch for all agent changes made while delivering one PRD.
_Avoid_: issue branch, feature branch, work branch

**PRD Pull Request**:
The single pull request for a PRD Branch that accumulates all AFK Issue commits and receives final review after every Implementation Issue is resolved.
_Avoid_: implementation PR, issue PR, factory PR

**PRD Pull Request Body**:
The deterministic pull request description generated and maintained by krutrimbox from current PRD and Implementation Issue state.
_Avoid_: PR notes, agent summary, pull request description

**Authenticated GitHub User**:
The GitHub account used by krutrimbox to create branches, commits, pull requests, comments, and issue state changes.
_Avoid_: bot, service account, actor

**PR Author**:
The Authenticated GitHub User that creates the PRD Pull Request.
_Avoid_: bot author, factory author, reviewer

**PRD Author**:
The human GitHub user who created the parent PRD issue and owns acceptance of the requested work.
_Avoid_: reporter, requester, owner

**Factory-Owned PRD**:
A PRD authored by `jd-solanki`, making it eligible for krutrimbox processing.
_Avoid_: eligible PRD, owned issue, my PRD

**Final Reviewer**:
The human reviewer selected for the completed PRD Pull Request after krutrimbox posts its review.
_Avoid_: PR author, approver, maintainer

**Sandbox Success**:
The condition where a sandboxed agent session exits successfully after implementing an AFK Issue.
_Avoid_: agent done, run passed, implementation complete

**PRD Sandbox**:
The Docker sandbox used by krutrimbox while delivering one PRD. It may be reused across AFK Issues for code and dependency continuity, while Codex sessions inside it remain fresh per issue.
_Avoid_: container, VM, issue sandbox

**krutrimbox Sandbox Template**:
The custom Docker Sandboxes template image used for PRD Sandboxes. It extends Docker's Codex sandbox template with repository-required tools, currently `pnpm`, so fresh Sandboxed Agent sessions have the same package-manager surface krutrimbox expects.
_Avoid_: Dockerfile, base image, custom container

**Sandbox Template Store**:
Docker Sandboxes' template image store, populated with `sbx template load` from a saved Docker image tar. A locally built Docker image is not enough by itself; `sbx create --template` resolves images from the sandbox template store or a registry.
_Avoid_: Docker image cache, local image list, registry

**Sandbox Workspace Path**:
The absolute repository path passed to `sbx create` and `sbx exec --workdir`. Clone-mode sandboxes expose the private repository clone at this path, while plain `sbx exec` starts elsewhere and may not be inside a Git repository.
_Avoid_: cwd, working directory, repo path

**PRD Lock**:
A local lock that prevents more than one Factory Run from processing the same PRD at the same time.
_Avoid_: mutex, concurrency guard, run lock

**Factory Comment Marker**:
A hidden HTML marker in a krutrimbox comment that lets later Factory Runs update or skip the same comment instead of posting duplicates.
_Avoid_: comment tag, marker, dedupe token
