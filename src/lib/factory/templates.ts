// krutrimbox comment/body templates, inlined as string constants so the
// published bundle carries them instead of reading files relative to the
// orchestrated repo's cwd. `{{key}}` placeholders are filled by the
// BundledTemplateRenderer. Keyed by their bundled file paths.

export const TEMPLATES: Record<string, string> = {
  "templates/pr-body.md": `> [!NOTE]  
>  Generated and maintained by krutrimbox.

## Target Issue Closure

{{closing_keywords}}

## Implementation Issues

{{implementation_issue_checklist}}

## Krutrimbox

Branch: \`{{target_issue_branch}}\`
Sandbox: \`{{target_issue_sandbox}}\`
`,
  "templates/hitlpause-comment.md": `<!-- krutrimbox:hitl-issue-{{target_issue_number}}-implementation-{{issue_number}} -->

@{{target_issue_author}} krutrimbox is paused for Target Issue #{{target_issue_number}}.

The next required issue is HITL:

- #{{issue_number}} - {{issue_title}}

> [!IMPORTANT]
> When the HITL work is finished, push a \`Refs #{{issue_number}}\` commit to the Target Issue Branch \`{{target_issue_branch}}\`.
> An empty commit is acceptable for non-code work. Then rerun krutrimbox:

\`\`\`sh
kb run --issue {{target_issue_number}} --agent {{agent_name}}
\`\`\`

Sandbox: \`{{target_issue_sandbox}}\`
`,
  "templates/afk-error-comment.md": `<!-- krutrimbox:afk-error-issue-{{issue_number}} -->

krutrimbox could not complete this AFK issue.

Reason:

\`\`\`text
{{error_summary}}
\`\`\`

Factory context:

- Target Issue: #{{target_issue_number}}
- Branch: \`{{target_issue_branch}}\`
- Sandbox: \`{{target_issue_sandbox}}\`

The issue remains open. Inspect the sandbox if needed, then rerun:

\`\`\`sh
kb run --issue {{target_issue_number}} --agent {{agent_name}}
\`\`\`

Cleanup, if you decide the sandbox is no longer needed:

\`\`\`sh
sbx rm {{target_issue_sandbox}}
\`\`\`
`,
  "templates/final-review-comment.md": `<!-- krutrimbox:final-review-issue-{{target_issue_number}} -->

{{review_body}}
`,
};
