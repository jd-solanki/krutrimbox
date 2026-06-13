import { describe, expect, test } from "vitest";
import { CommandSandboxRunner } from "../src/lib/factory/index";
import type { CommandRunner } from "../src/lib/github";

describe("CommandSandboxRunner", () => {
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
