import { describe, expect, test } from "vitest";
import { claudeRunLogCodec } from "../src/lib/factory/agents/claude-run-log-codec";

const { renderLine, extractResultText } = claudeRunLogCodec;

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

describe("claudeRunLogCodec.renderLine", () => {
  test("renders an assistant text block as the bare text", () => {
    const line = event({
      type: "assistant",
      message: { content: [{ type: "text", text: "Looks good to me." }] }
    });

    expect(renderLine(line)).toBe("Looks good to me.");
  });

  test("renders a tool call as an action line with a compact argument summary", () => {
    const line = event({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }]
      }
    });

    expect(renderLine(line)).toBe("→ Bash: git status");
  });

  test("renders a thinking block in full behind a thinking marker", () => {
    const line = event({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "First I will inspect the diff, then the tests." }]
      }
    });

    expect(renderLine(line)).toBe("💭 First I will inspect the diff, then the tests.");
  });

  test("truncates a tool result to a single short line so the log stays readable", () => {
    const longOutput = `first line\n${"x".repeat(500)}`;
    const line = event({
      type: "user",
      message: { content: [{ type: "tool_result", content: longOutput }] }
    });

    const rendered = renderLine(line);
    expect(rendered?.startsWith("← first line")).toBe(true);
    expect(rendered).not.toContain("\n");
    expect(rendered!.length).toBeLessThan(120);
  });

  test("passes a non-JSON line through verbatim, so stderr is never swallowed", () => {
    expect(renderLine("warning: something happened on stderr")).toBe(
      "warning: something happened on stderr"
    );
  });

  test("surfaces a rate-limit wait, the signal that distinguishes waiting from thinking", () => {
    const line = event({
      type: "rate_limit_event",
      rate_limit_info: { status: "throttled" }
    });

    expect(renderLine(line)).toBe("⏳ rate limit (throttled)");
  });

  test("drops a normal allowed rate-limit heartbeat as noise", () => {
    const line = event({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed" }
    });

    expect(renderLine(line)).toBeNull();
  });

  test("renders the init event as a one-line session header", () => {
    const line = event({ type: "system", subtype: "init", model: "claude-sonnet-4-6" });

    expect(renderLine(line)).toBe("● claude session (model: claude-sonnet-4-6)");
  });

  test("drops session-start hook noise", () => {
    expect(renderLine(event({ type: "system", subtype: "hook_started" }))).toBeNull();
    expect(renderLine(event({ type: "system", subtype: "hook_response" }))).toBeNull();
  });

  test("renders the terminal result as a concise footer", () => {
    const line = event({ type: "result", subtype: "success", num_turns: 3, duration_ms: 13389 });

    expect(renderLine(line)).toBe("✓ done (3 turns, 13s)");
  });

  test("drops an unknown structured event rather than spamming the log", () => {
    expect(renderLine(event({ type: "some_future_event", data: 1 }))).toBeNull();
  });
});

describe("claudeRunLogCodec.extractResultText", () => {
  test("returns the final assistant message from the terminal result event", () => {
    const stdout = [
      event({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
      event({ type: "result", subtype: "success", result: "All done." })
    ].join("\n");

    expect(extractResultText(stdout)).toBe("All done.");
  });

  test("falls back to a plain sentinel when no result event is present", () => {
    const stdout = event({
      type: "assistant",
      message: { content: [{ type: "text", text: "working" }] }
    });

    expect(extractResultText(stdout)).toBe("krutrimbox: the agent produced no review summary.");
  });
});
