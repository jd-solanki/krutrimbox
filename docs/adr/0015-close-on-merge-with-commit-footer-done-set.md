# Close issues on pull-request merge; derive resume progress from commit footers

krutrimbox closes nothing during a Factory Run. The Target Issue Pull Request body carries `Closes #<number>` keywords for the Target Issue and every Implementation Issue, so GitHub auto-closes them all when the pull request merges — the keywords live in the PR body rather than commit messages so they survive squash merges. To resume, each Factory Run rebuilds the Done Set by scanning the Target Issue Branch for `Refs #<number>` commit footers (agent work is footered by the Sandboxed Agent, completed HITL work by a human commit) instead of reading GitHub open/closed state. This keeps GitHub issue state honest — an issue stays open until its work actually lands via merge — at the cost of a branch-derived ledger rather than the issue tracker as the progress source.

## Considered Options

- **Parse the pull-request checklist** as the progress source — rejected as human-editable prose that can drift from the work actually committed.
- **Close each issue mid-run** (the previous approach) so later runs skip closed issues — rejected because it marks issues done while their code lives only in an unmerged draft pull request.

## Consequences

- The earlier "use GitHub state for factory resume" and "close implementation issues during factory runs" decisions are removed, not retained.
- A completed HITL handoff requires a human commit with a `Refs #<number>` footer (an empty commit suffices for non-code work); a forgotten footer simply re-pauses the run harmlessly. The HITL pause comment highlights this with a `> [!IMPORTANT]` callout.
