import { describe, expect, test } from "vitest";
import { CommandSandboxRunner } from "../src/lib/factory/index";
import type { CommandRunner } from "../src/lib/github";

describe("CommandSandboxRunner", () => {
  test("checks out an existing branch and pulls the remote branch before work starts", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });

      if (args.includes("--list")) {
        return "  krutrimbox/prd-1\n";
      }

      if (args.includes("ls-remote")) {
        return "abc123\trefs/heads/krutrimbox/prd-1\n";
      }

      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-prd-1",
      branchName: "krutrimbox/prd-1"
    });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-prd-1",
          "--",
          "git",
          "branch",
          "--list",
          "krutrimbox/prd-1"
        ]
      },
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-prd-1",
          "--",
          "git",
          "ls-remote",
          "--heads",
          "origin",
          "krutrimbox/prd-1"
        ]
      },
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-prd-1",
          "--",
          "git",
          "checkout",
          "krutrimbox/prd-1"
        ]
      },
      {
        command: "sbx",
        args: [
          "exec",
          "--workdir",
          "/workspace/krutrimbox",
          "krutrimbox-prd-1",
          "--",
          "git",
          "pull",
          "--no-rebase",
          "--autostash",
          "--no-edit",
          "origin",
          "krutrimbox/prd-1"
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
      sandboxName: "krutrimbox-prd-1",
      branchName: "krutrimbox/prd-1"
    });

    expect(calls.map((call) => call.args.slice(5))).toEqual([
      ["git", "branch", "--list", "krutrimbox/prd-1"],
      ["git", "ls-remote", "--heads", "origin", "krutrimbox/prd-1"],
      ["git", "checkout", "-B", "krutrimbox/prd-1"]
    ]);
  });

  test("removes clone sandboxes without an interactive confirmation prompt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", "template");

    await sandbox.removeSandbox({ sandboxName: "krutrimbox-prd-1" });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: ["rm", "--force", "krutrimbox-prd-1"]
      }
    ]);
  });
});
