import { loadBuiltInAsset } from "./asset-store";
import { loadProjectConfig, type ResolvedProjectConfig } from "../config";
import { interpolate, type InterpolationValues } from "../../../utils/interpolate";
import { PROMPT_ASSETS, TEMPLATE_SLOTS, type PromptName, type TemplateSlot } from "./template-slots";

// Renders krutrimbox's prompts and templates by substituting `{{key}}`
// placeholders. Built-in content loads from the Markdown assets shipped with the
// package (ADR-0013); templates may be partially overridden by committed Project
// Configuration, while prompts are always built in. Factory Comment Markers are
// injected by the Factory Run outside these templates, so a custom template body
// can never break idempotent comment updates.

type RenderValues = InterpolationValues;

export class ProjectTemplateRenderer {
  private readonly templateOverrides: Map<TemplateSlot, string>;
  private readonly promptExtensions: Map<PromptName, string>;

  public constructor(
    config: ResolvedProjectConfig = {
      templateOverrides: new Map(),
      promptExtensions: new Map(),
      hooks: new Map()
    }
  ) {
    this.templateOverrides = config.templateOverrides;
    this.promptExtensions = config.promptExtensions;
  }

  // Builds a renderer for a project directory, loading and validating its
  // committed `.krutrimbox/config.json`. Invalid configuration throws here, so
  // the run fails fast before any GitHub or sandbox work begins.
  public static fromProjectDir(projectDir: string): ProjectTemplateRenderer {
    return new ProjectTemplateRenderer(loadProjectConfig(projectDir));
  }

  // Renders an overridable Template Slot: the project's configured override when
  // present, otherwise the built-in Markdown default.
  public async renderTemplate(slot: TemplateSlot, values: RenderValues): Promise<string> {
    const source = this.templateOverrides.get(slot) ?? (await loadBuiltInAsset(TEMPLATE_SLOTS[slot]));
    return interpolate(source, values);
  }

  // Renders a built-in Sandboxed Agent prompt. The prompt body is never
  // overridable; the only project-supplied content is the append-only Prompt
  // Extension, injected as the `repository_instructions` value (empty when the
  // project configures no extension for this prompt). Callers never pass that
  // value — the renderer owns it from Project Configuration.
  public async renderPrompt(name: PromptName, values: RenderValues): Promise<string> {
    const repository_instructions = this.promptExtensions.get(name) ?? "";
    return interpolate(await loadBuiltInAsset(PROMPT_ASSETS[name]), { ...values, repository_instructions });
  }
}

// Injection seam: the public surface of ProjectTemplateRenderer, so fakes need no separate contract.
export type TemplateRenderer = Pick<ProjectTemplateRenderer, "renderTemplate" | "renderPrompt">;
