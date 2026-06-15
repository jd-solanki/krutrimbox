import { describe, expect, test, vi } from "vitest";
import { Command } from "commander";
import { createRunCommand, type CliDispatch } from "../src/commands/run";

function createTestDispatch(): CliDispatch {
  return {
    runExplicit: vi.fn(),
    runBatch: vi.fn()
  };
}

describe("krutrimbox CLI", () => {
  test("dispatches an Explicit Run with the Target Issue number and chosen Agent Backend", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--issue", "42", "--agent", "claude"]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42, "claude");
    expect(dispatch.runBatch).not.toHaveBeenCalled();
  });

  test("dispatches a Batch Run with the chosen Agent Backend when no Target Issue number is provided", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--agent", "codex"]);

    expect(dispatch.runBatch).toHaveBeenCalledWith("codex");
    expect(dispatch.runExplicit).not.toHaveBeenCalled();
  });

  test("requires an Agent Backend so a run never starts without one chosen", async () => {
    const program = createTestProgram(createTestDispatch());

    await expect(program.parseAsync(["node", "kb", "run", "--issue", "42"])).rejects.toThrow(
      /required option .*--agent/
    );
  });

  test("rejects an unknown Agent Backend instead of passing it through", async () => {
    const program = createTestProgram(createTestDispatch());

    await expect(
      program.parseAsync(["node", "kb", "run", "--agent", "gemini"])
    ).rejects.toThrow(/--agent/);
  });

  test("does not expose the retired legacy Target Issue option", () => {
    const program = createTestProgram(createTestDispatch());
    const runCommand = program.commands.find((command) => command.name() === "run");

    expect(runCommand?.options.map((option) => option.long)).toContain("--issue");
    expect(runCommand?.options.map((option) => option.long)).not.toContain("--prd");
  });
});

function createTestProgram(dispatch: CliDispatch): Command {
  const program = new Command("kb");
  // Make Commander throw on usage errors (missing/invalid options) instead of
  // calling process.exit, so the error-path tests can assert on the thrown
  // message. exitOverride is per-command, so the run subcommand needs it too.
  program.exitOverride();
  const runCommand = createRunCommand(dispatch).exitOverride();
  program.addCommand(runCommand);
  return program;
}
