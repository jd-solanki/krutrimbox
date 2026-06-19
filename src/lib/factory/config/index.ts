import { existsSync, readFileSync } from "node:fs";
import { join } from "pathe";
import { safeDestr } from "destr";
import * as v from "valibot";
import { ConfigSchema, type ProjectConfig } from "./schema";
import { resolveRepoOwnedFile } from "./path-safety";
import { type PromptName, type TemplateSlot } from "../template-slots";

// Committed, repository-owned Project Configuration (ADR-0013). A repository may
// commit `.krutrimbox/config.json` to partially override Template Slots and to
// attach append-only Prompt Extensions, both pointing at Markdown files under
// `.krutrimbox/`. Configuration is validated eagerly and fails fast: an invalid
// config should stop the run immediately rather than silently fall back to
// built-in defaults. The accepted shape lives in ./schema; this file resolves the
// validated config's referenced files from disk.

export const PROJECT_CONFIG_DIRNAME = ".krutrimbox";
export const PROJECT_CONFIG_FILENAME = "config.json";

// The repository-relative label used in fail-fast error messages.
const CONFIG_FILE = `${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME}`;

export interface ResolvedProjectConfig {
  // Template Slot -> override Markdown contents, already read from disk during
  // validation. Only overridden slots appear; omitted slots fall back to the
  // built-in default at render time.
  templateOverrides: Map<TemplateSlot, string>;
  // Prompt name -> Prompt Extension Markdown contents, already read from disk
  // during validation. Only extended prompts appear; omitted prompts render with
  // an empty `repository_instructions` block.
  promptExtensions: Map<PromptName, string>;
}

const EMPTY_CONFIG: ResolvedProjectConfig = {
  templateOverrides: new Map(),
  promptExtensions: new Map()
};

// Loads and validates `.krutrimbox/config.json` for the given project directory.
// A missing file is not an error (the repository simply uses built-in defaults);
// any present-but-invalid configuration throws with a clear, actionable message.
export function loadProjectConfig(projectDir: string): ResolvedProjectConfig {
  return new ProjectConfigLoader(projectDir).load();
}

// Holds the resolved config locations so each step reads as a short pipeline
// instead of threading `configDir`/`configPath` through every call.
class ProjectConfigLoader {
  private readonly configDir: string;
  private readonly configPath: string;

  constructor(projectDir: string) {
    this.configDir = join(projectDir, PROJECT_CONFIG_DIRNAME);
    this.configPath = join(this.configDir, PROJECT_CONFIG_FILENAME);
  }

  load(): ResolvedProjectConfig {
    if (!existsSync(this.configPath)) {
      return EMPTY_CONFIG;
    }

    const config = this.parse();

    return {
      templateOverrides: this.readSection(config.templates, "template slot"),
      promptExtensions: this.readSection(config.prompts, "prompt extension")
    };
  }

  // Parses and structurally validates the file. safeDestr throws on malformed JSON
  // and strips prototype-pollution keys (e.g. `__proto__`); ConfigSchema then
  // enforces the accepted shape and rejects unknown keys / non-string values.
  private parse(): ProjectConfig {
    const raw = readFileSync(this.configPath, "utf8");

    let json: unknown;
    try {
      json = safeDestr(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`krutrimbox: ${CONFIG_FILE} is not valid JSON: ${detail}`);
    }

    try {
      return v.parse(ConfigSchema, json);
    } catch (error) {
      throw new Error(`krutrimbox: invalid ${CONFIG_FILE}${formatConfigIssue(error)}`);
    }
  }

  // Reads every file referenced by a validated section, keyed by its known key.
  private readSection<TKey extends string>(
    section: Partial<Record<TKey, string>> | undefined,
    entityNoun: string
  ): Map<TKey, string> {
    const files = new Map<TKey, string>();

    if (section === undefined) {
      return files;
    }

    for (const [key, configuredPath] of Object.entries(section) as [TKey, string][]) {
      files.set(key, this.readReferencedFile(entityNoun, key, configuredPath));
    }

    return files;
  }

  // Reads a config-referenced Markdown file, refusing any path that escapes
  // `.krutrimbox/`. The safety boundary lives in resolveRepoOwnedFile; here we
  // only translate its outcome into the user-facing, fail-fast error messages.
  private readReferencedFile(entityNoun: string, key: string, configuredPath: string): string {
    const resolution = resolveRepoOwnedFile(configuredPath, this.configDir);

    if (!resolution.ok) {
      if (resolution.reason === "escapes") {
        throw new Error(
          `krutrimbox: ${entityNoun} "${key}" path "${configuredPath}" escapes ${PROJECT_CONFIG_DIRNAME}/.`
        );
      }
      throw new Error(
        `krutrimbox: ${entityNoun} "${key}" file not found: ${PROJECT_CONFIG_DIRNAME}/${configuredPath}.`
      );
    }

    return readFileSync(resolution.realPath, "utf8");
  }
}

// Surfaces valibot's first issue with the failing dot-path, e.g.
// ` at "templates.bogusSlot": Invalid key: ...`. Generic (not per-rule), so the
// schema stays the single source of truth for what the messages describe.
function formatConfigIssue(error: unknown): string {
  if (!(error instanceof v.ValiError)) {
    throw error;
  }

  const issue = error.issues[0];
  const path = v.getDotPath(issue);
  return `${path ? ` at "${path}"` : ""}: ${issue.message}.`;
}
