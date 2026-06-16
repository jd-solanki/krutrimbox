import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isTemplateSlot, SUPPORTED_TEMPLATE_SLOTS, type TemplateSlot } from "./template-slots";

// Committed, repository-owned Project Configuration (ADR-0013). A repository may
// commit `.krutrimbox/config.json` to partially override Template Slots with
// Markdown files under `.krutrimbox/`. Configuration is validated eagerly and
// fails fast: an invalid config should stop the run immediately rather than
// silently fall back to built-in defaults.

export const PROJECT_CONFIG_DIRNAME = ".krutrimbox";
export const PROJECT_CONFIG_FILENAME = "config.json";

// The only top-level keys `.krutrimbox/config.json` accepts. Prompts are
// deliberately absent: they are not configurable.
const SUPPORTED_TOP_LEVEL_KEYS = ["templates"];

export interface ResolvedProjectConfig {
  // Template Slot -> override Markdown contents, already read from disk during
  // validation. Only overridden slots appear; omitted slots fall back to the
  // built-in default at render time.
  templateOverrides: Map<TemplateSlot, string>;
}

const EMPTY_CONFIG: ResolvedProjectConfig = { templateOverrides: new Map() };

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

  return { templateOverrides: resolveTemplateOverrides(parsed.templates, configDir) };
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
  const overrides = new Map<TemplateSlot, string>();

  if (templates === undefined) {
    return overrides;
  }

  assertPlainObject(templates, `${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME} "templates"`);

  for (const [slot, value] of Object.entries(templates)) {
    if (!isTemplateSlot(slot)) {
      throw new Error(
        `krutrimbox: unknown template slot "${slot}" in ${PROJECT_CONFIG_DIRNAME}/${PROJECT_CONFIG_FILENAME}; supported slots: ${SUPPORTED_TEMPLATE_SLOTS.join(", ")}.`
      );
    }

    if (typeof value !== "string") {
      throw new Error(
        `krutrimbox: template slot "${slot}" must be a string path relative to ${PROJECT_CONFIG_DIRNAME}/.`
      );
    }

    overrides.set(slot, readOverrideFile(slot, value, configDir));
  }

  return overrides;
}

// Resolves a configured override path against `.krutrimbox/`, refuses paths that
// escape the directory, and reads the file so a missing override fails fast.
function readOverrideFile(slot: TemplateSlot, configuredPath: string, configDir: string): string {
  const resolved = resolve(configDir, configuredPath);
  assertPathStaysInConfigDir(slot, configuredPath, configDir, resolved);

  if (!existsSync(resolved)) {
    throw new Error(
      `krutrimbox: template slot "${slot}" override file not found: ${PROJECT_CONFIG_DIRNAME}/${configuredPath}.`
    );
  }

  const realConfigDir = realpathSync(configDir);
  const realResolved = realpathSync(resolved);

  assertPathStaysInConfigDir(slot, configuredPath, realConfigDir, realResolved);

  if (!statSync(realResolved).isFile()) {
    throw new Error(
      `krutrimbox: template slot "${slot}" override file not found: ${PROJECT_CONFIG_DIRNAME}/${configuredPath}.`
    );
  }

  return readFileSync(realResolved, "utf8");
}

function assertPathStaysInConfigDir(
  slot: TemplateSlot,
  configuredPath: string,
  configDir: string,
  candidatePath: string
): void {
  if (pathEscapesDirectory(relative(configDir, candidatePath))) {
    throw new Error(
      `krutrimbox: template slot "${slot}" path "${configuredPath}" escapes ${PROJECT_CONFIG_DIRNAME}/.`
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
