// krutrimbox comment/body templates, inlined as string constants so the
// published bundle carries them instead of reading files relative to the
// orchestrated repo's cwd. `{{key}}` placeholders are filled by the
// BundledTemplateRenderer. Keyed by their historical file paths.

export const TEMPLATES: Record<string, string> = {
  "templates/pr-body.md": `> [!NOTE]  
>  Generated and maintained by krutrimbox.

## Parent PRD

Closes #{{prd_number}}

## Implementation Issues

{{implementation_issue_checklist}}

## Krutrimbox

Branch: \`{{prd_branch}}\`
Sandbox: \`{{prd_sandbox}}\`
`,
  "templates/hitlpause-comment.md": `<!-- krutrimbox:hitl-prd-{{prd_number}}-issue-{{issue_number}} -->

@{{prd_author}} krutrimbox is paused for PRD #{{prd_number}}.

The next required issue is HITL:

- #{{issue_number}} - {{issue_title}}

Please resolve the HITL issue and close it, then rerun krutrimbox for this PRD.

\`\`\`sh
kb run --issue {{prd_number}}
\`\`\`
`,
  "templates/afk-error-comment.md": `<!-- krutrimbox:afk-error-issue-{{issue_number}} -->

krutrimbox could not complete this AFK issue.

Reason:

\`\`\`text
{{error_summary}}
\`\`\`

Factory context:

- PRD: #{{prd_number}}
- Branch: \`{{prd_branch}}\`
- Sandbox: \`{{prd_sandbox}}\`

The issue remains open. Inspect the sandbox if needed, then rerun:

\`\`\`sh
kb run --issue {{prd_number}}
\`\`\`

Cleanup, if you decide the sandbox is no longer needed:

\`\`\`sh
sbx rm {{prd_sandbox}}
\`\`\`
`,
  "templates/final-review-comment.md": `<!-- krutrimbox:final-review-prd-{{prd_number}} -->

{{review_body}}
`,
};
