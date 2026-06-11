---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

Invoke the `github-labels` skill before publishing so each generated issue gets the correct GitHub labels.

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. Publish AFK slices with `PRD-sub-issue` and `ready-for-agent`; publish HITL slices with `PRD-sub-issue` and `ready-for-human` unless instructed otherwise.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

When the source is an existing PRD issue, each generated child issue MUST be attached to that PRD using GitHub's sub-issue feature. Create child issues with `gh api` so the REST issue `id` is available immediately, then call the sub-issues endpoint before moving to the next slice:

```sh
child_json=$(gh api repos/{owner}/{repo}/issues \
  -f title="$title" \
  -F body=@"$body_file" \
  -f 'labels[]=PRD-sub-issue' \
  -f "labels[]=$readiness_label")
child_id=$(printf '%s' "$child_json" | jq -r '.id')
gh api -X POST repos/{owner}/{repo}/issues/PARENT_NUMBER/sub_issues \
  -F sub_issue_id="$child_id"
```

Use the child issue number or URL in later "Blocked by" references, but use the numeric REST `id` as `sub_issue_id`. If the sub-issue API call fails, stop and resolve it; do not treat the child issue as published for this workflow until the parent-child relationship exists.

After all issues for an existing parent PRD have been created, apply `ready-for-agent` to the parent PRD issue. This marks that the PRD has been broken down and is ready for agents to pick up its child work. Do not apply `ready-for-agent` to the parent before every approved slice has a published issue.

<issue-template>
## What to build
A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by
- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</issue-template>

Do NOT close or otherwise modify any parent issue. The only allowed parent update in this workflow is adding `ready-for-agent` after all child issues have been created.
