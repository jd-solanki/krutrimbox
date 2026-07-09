import { describe, expect, test, vi } from "vitest";
import { Command } from "commander";
import { createRunCommand, type CliDispatch } from "../src/commands/run";
import { createStatusCommand } from "../src/commands/status";
import type { InspectOutcome, StatusDispatch } from "../src/lib/factory/inspect";

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

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42, "claude", {
      baseBranch: undefined,
      implementUnassigned: undefined
    });
    expect(dispatch.runBatch).not.toHaveBeenCalled();
  });

  test("dispatches a Batch Run with the chosen Agent Backend when no Target Issue number is provided", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--agent", "codex"]);

    expect(dispatch.runBatch).toHaveBeenCalledWith("codex", {
      baseBranch: undefined,
      implementUnassigned: undefined
    });
    expect(dispatch.runExplicit).not.toHaveBeenCalled();
  });

  test("forwards an explicit base branch to an Explicit Run", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync([
      "node", "kb", "run", "--issue", "42", "--agent", "claude", "--base-branch", "dev"
    ]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42, "claude", {
      baseBranch: "dev",
      implementUnassigned: undefined
    });
  });

  test("forwards an explicit base branch to a Batch Run", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--agent", "codex", "--base-branch", "dev"]);

    expect(dispatch.runBatch).toHaveBeenCalledWith("codex", {
      baseBranch: "dev",
      implementUnassigned: undefined
    });
  });

  test("forwards the Implement-Unassigned Override to a run", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync([
      "node", "kb", "run", "--agent", "codex", "--implement-unassigned"
    ]);

    expect(dispatch.runBatch).toHaveBeenCalledWith("codex", {
      baseBranch: undefined,
      implementUnassigned: true
    });
  });

  test("forwards an explicit Model to a run", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync([
      "node", "kb", "run", "--issue", "42", "--agent", "claude", "--model", "opus"
    ]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42, "claude", {
      baseBranch: undefined,
      implementUnassigned: undefined,
      model: "opus"
    });
  });

  test("forwards an explicit Reasoning Effort to a run", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync([
      "node", "kb", "run", "--issue", "42", "--agent", "claude", "--effort", "high"
    ]);

    expect(dispatch.runExplicit).toHaveBeenCalledWith(42, "claude", {
      baseBranch: undefined,
      implementUnassigned: undefined,
      model: undefined,
      effort: "high"
    });
  });

  test("leaves the Model unset when --model is omitted, so the backend auto-picks", async () => {
    const dispatch = createTestDispatch();
    const program = createTestProgram(dispatch);

    await program.parseAsync(["node", "kb", "run", "--agent", "codex"]);

    expect(dispatch.runBatch).toHaveBeenCalledWith("codex", {
      baseBranch: undefined,
      implementUnassigned: undefined,
      model: undefined
    });
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

describe("krutrimbox CLI: status", () => {
  const noSandbox: InspectOutcome = { kind: "no-sandbox", issueNumber: 1 };

  function createStatusDispatch(): StatusDispatch {
    return { inspect: vi.fn(async () => noSandbox) };
  }

  function createStatusProgram(dispatch: StatusDispatch): Command {
    const program = new Command("kb");
    program.exitOverride();
    program.addCommand(createStatusCommand(dispatch).exitOverride());
    return program;
  }

  test("inspects the given Target Issue, inferring the Agent Backend when omitted", async () => {
    const dispatch = createStatusDispatch();
    const program = createStatusProgram(dispatch);

    await program.parseAsync(["node", "kb", "status", "--issue", "1"]);

    expect(dispatch.inspect).toHaveBeenCalledWith({ issueNumber: 1, agent: undefined });
  });

  test("narrows to the named Agent Backend when --agent is given", async () => {
    const dispatch = createStatusDispatch();
    const program = createStatusProgram(dispatch);

    await program.parseAsync(["node", "kb", "status", "--issue", "1", "--agent", "claude"]);

    expect(dispatch.inspect).toHaveBeenCalledWith({ issueNumber: 1, agent: "claude" });
  });

  test("requires --issue, since inspection is always of one named issue", async () => {
    const program = createStatusProgram(createStatusDispatch());

    await expect(program.parseAsync(["node", "kb", "status"])).rejects.toThrow(
      /required option .*--issue/
    );
  });

  test("rejects an unknown Agent Backend", async () => {
    const program = createStatusProgram(createStatusDispatch());

    await expect(
      program.parseAsync(["node", "kb", "status", "--issue", "1", "--agent", "gemini"])
    ).rejects.toThrow(/--agent/);
  });
});
