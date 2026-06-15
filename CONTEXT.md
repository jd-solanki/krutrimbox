# Krutrimbox

Krutrimbox is a code factory that turns agent-ready GitHub issues — standalone or with ordered sub-issues — into coordinated agent work, human handoffs, and final review routing.

## Language

**krutrimbox**:
A GitHub-driven orchestrator that finds agent-ready Target Issues, implements them directly or walks their ordered sub-issues, delegates AFK work to fresh isolated agent sessions, pauses on HITL issues, and coordinates review handoffs.
_Avoid_: autonomous krutrimbox, factory, coding agent

**Sandboxed Agent**:
The fresh Codex session delegated to implement one AFK Issue inside the Target Issue Sandbox. It changes code and reports completion, but does not own GitHub issue state.
_Avoid_: worker, implementer, inner agent

**Read-Only GitHub Access**:
Permission for a Sandboxed Agent to inspect GitHub state with non-mutating GitHub CLI commands while leaving issue, pull request, and label mutations to krutrimbox.
_Avoid_: GitHub access, gh permissions, live state

**Target Issue**:
The discoverable GitHub issue a Factory Run targets: agent-ready (labeled `ready-for-agent`) and not itself a sub-issue of any other issue. It is either Standalone or a Parent Target Issue.
_Avoid_: root issue, main issue, parent ticket, PRD

**Standalone Target Issue**:
A Target Issue with no attached sub-issues, whose own body is the unit of work; krutrimbox implements it directly as a sequence of one.
_Avoid_: single issue, simple issue, lone issue

**Parent Target Issue**:
A Target Issue with attached sub-issues, whose body is implementation context only; krutrimbox implements its ordered Implementation Issues rather than the body.
_Avoid_: epic, PRD, parent ticket

**PRD**:
Informal shorthand for a Parent Target Issue whose body is a product and implementation plan. Not a label or a requirement — just one shape a Target Issue can take.
_Avoid_: spec, plan, the PRD label

**Factory Run**:
One execution attempt by krutrimbox against a Target Issue using the current state of its work. A Target Issue can have multiple Factory Runs when human input pauses progress and later unblocks the next actionable issue.
_Avoid_: trigger, retry, loop

**Project Configuration**:
Shared repository policy that changes how krutrimbox behaves for every operator of that repository. Project Configuration is reviewed and versioned with the repository, unlike local runtime state.
_Avoid_: local settings, personal settings, machine settings

**Project Configuration Directory**:
The repository-owned `.krutrimbox/` directory that holds shared krutrimbox Project Configuration, including configurable comment template files. Runtime-only subdirectories under it remain local state.
_Avoid_: state directory, cache directory, local config directory

**Template Slot**:
A named, user-configurable piece of krutrimbox output text, such as the Target Issue Pull Request Body or a comment body. Each Template Slot has a built-in default and may be replaced by a repository-owned Markdown file.
_Avoid_: template path, template key, internal template name

**Explicit Run**:
A Factory Run started for one specified Target Issue.
_Avoid_: manual run, single run, targeted run

**Batch Run**:
A Factory Run mode that discovers open Target Issues — labeled `ready-for-agent` and having no parent issue — and processes them one at a time.
_Avoid_: sweep, queue run, all run

**Implementation Issue**:
A sub-issue linked to a Parent Target Issue through GitHub's native sub-issue relationship, representing one ordered slice of its work. A Standalone Target Issue acts as its own single Implementation Issue. An Implementation Issue is either agent-ready or requires human input before krutrimbox can continue.
_Avoid_: task, ticket, child issue

**Implementation Sequence**:
The ordered set of Implementation Issues that krutrimbox evaluates and completes for a Target Issue.
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
An Implementation Issue whose number appears in the Done Set, meaning krutrimbox treats it as already handled and skips it when a later Factory Run resumes a Target Issue. Resolution is derived from the Done Set, not from GitHub's open/closed state.
_Avoid_: closed issue, done issue, completed task

**Done Set**:
The set of Implementation Issue numbers that already have an Issue Reference Footer commit on the Target Issue Branch — krutrimbox's authoritative ledger of completed work, rebuilt fresh each Factory Run by scanning the branch.
_Avoid_: progress ledger, checklist state, closed issues

**Issue Reference Footer**:
A non-closing commit footer in the form `Refs #<issue-number>` that links a commit to an Implementation Issue and serves as the Done Set marker krutrimbox scans to know that issue is complete. Completed AFK work carries it from the Sandboxed Agent; completed HITL work carries it from a human commit.
_Avoid_: closes footer, closing keyword, auto-close footer

**Target Issue Branch**:
The shared branch (`krutrimbox/issue-<number>`) for all changes made while delivering one Target Issue.
_Avoid_: PRD branch, issue branch, feature branch

