import { describe, expect, test } from "vitest";
import { CommandSandboxRunner, resolveCodingAgent } from "../src/lib/factory/index";
import type { CommandRunner } from "../src/lib/github";

const codex = resolveCodingAgent("codex");
const claude = resolveCodingAgent("claude");

describe("CommandSandboxRunner", () => {
  test("checks out an existing branch and pulls the remote branch before work starts", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });

      if (args.includes("--list")) {
        return "  krutrimbox/issue-1\n";
      }

      if (args.includes("ls-remote")) {
        return "abc123\trefs/heads/krutrimbox/issue-1\n";
      }

      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1"
    });

    expect(calls.map((call) => call.args.slice(5))).toEqual([
      ["git", "branch", "--list", "krutrimbox/issue-1"],
      ["git", "ls-remote", "--heads", "origin", "krutrimbox/issue-1"],
      ["git", "checkout", "krutrimbox/issue-1"],
      ["git", "pull", "--no-rebase", "--autostash", "--no-edit", "origin", "krutrimbox/issue-1"]
    ]);
  });

  test("creates a local branch without pulling when the remote branch does not exist yet", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1"
    });

    expect(calls.map((call) => call.args.slice(5))).toEqual([
      ["git", "branch", "--list", "krutrimbox/issue-1"],
      ["git", "ls-remote", "--heads", "origin", "krutrimbox/issue-1"],
      ["git", "checkout", "-B", "krutrimbox/issue-1"]
    ]);
  });

  test("creates the sandbox with the Agent Backend's `sbx` agent name and template", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return command === "sbx" && args[0] === "ls" ? '{"sandboxes":[]}' : "";
    };
    const sandbox = new CommandSandboxRunner(
      runner,
      "/workspace/krutrimbox",
      claude,
      "docker.io/library/krutrimbox-claude:pnpm"
    );

    await sandbox.ensureSandbox({ sandboxName: "krutrimbox-issue-1-claude" });

    expect(calls.at(-1)).toEqual({
      command: "sbx",
      args: [
        "create",
        "--clone",
        "--template",
        "docker.io/library/krutrimbox-claude:pnpm",
        "--name",
        "krutrimbox-issue-1-claude",
        "claude",
        "/workspace/krutrimbox"
      ]
    });
  });

  test("runs an AFK Issue through the Agent Backend's non-interactive exec command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", claude, "template");

    await sandbox.runAfkIssue({
      sandboxName: "krutrimbox-issue-1-claude",
      branchName: "krutrimbox/issue-1",
      prompt: "implement #4"
    });

    expect(calls[0].args.slice(5)).toEqual([
      "claude",
      "-p",
      "implement #4",
      "--dangerously-skip-permissions"
    ]);
  });

  test("runs the final review through the Codex Agent Backend's exec command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "review body";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    const review = await sandbox.runFinalReview({
      sandboxName: "krutrimbox-issue-1-codex",
      prompt: "review the diff"
    });

    expect(review).toBe("review body");
    expect(calls[0].args.slice(5)).toEqual([
      "codex",
      "exec",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "review the diff"
    ]);
  });

  test("removes clone sandboxes without an interactive confirmation prompt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.removeSandbox({ sandboxName: "krutrimbox-issue-1-codex" });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: ["rm", "--force", "krutrimbox-issue-1-codex"]
      }
    ]);
  });
});
