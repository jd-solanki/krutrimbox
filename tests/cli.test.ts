import { describe, expect, test, vi } from "vitest";
import { createProgram, type CliDispatch } from "../src/index";

function createTestDispatch(): CliDispatch {
  return {
    runExplicit: vi.fn(),
    runBatch: vi.fn()
  };
}

describe("code-factory CLI", () => {
  test("dispatches an Explicit Run with a numeric PRD number", async () => {
    const dispatch = createTestDispatch();
    const program = createProgram(dispatch);

    await program.parseAsync(["node", "code-factory", "run", "--prd", "42"]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42);
    expect(dispatch.runBatch).not.toHaveBeenCalled();
  });

  test("dispatches a Batch Run when no PRD number is provided", async () => {
    const dispatch = createTestDispatch();
    const program = createProgram(dispatch);

    await program.parseAsync(["node", "code-factory", "run"]);

    expect(dispatch.runBatch).toHaveBeenCalledOnce();
    expect(dispatch.runExplicit).not.toHaveBeenCalled();
  });
});
