import { PROMPTS } from "./prompts";
import { TEMPLATES } from "./templates";

// All bundled templates and prompts, keyed by their historical file paths so
// callers keep using `render("templates/pr-body.md", ...)` unchanged.
const BUNDLED: Record<string, string> = { ...TEMPLATES, ...PROMPTS };

// Renders bundled templates by substituting `{{key}}` placeholders. The content
// is compiled into the package, so rendering never touches the filesystem and
// works no matter what directory the CLI is invoked from.
export class BundledTemplateRenderer {
  public async render(
    templatePath: string,
    values: Record<string, string | number>
  ): Promise<string> {
    const template = BUNDLED[templatePath];

    if (template === undefined) {
      throw new Error(`Unknown template: ${templatePath}`);
    }

    return template.replace(/{{(\w+)}}/g, (_match, key: string) => {
      const value = values[key];
      return typeof value === "undefined" ? "" : String(value);
    });
  }
}

// Injection seam: the public surface of BundledTemplateRenderer, so fakes need no separate contract.
export type TemplateRenderer = Pick<BundledTemplateRenderer, "render">;
