@{{target_issue_author}} krutrimbox is paused for Target Issue #{{target_issue_number}}.

The next required issue is HITL:

- #{{issue_number}} - {{issue_title}}

> [!IMPORTANT]
> When the HITL work is finished, push a `Refs #{{issue_number}}` commit to the Target Issue Branch `{{target_issue_branch}}`.
> An empty commit is acceptable for non-code work. Then rerun krutrimbox:

```sh
kb run --issue {{target_issue_number}} --agent {{agent_name}}
```

Sandbox: `{{target_issue_sandbox}}`
