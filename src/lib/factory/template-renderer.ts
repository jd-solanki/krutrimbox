import { readFile } from "node:fs/promises";
import path from "node:path";

// Renders templates from files under `cwd`, substituting `{{key}}` placeholders.
export class FileTemplateRenderer {
  public constructor(private readonly cwd: string) {}

  public async render(
    templatePath: string,
    values: Record<string, string | number>
  ): Promise<string> {
    const template = await readFile(path.join(this.cwd, templatePath), "utf8");

    return template.replace(/{{(\w+)}}/g, (_match, key: string) => {
      const value = values[key];
      return typeof value === "undefined" ? "" : String(value);
    });
  }
}

// Injection seam: the public surface of FileTemplateRenderer, so fakes need no separate contract.
export type TemplateRenderer = Pick<FileTemplateRenderer, "render">;
