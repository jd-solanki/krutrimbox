// The catalog of built-in Markdown assets that ship with the CLI package.
//
// Template Slots are the friendly, repository-facing names a project may
// override through `.krutrimbox/config.json`. Each slot maps to its built-in
// Markdown filename, deliberately aligned so a project's override file mirrors
// the default it replaces. Prompts are intentionally NOT exposed as slots: they
// stay built in so krutrimbox keeps ownership of Sandboxed Agent safety
// boundaries (ADR-0013).

// Friendly Template Slot name -> built-in Markdown asset path (relative to the
// shipped assets directory). The keys are the only template names a project may
// configure; the values double as the default content source.
export const TEMPLATE_SLOTS = {
  pullRequestBody: "templates/pull-request-body.md",
  hitlPauseComment: "templates/hitl-pause-comment.md",
  afkErrorComment: "templates/afk-error-comment.md",
  finalReviewComment: "templates/final-review-comment.md"
} as const;

export type TemplateSlot = keyof typeof TEMPLATE_SLOTS;

// The Template Slot names a project may override, surfaced for validation error
// messages and as the authority on what `.krutrimbox/config.json` accepts.
export const SUPPORTED_TEMPLATE_SLOTS = Object.keys(TEMPLATE_SLOTS) as TemplateSlot[];

export function isTemplateSlot(value: string): value is TemplateSlot {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_SLOTS, value);
}

// Built-in Sandboxed Agent prompt name -> Markdown asset path. Prompts are not
// configurable, so this catalog is internal: callers reference prompts by these
// names and always get the built-in content.
export const PROMPT_ASSETS = {
  afkIssue: "prompts/afk-issue.md",
  finalReview: "prompts/final-review.md"
} as const;

export type PromptName = keyof typeof PROMPT_ASSETS;
