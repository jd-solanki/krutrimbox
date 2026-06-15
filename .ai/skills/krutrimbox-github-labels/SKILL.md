---
name: github-labels
description: Select the correct GitHub labels for issues and pull requests in krutrimbox's Target Issue flow. Use when creating, updating, or reviewing GitHub issues or PRs, especially from the to-prd and to-issues workflows.
---

# GitHub Labels

Use this skill to choose issue and PR labels before publishing or updating GitHub tracker items. Apply the smallest accurate label set, and if a required label does not exist in the repository, create it with GitHub CLI before applying it.

krutrimbox discovers a **Target Issue** as an open issue labeled `ready-for-agent` that has **no parent issue**. A Target Issue is either *Standalone* (no sub-issues; its own body is the work) or a *Parent* (its native GitHub sub-issues are the **Implementation Issues**). Membership in a Parent Target Issue is the native sub-issue link, not a label. The retired `PRD` and `PRD-sub-issue` labels are no longer used.

## Quick Start

- Standalone Target Issue, fully specified: apply `ready-for-agent`
- Parent Target Issue: apply `ready-for-agent` only after every Implementation Issue has been created and linked
- Implementation Issue (sub-issue): apply exactly one of `ready-for-agent` or `ready-for-human` (no membership label — the native sub-issue link is the membership)
- Unevaluated issue: apply `needs-triage`, or `needs-info` when a specific answer is required
- Pull request opened by krutrimbox: `krutrimbox`

## Labels

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | Fully specified and ready for an AFK agent — the discovery signal on a Target Issue, and the AFK-readiness marker on an Implementation Issue |
| `ready-for-human` | An Implementation Issue that requires human work before krutrimbox can continue (HITL) |
| `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | Waiting on the reporter for more information |
| `wontfix` | Will not be actioned |
| `krutrimbox` | Pull request created and maintained by krutrimbox |

## Labeling Workflow

1. Identify the artifact: Standalone Target Issue, Parent Target Issue, Implementation Issue (sub-issue), or pull request.
2. Decide whether the work is specified enough to start.
3. For a **Standalone Target Issue** (self-contained, no sub-issues): apply `ready-for-agent` when it is fully specified with clear acceptance criteria; otherwise `needs-triage` or `needs-info`. No parent and no PRD ceremony are required.
4. For a **Parent Target Issue**: keep it at `needs-triage` until every approved Implementation Issue has been created and linked as a native sub-issue, then apply `ready-for-agent` so krutrimbox discovers it and walks its sub-issues.
5. For an **Implementation Issue** (native sub-issue): apply exactly one state label — `ready-for-agent` (AFK) or `ready-for-human` (HITL). Do not add a membership label; the native sub-issue link is the membership.
6. For a **pull request**: krutrimbox labels its own PR `krutrimbox`. Mirror an issue's readiness on a PR only if the repository conventionally does so.

## Missing Labels

Before applying labels, check whether the repository already has them. If a required label is missing, create it with GitHub CLI, using the meaning from the table as its description:

```sh
gh label create "ready-for-agent" --description "Fully specified, ready for an AFK agent"
gh label create "krutrimbox" --description "Pull request created and maintained by krutrimbox"
```

## Guidance

- Use `ready-for-agent` for AFK-friendly work with clear scope, acceptance criteria, and no unresolved human decision.
- For a Parent Target Issue, apply `ready-for-agent` only after every approved Implementation Issue exists and is linked — never before.
- Use `ready-for-human` when implementation needs human judgment, design review, stakeholder input, or sensitive access.
- Use `needs-info` when a specific missing answer blocks useful progress.
- Use `needs-triage` when the issue exists but has not yet been evaluated.
- Use `wontfix` only when the decision not to act is explicit.
