import { Command, Option } from "commander";
import { AGENT_NAMES, type AgentName } from "../lib/factory/coding-agent";
import { runKrutrimbox } from "../lib/factory/index";

// Injection seam: the CLI layer only needs these two entry points, so tests can
// pass a fake dispatch instead of the real Krutrimbox orchestration.
export interface CliDispatch {
  runExplicit(issueNumber: number, agent: AgentName): Promise<void> | void;
  runBatch(agent: AgentName): Promise<void> | void;
}

export function createRunCommand(dispatch: CliDispatch = runKrutrimbox): Command {
  return new Command("run")
    .description("Run krutrimbox for one Target Issue or all ready Target Issues.")
    .addOption(
      new Option("--issue <number>", "run one explicit Target Issue by issue number").argParser(
        parseIssueNumber
      )
    )
    .addOption(
      // Required and the only selector: every run states its Agent Backend
      // explicitly — no environment-variable fallback and no default (ADR-0016).
      new Option("--agent <agent>", "the Agent Backend that implements the run")
        .choices([...AGENT_NAMES])
        .makeOptionMandatory()
    )
    .action(async (options: { issue?: number; agent: AgentName }) => {
      if (typeof options.issue === "number") {
        await dispatch.runExplicit(options.issue, options.agent);
        return;
      }

      await dispatch.runBatch(options.agent);
    });
}

function parseIssueNumber(value: string): number {
  const issueNumber = Number(value);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Target Issue number must be a positive integer.");
  }

  return issueNumber;
}
