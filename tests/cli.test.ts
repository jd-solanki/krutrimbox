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
  test("dispatches an Explicit Run with a numeric PRD number", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--prd", "42"]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42);
    expect(dispatch.runBatch).not.toHaveBeenCalled();
  });

  test("dispatches a Batch Run when no PRD number is provided", async () => {
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
