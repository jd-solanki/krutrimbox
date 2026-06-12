import { Command, Option } from "commander";
import { runCodeFactory } from "../lib/factory/index";

// Injection seam: the CLI layer only needs these two entry points, so tests can
// pass a fake dispatch instead of the real CodeFactory orchestration.
export interface CliDispatch {
  runExplicit(prdNumber: number): Promise<void> | void;
  runBatch(): Promise<void> | void;
}

export function createRunCommand(dispatch: CliDispatch = runCodeFactory): Command {
  return new Command("run")
    .description("Run Code Factory for one PRD or all ready PRDs.")
    .addOption(
      new Option("--prd <number>", "run one explicit PRD by issue number").argParser(
        parsePrdNumber
      )
    )
    .action(async (options: { prd?: number }) => {
      if (typeof options.prd === "number") {
        await dispatch.runExplicit(options.prd);
        return;
      }

      await dispatch.runBatch();
    });
}

function parsePrdNumber(value: string): number {
  const prdNumber = Number(value);

  if (!Number.isInteger(prdNumber) || prdNumber < 1) {
    throw new Error("PRD number must be a positive integer.");
  }

  return prdNumber;
}
