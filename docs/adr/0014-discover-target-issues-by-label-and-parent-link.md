# Discover Target Issues by label and parent-link; model standalone as a sequence-of-one

krutrimbox discovers a Target Issue as any open issue assigned to the Operator, labeled `ready-for-agent`, that has no parent issue; a sub-issue carrying the same `ready-for-agent` label is reached only by walking down from its Parent Target Issue, never discovered on its own. A Target Issue with no attached sub-issues is Standalone and is modeled as its own single Implementation Issue — its body is the unit of work — so one sequence walk (blocker checks, sandbox, commit, Target Issue Pull Request, final review) serves both Standalone and Parent Target Issues.

## Considered Options

- **A separate standalone code path** that runs the agent on the Target Issue body and drafts the PR directly — rejected because it would duplicate the sandbox, commit, pull-request, and final-review logic and split one mental model into two.

## Consequences

- The `ready-for-agent` label is intentionally overloaded (discovery signal on a Target Issue, readiness signal on an AFK Issue); the *no-parent* requirement is what keeps the two from colliding, so discovery must query the native parent link, not just the label.
