import { existsSync, readFileSync } from "node:fs";
import { join } from "pathe";
import { safeDestr } from "destr";
import * as v from "valibot";
import { diagnostics } from "../../diagnostics";
import { ConfigSchema, type HookAction, type ProjectConfig } from "./schema";
import { resolveRepoOwnedFile } from "./path-safety";
import { type KrutrimboxHookName } from "../hooks/names";
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

// One Hook Action with its config-referenced files already resolved (ADR-0021).
// Discriminated by `kind` rather than the file's `type` to mark that these are
// loaded values, not raw config: an Agent Action's `prompt` here is the Markdown
// contents read from disk, not the path written in `config.json`.
export type ResolvedHookAction =
  | { kind: "agent"; id?: string; prompt: string }
  | { kind: "comment"; body: string }
  | { kind: "command"; run: string[] };

export interface ResolvedProjectConfig {
  // Template Slot -> override Markdown contents, already read from disk during
  // validation. Only overridden slots appear; omitted slots fall back to the
  // built-in default at render time.
  templateOverrides: Map<TemplateSlot, string>;
  // Prompt name -> Prompt Extension Markdown contents, already read from disk
  // during validation. Only extended prompts appear; omitted prompts render with
  // an empty `repository_instructions` block.
  promptExtensions: Map<PromptName, string>;
  // Hook name -> its ordered Hook Actions, with Agent Action prompts read and
  // Command Actions allowlist-checked during validation. Only configured hooks
  // appear; an unconfigured hook simply has no actions to run.
  hooks: Map<KrutrimboxHookName, ResolvedHookAction[]>;
}

const EMPTY_CONFIG: ResolvedProjectConfig = {
  templateOverrides: new Map(),
  promptExtensions: new Map(),
  hooks: new Map()
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
      promptExtensions: this.readSection(config.prompts, "prompt extension"),
      hooks: this.readHooks(config.hooks)
    };
  }

  // Resolves every configured hook's actions, keyed by hook name. An omitted
  // `hooks` section yields an empty map (no hook has actions to run).
  private readHooks(
    hooks: Partial<Record<KrutrimboxHookName, HookAction[]>> | undefined
  ): Map<KrutrimboxHookName, ResolvedHookAction[]> {
    const resolved = new Map<KrutrimboxHookName, ResolvedHookAction[]>();

    if (hooks === undefined) {
      return resolved;
    }

    for (const [hookName, actions] of Object.entries(hooks) as [KrutrimboxHookName, HookAction[]][]) {
      resolved.set(hookName, actions.map((action, index) => this.resolveHookAction(hookName, action, index)));
    }

    return resolved;
  }

  // Resolves one Hook Action into a loaded value. An Agent Action's prompt file is
  // read from disk here (filesystem logic); a Command Action's `gh` allowlist is
  // already enforced by the schema, so `run` passes through verbatim (ADR-0021).
  private resolveHookAction(
    hookName: KrutrimboxHookName,
    action: HookAction,
    index: number
  ): ResolvedHookAction {
    switch (action.type) {
      case "agent":
        return {
          kind: "agent",
          id: action.id,
          prompt: this.readReferencedFile(
            "hook agent prompt",
            action.id ?? `${hookName}[${index}]`,
            action.prompt
          )
        };
      case "comment":
        return { kind: "comment", body: action.body };
      case "command":
        return { kind: "command", run: action.run };
    }
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
      // A user-file parse error: the JS stack points inside krutrimbox, so carry
      // the original error as `cause` and the offending file as `sources`.
      throw diagnostics.KB_C0001({
        configFile: CONFIG_FILE,
        detail,
        cause: error,
        sources: [CONFIG_FILE]
      });
    }

    try {
      return v.parse(ConfigSchema, json);
    } catch (error) {
      throw diagnostics.KB_C0002({
        configFile: CONFIG_FILE,
        issue: formatConfigIssue(error),
        cause: error,
        sources: [CONFIG_FILE]
      });
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
        throw diagnostics.KB_C0003({
          entityNoun,
          key,
          configuredPath,
          dirname: PROJECT_CONFIG_DIRNAME
        });
      }
      throw diagnostics.KB_C0004({
        entityNoun,
        key,
        dirname: PROJECT_CONFIG_DIRNAME,
        configuredPath
      });
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