**Target Issue Pull Request**:
The single pull request for a Target Issue Branch that accumulates all commits, carries the `Closes #<number>` keywords that auto-close the Target Issue and its Implementation Issues on merge, and receives final review once every Implementation Issue is resolved.
_Avoid_: PRD pull request, implementation PR, issue PR

**Target Issue Pull Request Body**:
The deterministic pull request description generated and maintained by krutrimbox: it carries the `Closes` keywords and a derived checklist projection of the Done Set, and is never read back as a source of truth.
_Avoid_: PR notes, agent summary, progress checklist

**Authenticated GitHub User**:
The GitHub account used by krutrimbox to create branches, commits, pull requests, comments, and issue state changes.
_Avoid_: bot, service account, actor

**PR Author**:
The Authenticated GitHub User that creates the Target Issue Pull Request.
_Avoid_: bot author, factory author, reviewer

**Target Issue Author**:
The human GitHub user who created the Target Issue and owns acceptance of the requested work.
_Avoid_: PRD author, reporter, requester

**Factory-Owned Target Issue**:
A Target Issue authored by `jd-solanki`, making it eligible for krutrimbox processing.
_Avoid_: eligible issue, owned issue, my PRD

**Final Reviewer**:
The human reviewer selected for the completed Target Issue Pull Request after krutrimbox posts its review.
_Avoid_: PR author, approver, maintainer

**Sandbox Success**:
The condition where a sandboxed agent session exits successfully after implementing an AFK Issue.
_Avoid_: agent done, run passed, implementation complete

**Target Issue Sandbox**:
The Docker sandbox used by krutrimbox while delivering one PRD. It may be reused across AFK Issues for code and dependency continuity, while Codex sessions inside it remain fresh per issue.
_Avoid_: container, VM, issue sandbox

**krutrimbox Sandbox Template**:
The custom Docker Sandboxes template image used for Target Issue Sandboxes. It extends Docker's Codex sandbox template with repository-required tools, currently `pnpm`, so fresh Sandboxed Agent sessions have the same package-manager surface krutrimbox expects.
_Avoid_: Dockerfile, base image, custom container

**Sandbox Template Store**:
Docker Sandboxes' template image store, populated with `sbx template load` from a saved Docker image tar. A locally built Docker image is not enough by itself; `sbx create --template` resolves images from the sandbox template store or a registry.
_Avoid_: Docker image cache, local image list, registry

**Sandbox Workspace Path**:
The absolute repository path passed to `sbx create` and `sbx exec --workdir`. Clone-mode sandboxes expose the private repository clone at this path, while plain `sbx exec` starts elsewhere and may not be inside a Git repository.
_Avoid_: cwd, working directory, repo path

**Target Issue Lock**:
A local lock that prevents more than one Factory Run from processing the same Target Issue at the same time.
_Avoid_: mutex, concurrency guard, run lock

**Factory Comment Marker**:
A hidden HTML marker in a krutrimbox comment that lets later Factory Runs update or skip the same comment instead of posting duplicates.
_Avoid_: comment tag, marker, dedupe token

## Relationships

- A **Target Issue** is either **Standalone** (zero sub-issues, body is the work) or a **Parent Target Issue** (one or more **Implementation Issues**, body is context).
- A **Parent Target Issue** has one or more **Implementation Issues**; a **Standalone Target Issue** acts as its own single **Implementation Issue**.
- A **Target Issue** has exactly one **Target Issue Branch**, one **Target Issue Pull Request**, one **Target Issue Sandbox**, and one **Target Issue Lock**.
- An **Implementation Issue** is in the **Done Set** once it has an **Issue Reference Footer** commit on the **Target Issue Branch**; the **Target Issue Pull Request** auto-closes every Done Set issue (and the Target Issue) on merge.
- A **Factory Run** processes a **Target Issue**, pauses at the first **HITL Issue**, and routes the **Target Issue Pull Request** to the **Final Reviewer** once every **Implementation Issue** is Resolved.

## Flagged ambiguities

- The `ready-for-agent` label is used both to make a **Target Issue** discoverable and to mark an **AFK Issue** ready. These never collide because discovery additionally requires _no parent issue_ — a sub-issue carrying `ready-for-agent` is reached only by walking down from its Parent Target Issue, never discovered as a Target Issue itself.
- "PRD" was previously the root concept and a required label. Resolved: the root concept is now the **Target Issue**; "PRD" is informal shorthand for one shape (a Parent Target Issue whose body is a plan), and the `PRD` / `PRD-sub-issue` labels are retired.
- "Resolved" no longer means GitHub-closed. Resolved: an Implementation Issue is resolved when it is in the **Done Set** (an Issue Reference Footer commit exists); krutrimbox closes nothing during a run — issues auto-close on **Target Issue Pull Request** merge.
