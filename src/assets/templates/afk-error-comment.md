krutrimbox could not complete this AFK issue.

Reason:

```text
{{error_summary}}
```

Factory context:

- Target Issue: #{{target_issue_number}}
- Branch: `{{target_issue_branch}}`
- Sandbox: `{{target_issue_sandbox}}`

The issue remains open. Inspect the sandbox if needed, then rerun:

```sh
kb run --issue {{target_issue_number}} --agent {{agent_name}}
```

Cleanup, if you decide the sandbox is no longer needed:

```sh
sbx rm {{target_issue_sandbox}}
```
