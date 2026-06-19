import { describe, expect, test } from "vitest";
import { resolveCodingAgent, AGENT_NAMES } from "../src/lib/factory/index";

describe("resolveCodingAgent", () => {
  test("backs Codex runs with a non-resumed `codex exec` session and its own template", () => {
    const agent = resolveCodingAgent("codex");

    expect(agent.name).toBe("codex");
    expect(agent.sbxAgentName).toBe("codex");
    expect(agent.defaultTemplate).toBe("docker.io/library/krutrimbox-codex:pnpm");
    expect(agent.buildExecCommand("do the work")).toEqual([
      "codex",
      "exec",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "do the work"
    ]);
  });

  test("backs Claude runs with a fresh `claude -p` one-shot and its own template", () => {
    const agent = resolveCodingAgent("claude");

    expect(agent.name).toBe("claude");
    expect(agent.sbxAgentName).toBe("claude");
    expect(agent.defaultTemplate).toBe("docker.io/library/krutrimbox-claude:pnpm");
    expect(agent.buildExecCommand("do the work")).toEqual([
      "claude",
      "-p",
      "do the work",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions"
    ]);
  });

  test("gives Claude a run-log codec to decode its structured output, but not Codex", () => {
    expect(resolveCodingAgent("claude").runLogCodec).toBeDefined();
    expect(resolveCodingAgent("codex").runLogCodec).toBeUndefined();
  });

  test("never bypasses with a resumed Claude session, which would leak context across AFK Issues", () => {
    const command = resolveCodingAgent("claude").buildExecCommand("prompt");

    expect(command).not.toContain("--continue");
    expect(command).not.toContain("--resume");
  });

  test("rejects an unknown Agent Backend name instead of silently defaulting", () => {
    let thrown: unknown;
    try {
      resolveCodingAgent("gemini" as never);
    } catch (error) {
      thrown = error;
    }

    // The diagnosis is the message; the selectable names are the remedy, so they
    // live on the diagnostic's fix rather than being echoed in the message.
    expect(thrown).toMatchObject({
      name: "KB_R0001",
      message: "Unknown Agent Backend \"gemini\".",
      fix: "Pass --agent with one of: codex, claude."
    });
  });

  test("exposes the selectable Agent Backend names for CLI validation", () => {
    expect(AGENT_NAMES).toEqual(["codex", "claude"]);
  });
});
