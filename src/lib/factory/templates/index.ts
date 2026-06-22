// Prompt and template rendering (ADR-0013): the catalog of built-in Markdown
// assets (`template-slots`), the loader for the shipped defaults (`asset-store`),
// and the renderer that interpolates them and applies committed Project
// Configuration overrides (`template-renderer`).
export * from "./template-slots";
export * from "./asset-store";
export * from "./template-renderer";
