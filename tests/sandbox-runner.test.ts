import { describe, expect, test } from "vitest";
import { CommandSandboxRunner } from "../src/lib/factory/index";
import type { CommandRunner } from "../src/lib/github";

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
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-issue-1",
      branchName: "krutrimbox/issue-1"
    });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-issue-1",
          "--",
          "git",
          "branch",
          "--list",
          "krutrimbox/issue-1"
        ]
      },
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-issue-1",
          "--",
          "git",
          "ls-remote",
          "--heads",
          "origin",
          "krutrimbox/issue-1"
        ]
      },
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-issue-1",
          "--",
          "git",
          "checkout",
          "krutrimbox/issue-1"
        ]
      },
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-issue-1",
          "--",
          "git",
          "pull",
          "--no-rebase",
          "--autostash",
          "--no-edit",
          "origin",
          "krutrimbox/issue-1"
        ]
      }
    ]);
  });

  test("creates a local branch without pulling when the remote branch does not exist yet", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-issue-1",
      branchName: "krutrimbox/issue-1"
    });

    expect(calls.map((call) => call.args.slice(5))).toEqual([
      ["git", "branch", "--list", "krutrimbox/issue-1"],
      ["git", "ls-remote", "--heads", "origin", "krutrimbox/issue-1"],
      ["git", "checkout", "-B", "krutrimbox/issue-1"]
    ]);
  });

  test("removes clone sandboxes without an interactive confirmation prompt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", "template");

    await sandbox.removeSandbox({ sandboxName: "krutrimbox-issue-1" });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: ["rm", "--force", "krutrimbox-issue-1"]
      }
    ]);
  });
});
