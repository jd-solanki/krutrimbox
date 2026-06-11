<!-- code-factory:hitl-prd-{{prd_number}}-issue-{{issue_number}} -->

@{{prd_author}} Code Factory is paused for PRD #{{prd_number}}.

The next required issue is HITL:

- #{{issue_number}} - {{issue_title}}

Please resolve the HITL issue and close it, then rerun Code Factory for this PRD.

```sh
code-factory run --prd {{prd_number}}
```
