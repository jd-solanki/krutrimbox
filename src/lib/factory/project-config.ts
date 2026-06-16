import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isPromptName,
  isTemplateSlot,
  SUPPORTED_PROMPT_NAMES,
  SUPPORTED_TEMPLATE_SLOTS,
  type PromptName,
  type TemplateSlot
} from "./template-slots";

// Committed, repository-owned Project Configuration (ADR-0013). A repository may
// commit `.krutrimbox/config.json` to partially override Template Slots and to
// attach append-only Prompt Extensions, both pointing at Markdown files under
// `.krutrimbox/`. Configuration is validated eagerly and fails fast: an invalid
// config should stop the run immediately rather than silently fall back to
// built-in defaults.

export const PROJECT_CONFIG_DIRNAME = ".krutrimbox";
export const PROJECT_CONFIG_FILENAME = "config.json";

// The only top-level keys `.krutrimbox/config.json` accepts. `prompts` attaches
// append-only Prompt Extensions; it never overrides a prompt's built-in body.
const SUPPORTED_TOP_LEVEL_KEYS = ["templates", "prompts"];

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
  const configDir = join(projectDir, PROJECT_CONFIG_DIRNAME);
  const configPath = join(configDir, PROJECT_CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    return EMPTY_CONFIG;
  }

  const parsed = parseConfigFile(configPath);
  assertPlainObject(parsed, `${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME}`);
  assertKnownTopLevelKeys(parsed);

  return {
    templateOverrides: resolveTemplateOverrides(parsed.templates, configDir),
    promptExtensions: resolvePromptExtensions(parsed.prompts, configDir)
  };
}

function parseConfigFile(configPath: string): Record<string, unknown> {
  const raw = readFileSync(configPath, "utf8");

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `krutrimbox: ${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME} is not valid JSON: ${detail}`
    );
  }
}

function assertKnownTopLevelKeys(config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (!SUPPORTED_TOP_LEVEL_KEYS.includes(key)) {
      throw new Error(
        `krutrimbox: unsupported configuration key "${key}" in ${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME}; supported keys: ${SUPPORTED_TOP_LEVEL_KEYS.join(", ")}.`
      );
    }
  }
}

function resolveTemplateOverrides(
  templates: unknown,
  configDir: string
): Map<TemplateSlot, string> {
  return resolveFileMap<TemplateSlot>(templates, configDir, {
    sectionKey: "templates",
    entityNoun: "template slot",
    isKnownKey: isTemplateSlot,
    supportedKeys: SUPPORTED_TEMPLATE_SLOTS
  });
}

function resolvePromptExtensions(
  prompts: unknown,
  configDir: string
): Map<PromptName, string> {
  return resolveFileMap<PromptName>(prompts, configDir, {
    sectionKey: "prompts",
    entityNoun: "prompt extension",
    isKnownKey: isPromptName,
    supportedKeys: SUPPORTED_PROMPT_NAMES
  });
}

interface FileMapSpec<TKey extends string> {
  // The `.krutrimbox/config.json` section this map is read from.
  sectionKey: string;
  // Human-readable noun used in validation errors, e.g. "template slot".
  entityNoun: string;
  // Narrows an arbitrary config key to a known map key.
  isKnownKey: (value: string) => value is TKey;
  // The set of accepted keys, surfaced in the unknown-key error message.
  supportedKeys: readonly TKey[];
}

// Shared resolver for both Template Slot overrides and Prompt Extensions: each is
// a JSON object mapping a known key to a Markdown file path under `.krutrimbox/`,
// validated identically and read from disk eagerly.
function resolveFileMap<TKey extends string>(
  section: unknown,
  configDir: string,
  spec: FileMapSpec<TKey>
): Map<TKey, string> {
  const files = new Map<TKey, string>();

  if (section === undefined) {
    return files;
  }

  assertPlainObject(
    section,
    `${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME} "${spec.sectionKey}"`
  );

  for (const [key, value] of Object.entries(section)) {
    if (!spec.isKnownKey(key)) {
      throw new Error(
        `krutrimbox: unknown ${spec.entityNoun} "${key}" in ${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME}; supported: ${spec.supportedKeys.join(", ")}.`
      );
    }

    if (typeof value !== "string") {
      throw new Error(
        `krutrimbox: ${spec.entityNoun} "${key}" must be a string path relative to ${PROJECT_CONFIG_DIRNAME}/.`
      );
    }

    files.set(key, readConfigFile(spec.entityNoun, key, value, configDir));
  }

  return files;
}

// Config-referenced Markdown must stay repository-owned even after symlinks are
// resolved. A link inside `.krutrimbox/` may point to another file there, but not
// to a file elsewhere in the checkout or on the host.
function readConfigFile(
  entityNoun: string,
  key: string,
  configuredPath: string,
  configDir: string
): string {
  const resolved = resolve(configDir, configuredPath);
  assertPathStaysInConfigDir(entityNoun, key, configuredPath, configDir, resolved);

  if (!existsSync(resolved)) {
    throw new Error(
      `krutrimbox: ${entityNoun} "${key}" file not found: ${PROJECT_CONFIG_DIRNAME}/${configuredPath}.`
    );
  }

  const realConfigDir = realpathSync(configDir);
  const realResolved = realpathSync(resolved);

  assertPathStaysInConfigDir(entityNoun, key, configuredPath, realConfigDir, realResolved);

  if (!statSync(realResolved).isFile()) {
    throw new Error(
      `krutrimbox: ${entityNoun} "${key}" file not found: ${PROJECT_CONFIG_DIRNAME}/${configuredPath}.`
    );
  }

  return readFileSync(realResolved, "utf8");
}

function assertPathStaysInConfigDir(
  entityNoun: string,
  key: string,
  configuredPath: string,
  configDir: string,
  candidatePath: string
): void {
  if (pathEscapesDirectory(relative(configDir, candidatePath))) {
    throw new Error(
      `krutrimbox: ${entityNoun} "${key}" path "${configuredPath}" escapes ${PROJECT_CONFIG_DIRNAME}/.`
    );
  }
}

function pathEscapesDirectory(relativePath: string): boolean {
  return (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  );
}

function assertPlainObject(
  value: unknown,
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`krutrimbox: ${label} must be a JSON object.`);
  }
}
