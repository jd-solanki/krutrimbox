import * as v from "valibot";
import { SUPPORTED_PROMPT_NAMES, SUPPORTED_TEMPLATE_SLOTS } from "../template-slots";

// The complete shape of `.krutrimbox/config.json` (ADR-0013), and the single
// source of truth for what the file accepts. `strictObject` rejects unknown
// top-level keys; each section is a record whose keys are constrained to the known
// Template Slots / Prompt names and whose values are file paths under
// `.krutrimbox/`. Sections and their entries are all optional — an omitted slot or
// prompt simply falls back to the built-in default at render time.
//
// This schema validates structure only. The referenced files are resolved and
// read separately (see ./path-safety and the loader) because their safety check —
// staying repository-owned across symlinks — is filesystem logic, not shape.
export const ConfigSchema = v.strictObject({
  templates: v.optional(v.record(v.picklist(SUPPORTED_TEMPLATE_SLOTS), v.string())),
  prompts: v.optional(v.record(v.picklist(SUPPORTED_PROMPT_NAMES), v.string()))
});

export type ProjectConfig = v.InferOutput<typeof ConfigSchema>;
