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
    const sandbox = new CommandSandboxRunner(runner, "/workspace/code-factory", "template");

    await sandbox.removeSandbox({ sandboxName: "code-factory-prd-1" });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: ["rm", "--force", "code-factory-prd-1"]
      }
    ]);
  });
});
