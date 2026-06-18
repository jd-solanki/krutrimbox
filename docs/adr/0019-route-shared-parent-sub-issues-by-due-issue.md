# Route shared-parent sub-issues by the Due Issue; pause on handoff

A run is always entered by the parent (`kb run --issue <parent-id>`, or batch discovery of a parent assigned to the Operator), never by a sub-issue id. krutrimbox walks the Implementation Sequence to the **Due Issue** — the first still-open sub-issue — and implements consecutive sub-issues that the Operator owns; when the Due Issue belongs to someone else it **pauses** like a HITL issue (the Operator's part is done, the next owner takes over), except that when the *immediate* Due Issue at the start of a run is not the Operator's it is an **error** (the Operator ran a parent that has nothing for them to do right now). Teammates share one Target Issue Branch per parent and coordinate purely through the Done Set: each machine sees the others' completed sub-issues from the branch's `Refs #<n>` footers, and strict Due-Issue ordering serialises who can act.

## Considered Options

- **Parent-only ownership** (sub-issue assignees are informational; owning the parent runs the whole sequence) — rejected: large teams legitimately split one epic across people, so a sub-issue's assignee must gate who implements it.
- **Skip a teammate's sub-issue and continue to your later one** — rejected: it breaks the serial, blocker-respecting order of a shared branch; krutrimbox stops at the Due Issue instead of jumping ahead.
- **Discover sub-issues directly via `assignee:@me`** and run them without their parent — rejected: branch, pull request, sandbox, and Done Set all key on the parent, so the parent is the only sane entry point.

## Consequences

- Two operators never write the same sub-issue, because only one can be its sole assignee and only the Due Issue is actionable.
- A sub-issue assigned to a third party that is not the Due Issue's owner blocks progress until its owner completes it — this is intended (it mirrors how a human team serialises dependent work).
- Combined with ADR-0017 and ADR-0018, this is the routing model for solo, small-team, and large-team use; see [Issue Ownership & Routing](../vitepress/guide/concepts/issue-ownership-and-routing.md).
