import * as v from "valibot";
import { KRUTRIMBOX_HOOK_NAMES } from "../hooks/names";
import { SUPPORTED_PROMPT_NAMES, SUPPORTED_TEMPLATE_SLOTS } from "../templates/template-slots";
import { ALLOWED_GH_COMMANDS, isAllowedGhCommand } from "./gh-allowlist";

// The complete shape of `.krutrimbox/config.json` (ADR-0013), and the single
// source of truth for what the file accepts. `strictObject` rejects unknown
// top-level keys; each section is a record whose keys are constrained to the known
// Template Slots / Prompt names and whose values are file paths under
// `.krutrimbox/`. Sections and their entries are all optional — an omitted slot or
// prompt simply falls back to the built-in default at render time.
//
// This schema validates structure and the Command Action `gh` allowlist (the
// allowlist is a shape rule about the `run` array, so it belongs here). The
// referenced files are still resolved and read by the loader, because their
// safety check — staying repository-owned across symlinks — is filesystem logic.

// One Hook Action (ADR-0021), discriminated by `type`:
//   - agent:   runs an AI session whose `prompt` is a Markdown file under
//              `.krutrimbox/`; its text result is exposed as `{{steps.<id>.output}}`.
//   - comment: posts `body` as a pull request comment.
//   - command: runs the `gh` invocation in `run` on the host (allowlisted).
const AgentActionSchema = v.strictObject({
  type: v.literal("agent"),
  id: v.optional(v.string()),
  prompt: v.string()
});

const CommentActionSchema = v.strictObject({
  type: v.literal("comment"),
  body: v.string()
});

const CommandActionSchema = v.strictObject({
  type: v.literal("command"),
  // `run[0]` must be `gh` and `run[1] run[2]` an allowlisted verb pair. The first
  // three elements are always literal (interpolation only appears later), so the
  // allowlist is a sound shape check at parse time (ADR-0021).
  run: v.pipe(
    v.array(v.string()),
    v.minLength(1),
    v.check(
      isAllowedGhCommand,
      (issue) =>
        `"${(issue.input as string[]).join(" ")}" is not an allowed gh command `
        + `(run[0] must be "gh"; allowed: ${ALLOWED_GH_COMMANDS.join(", ")})`
    )
  )
});

export const HookActionSchema = v.variant("type", [
  AgentActionSchema,
  CommentActionSchema,
  CommandActionSchema
]);

export type HookAction = v.InferOutput<typeof HookActionSchema>;

export const ConfigSchema = v.strictObject({
  templates: v.optional(v.record(v.picklist(SUPPORTED_TEMPLATE_SLOTS), v.string())),
  prompts: v.optional(v.record(v.picklist(SUPPORTED_PROMPT_NAMES), v.string())),
  // Lifecycle hooks: each known hook name maps to the ordered Hook Actions
  // krutrimbox runs when that hook fires (ADR-0021).
  hooks: v.optional(v.record(v.picklist(KRUTRIMBOX_HOOK_NAMES), v.array(HookActionSchema)))
});

export type ProjectConfig = v.InferOutput<typeof ConfigSchema>;
