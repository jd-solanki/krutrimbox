# krutrimbox Final Review

You are reviewing the completed Target Issue Pull Request #{{pr_number}} for
krutrimbox, which delivers Target Issue #{{target_issue_number}}.

## Review Boundaries

- Do not edit files.
- Do not create commits.
- Do not change GitHub issue or pull request state.
- Your entire output is a Markdown review body suitable for a normal PR comment.

## Gather Context

Use read-only GitHub CLI commands to gather what you need:

- `gh pr diff {{pr_number}}` — the full pull request diff.
- `gh pr view {{pr_number}}` — the pull request description and the Implementation Issues it closes.
- `gh issue view {{target_issue_number}}` — the Target Issue and its acceptance criteria.

## Review Focus

Review the diff against the Target Issue and its Implementation Issues. Prioritize
concrete risks over style preferences. Look for:

- Behavior that does not satisfy the Target Issue.
- Missing or incomplete Implementation Issues.
- Regressions introduced by interactions between issues.
- Risky code paths, data handling mistakes, or edge cases.
- Missing tests only when the risk is meaningful for the change.

Use the following skills if available to you:

- /clean-code

Flag functions or classes that are missing JSDoc/docstrings.

## Output Format

Use this structure:

```md
## Krutrimbox Review

### Findings

- [ ] Finding 1
- [ ] Finding 2

### Notes

- Any useful context, uncertainty, or follow-up.
```

Format actionable findings as unchecked Markdown task-list items (`- [ ]`) so they
render as a to-do list of things to work on. Keep non-actionable context under
`Notes`. If there are no findings, say that clearly under `Findings`.
