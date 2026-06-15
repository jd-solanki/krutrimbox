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
  test("dispatches an Explicit Run with a numeric Target Issue number", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--issue", "42"]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42);
    expect(dispatch.runBatch).not.toHaveBeenCalled();
  });

  test("does not expose the retired --prd option", () => {
    const program = createTestProgram(createTestDispatch());
    const runCommand = program.commands.find((command) => command.name() === "run");

    expect(runCommand?.options.map((option) => option.long)).toContain("--issue");
    expect(runCommand?.options.map((option) => option.long)).not.toContain("--prd");
  });

  test("dispatches a Batch Run when no Target Issue number is provided", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run"]);

    expect(dispatch.runBatch).toHaveBeenCalledOnce();
    expect(dispatch.runExplicit).not.toHaveBeenCalled();
  });
});

function createTestProgram(dispatch: CliDispatch): Command {
  const program = new Command("kb");
  program.addCommand(createRunCommand(dispatch));
  return program;
}
