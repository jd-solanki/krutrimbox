<!-- code-factory:afk-error-issue-{{issue_number}} -->

Code Factory could not complete this AFK issue.

Reason:

```text
{{error_summary}}
```

Factory context:

- PRD: #{{prd_number}}
- Branch: `{{prd_branch}}`
- Sandbox: `{{prd_sandbox}}`

The issue remains open. Inspect the sandbox if needed, then rerun:

```sh
code-factory run --prd {{prd_number}}
```

Cleanup, if you decide the sandbox is no longer needed:

```sh
sbx rm {{prd_sandbox}}
```
