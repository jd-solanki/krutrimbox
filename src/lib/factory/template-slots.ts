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
  afkErrorComment: "templates/afk-error-comment.md"
} as const;

export type TemplateSlot = keyof typeof TEMPLATE_SLOTS;

// The Template Slot names a project may override, surfaced for validation error
// messages and as the authority on what `.krutrimbox/config.json` accepts.
export const SUPPORTED_TEMPLATE_SLOTS = Object.keys(TEMPLATE_SLOTS) as TemplateSlot[];

export function isTemplateSlot(value: string): value is TemplateSlot {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_SLOTS, value);
}

// Built-in Sandboxed Agent prompt name -> Markdown asset path. Prompts are never
// overridable, but each one accepts an append-only Prompt Extension keyed by
// these same names through `.krutrimbox/config.json` (ADR-0013). Final review is
// no longer a built-in prompt: review is an operator-authored Review Pipeline
// whose Agent Steps supply their own prompts (ADR-0021).
export const PROMPT_ASSETS = {
  afkIssue: "prompts/afk-issue.md"
} as const;

export type PromptName = keyof typeof PROMPT_ASSETS;

// The prompt names a project may extend, surfaced for validation error messages
// and as the authority on what `.krutrimbox/config.json` "prompts" accepts.
export const SUPPORTED_PROMPT_NAMES = Object.keys(PROMPT_ASSETS) as PromptName[];

export function isPromptName(value: string): value is PromptName {
  return Object.prototype.hasOwnProperty.call(PROMPT_ASSETS, value);
}
