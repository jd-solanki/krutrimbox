import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadProjectConfig,
  PROMPT_ASSETS,
  ProjectTemplateRenderer,
  SUPPORTED_TEMPLATE_SLOTS,
  TEMPLATE_SLOTS
} from "../src/lib/factory/index";
import { interpolate } from "../src/utils/interpolate";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Builds a throwaway project directory and returns helpers to populate its
// committed `.krutrimbox/` Project Configuration before constructing a renderer.
async function projectDir() {
  const dir = await mkdtemp(join(tmpdir(), "krutrimbox-config-"));
  const configDir = join(dir, ".krutrimbox");
  await mkdir(configDir, { recursive: true });

  return {
    dir,
    async writeConfig(contents: string) {
      await writeFile(join(configDir, "config.json"), contents, "utf8");
    },
    async writeFileUnder(relativePath: string, contents: string) {
      const target = join(configDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    },
    async writeSymlinkUnder(relativePath: string, target: string) {
      const linkPath = join(configDir, relativePath);
      await mkdir(dirname(linkPath), { recursive: true });
      await symlink(target, linkPath);
    },
    cleanup() {
      return rm(dir, { recursive: true, force: true });
    }
  };
}

describe("ProjectTemplateRenderer built-in defaults", () => {
  const renderer = new ProjectTemplateRenderer();

  test("loads built-in Markdown templates when no Project Configuration exists", async () => {
    const body = await renderer.renderTemplate("pullRequestBody", {
      target_issue_branch: "krutrimbox/issue-1",
      closing_keywords: "Closes #1",
      implementation_issue_checklist: "- [x] #1",
      target_issue_sandbox: "krutrimbox-issue-1-codex"
    });

    expect(body).toContain("## Target Issue Closure");
    expect(body).toContain("Branch: `krutrimbox/issue-1`");
    expect(body).not.toContain("{{");
  });

  test("loads built-in Markdown prompts, which are never overridable", async () => {
    const prompt = await renderer.renderPrompt("afkIssue", {
      target_issue_branch: "krutrimbox/issue-1"
    });

    expect(prompt).toContain("You are a Sandboxed Agent");
    expect(prompt).toContain("Do not create commits or push branches.");
    expect(prompt).toContain("Work on the Target Issue Branch: `krutrimbox/issue-1`.");
  });

  test("interpolates dotted placeholder keys such as Step Outputs", () => {
    expect(interpolate("Review:\n\n{{steps.review.output}}", { "steps.review.output": "LGTM" }))
      .toBe("Review:\n\nLGTM");
  });

  test("preserves placeholder substitution semantics: a missing value renders empty", () => {
    expect(interpolate("before {{missing}} after", {})).toBe("before  after");
  });

  test("built-in comment templates carry no Factory Comment Marker", async () => {
    const error = await renderer.renderTemplate("afkErrorComment", {});
    const pause = await renderer.renderTemplate("hitlPauseComment", {});

    expect(error).not.toContain("<!-- krutrimbox:");
    expect(pause).not.toContain("<!-- krutrimbox:");
  });
});

describe("ProjectTemplateRenderer partial overrides", () => {
  let project: Awaited<ReturnType<typeof projectDir>>;

  beforeEach(async () => {
    project = await projectDir();
  });

  afterEach(() => project.cleanup());

  test("uses the configured override for one slot and built-in defaults for omitted slots", async () => {
    await project.writeFileUnder("templates/custom-pr.md", "CUSTOM PR for `{{target_issue_branch}}`");
    await project.writeConfig(
      JSON.stringify({ templates: { pullRequestBody: "templates/custom-pr.md" } })
    );

    const renderer = ProjectTemplateRenderer.fromProjectDir(project.dir);

    expect(await renderer.renderTemplate("pullRequestBody", { target_issue_branch: "krutrimbox/issue-9" }))
      .toBe("CUSTOM PR for `krutrimbox/issue-9`");
    // An omitted slot still resolves to the built-in Markdown default.
    expect(await renderer.renderTemplate("hitlPauseComment", { target_issue_number: 9 }))
      .toContain("krutrimbox is paused for Target Issue #9.");
  });
});

describe("Prompt Extensions", () => {
  let project: Awaited<ReturnType<typeof projectDir>>;

  beforeEach(async () => {
    project = await projectDir();
  });

  afterEach(() => project.cleanup());

  test("renders an empty repository_instructions block when no extension is configured", async () => {
    const prompt = await new ProjectTemplateRenderer().renderPrompt("afkIssue", {});

    expect(prompt).toContain("<repository_instructions>\n\n</repository_instructions>");
    expect(prompt).not.toContain("{{repository_instructions}}");
  });

  test("injects the configured extension inside the repository_instructions tag", async () => {
    await project.writeFileUnder("prompts/afk.md", "Always add JSDoc/docstrings.");
    await project.writeConfig(JSON.stringify({ prompts: { afkIssue: "prompts/afk.md" } }));

    const prompt = await ProjectTemplateRenderer.fromProjectDir(project.dir).renderPrompt("afkIssue", {});

    expect(prompt).toContain("<repository_instructions>\nAlways add JSDoc/docstrings.\n</repository_instructions>");
  });

  test("drops extension content verbatim without re-scanning it for placeholders", async () => {
    await project.writeFileUnder("prompts/afk.md", "Keep {{target_issue_body}} literal.");
    await project.writeConfig(JSON.stringify({ prompts: { afkIssue: "prompts/afk.md" } }));

    const prompt = await ProjectTemplateRenderer.fromProjectDir(project.dir).renderPrompt("afkIssue", {
      target_issue_body: "INJECTED"
    });

    expect(prompt).toContain("Keep {{target_issue_body}} literal.");
    expect(prompt).not.toContain("Keep INJECTED literal.");
  });
});

describe("Project Configuration fails fast", () => {
  let project: Awaited<ReturnType<typeof projectDir>>;

  beforeEach(async () => {
    project = await projectDir();
  });

  afterEach(() => project.cleanup());

  function expectInvalid(message: RegExp) {
    expect(() => ProjectTemplateRenderer.fromProjectDir(project.dir)).toThrow(message);
  }

  test("rejects malformed JSON", async () => {
    await project.writeConfig("{ not valid json");
    expectInvalid(/not valid JSON/);
  });

  test("rejects unsupported top-level keys", async () => {
    await project.writeConfig(JSON.stringify({ bogus: { afkIssue: "x.md" } }));
    expectInvalid(/invalid .+config\.json at "bogus": Invalid key/);
  });

  test("rejects unknown prompt names", async () => {
    await project.writeConfig(JSON.stringify({ prompts: { bogusPrompt: "x.md" } }));
    expectInvalid(/at "prompts\.bogusPrompt": Invalid type/);
  });

  test("rejects a missing prompt extension file", async () => {
    await project.writeConfig(JSON.stringify({ prompts: { afkIssue: "prompts/missing.md" } }));
    expectInvalid(/prompt extension "afkIssue" file not found/);
  });

  test("rejects prompt extension paths that escape .krutrimbox/", async () => {
    await project.writeConfig(JSON.stringify({ prompts: { afkIssue: "/etc/passwd" } }));
    expectInvalid(/escapes \.krutrimbox\//);
  });

  test("rejects unknown Template Slots", async () => {
    await project.writeConfig(JSON.stringify({ templates: { bogusSlot: "x.md" } }));
    expectInvalid(/at "templates\.bogusSlot": Invalid type/);
  });

  test("rejects non-string template slot values", async () => {
    await project.writeConfig(JSON.stringify({ templates: { pullRequestBody: 42 } }));
    expectInvalid(/at "templates\.pullRequestBody": Invalid type: Expected string but received 42/);
  });

  test("rejects a missing override file", async () => {
    await project.writeConfig(JSON.stringify({ templates: { pullRequestBody: "templates/missing.md" } }));
    expectInvalid(/template slot "pullRequestBody" file not found/);
  });

  test("rejects override paths that escape .krutrimbox/ with ..", async () => {
    await project.writeFileUnder("../escape.md", "escaped");
    await project.writeConfig(JSON.stringify({ templates: { pullRequestBody: "../escape.md" } }));
    expectInvalid(/escapes \.krutrimbox\//);
  });

  test("rejects absolute override paths", async () => {
    await project.writeConfig(JSON.stringify({ templates: { pullRequestBody: "/etc/passwd" } }));
    expectInvalid(/escapes \.krutrimbox\//);
  });

  test("rejects override symlinks that escape .krutrimbox/", async () => {
    const outsideTemplate = join(project.dir, "escape.md");
    await writeFile(outsideTemplate, "escaped", "utf8");
    await project.writeSymlinkUnder("templates/escape.md", outsideTemplate);
    await project.writeConfig(JSON.stringify({ templates: { pullRequestBody: "templates/escape.md" } }));

    expectInvalid(/escapes \.krutrimbox\//);
  });

  test("rejects an unknown hook name", async () => {
    await project.writeConfig(JSON.stringify({ hooks: { "bogus:hook": [] } }));
    expectInvalid(/at "hooks\.bogus:hook": Invalid/);
  });

  test("rejects an unknown hook action type", async () => {
    await project.writeConfig(JSON.stringify({ hooks: { "pull-request:ready": [{ type: "bogus" }] } }));
    expectInvalid(/hooks\.pull-request:ready\.0/);
  });

  test("rejects a missing agent action prompt file", async () => {
    await project.writeConfig(
      JSON.stringify({
        hooks: { "pull-request:ready": [{ type: "agent", id: "review", prompt: "prompts/missing.md" }] }
      })
    );
    expectInvalid(/hook agent prompt "review" file not found/);
  });

  test("rejects an agent action prompt path that escapes .krutrimbox/", async () => {
    await project.writeConfig(
      JSON.stringify({ hooks: { "pull-request:ready": [{ type: "agent", prompt: "/etc/passwd" }] } })
    );
    expectInvalid(/escapes \.krutrimbox\//);
  });

  test("rejects a Command Action outside the gh verb allowlist", async () => {
    await project.writeConfig(
      JSON.stringify({ hooks: { "pull-request:ready": [{ type: "command", run: ["gh", "pr", "merge", "10"] }] } })
    );
    expectInvalid(/"gh pr merge 10" is not an allowed gh command/);
  });

  test("rejects a Command Action that does not start with gh", async () => {
    await project.writeConfig(
      JSON.stringify({ hooks: { "pull-request:ready": [{ type: "command", run: ["rm", "-rf", "/"] }] } })
    );
    expectInvalid(/is not an allowed gh command/);
  });

  test("resolves a valid hook, reading the agent prompt from disk", async () => {
    await project.writeFileUnder("prompts/review.md", "Review the PR.");
    await project.writeConfig(
      JSON.stringify({
        hooks: {
          "pull-request:ready": [
            { type: "agent", id: "review", prompt: "prompts/review.md" },
            { type: "comment", body: "{{steps.review.output}}" },
            { type: "command", run: ["gh", "pr", "ready", "{{pr_number}}"] }
          ]
        }
      })
    );

    expect(loadProjectConfig(project.dir).hooks.get("pull-request:ready")).toEqual([
      { kind: "agent", id: "review", prompt: "Review the PR." },
      { kind: "comment", body: "{{steps.review.output}}" },
      { kind: "command", run: ["gh", "pr", "ready", "{{pr_number}}"] }
    ]);
  });
});

describe("built-in Markdown assets ship with the package", () => {
  test("every Template Slot and prompt has a source Markdown asset", () => {
    for (const assetPath of [...Object.values(TEMPLATE_SLOTS), ...Object.values(PROMPT_ASSETS)]) {
      expect(existsSync(join(repoRoot, "src/assets", assetPath))).toBe(true);
    }
  });

  test("built-in Markdown filenames align with the friendly Template Slot names", () => {
    expect(TEMPLATE_SLOTS.pullRequestBody).toBe("templates/pull-request-body.md");
    expect(TEMPLATE_SLOTS.hitlPauseComment).toBe("templates/hitl-pause-comment.md");
    expect(SUPPORTED_TEMPLATE_SLOTS).toContain("afkErrorComment");
  });

  test("the build copies the assets into the published dist output", async () => {
    const config = await readFile(join(repoRoot, "tsdown.config.ts"), "utf8");
    expect(config).toMatch(/from:\s*"src\/assets"/);
    expect(config).toMatch(/to:\s*"dist\/assets"/);

    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.files).toContain("dist");
  });
});
