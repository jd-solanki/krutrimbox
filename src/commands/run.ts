import { Command, Option } from "commander";
import { runKrutrimbox } from "../lib/factory/index";

// Injection seam: the CLI layer only needs these two entry points, so tests can
// pass a fake dispatch instead of the real Krutrimbox orchestration.
export interface CliDispatch {
  runExplicit(issueNumber: number): Promise<void> | void;
  runBatch(): Promise<void> | void;
}

export function createRunCommand(dispatch: CliDispatch = runKrutrimbox): Command {
  return new Command("run")
    .description("Run krutrimbox for one Target Issue or all ready Target Issues.")
    .addOption(
      new Option("--issue <number>", "run one explicit Target Issue by issue number").argParser(
        parseIssueNumber
      )
    )
    .action(async (options: { issue?: number }) => {
      if (typeof options.issue === "number") {
        await dispatch.runExplicit(options.issue);
        return;
      }

      await dispatch.runBatch();
    });
}

function parseIssueNumber(value: string): number {
  const issueNumber = Number(value);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Target Issue number must be a positive integer.");
  }

  return issueNumber;
}
