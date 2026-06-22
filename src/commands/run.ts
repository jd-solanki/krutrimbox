import { Command, Option } from "commander";
import { diagnostics } from "../lib/diagnostics";
import { AGENT_NAMES, type AgentName } from "../lib/factory/agents/coding-agent";
import { runKrutrimbox, type RunOptions } from "../lib/factory/index";

// Injection seam: the CLI layer only needs these two entry points, so tests can
// pass a fake dispatch instead of the real Krutrimbox orchestration.
export interface CliDispatch {
  runExplicit(issueNumber: number, agent: AgentName, options?: RunOptions): Promise<void> | void;
  runBatch(agent: AgentName, options?: RunOptions): Promise<void> | void;
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
    .addOption(
      // Optional: the origin branch the Target Issue Branch is cut from and the
      // base the Target Issue Pull Request targets. Omitted, it defaults to the
      // repository's default branch, so teams that integrate on `main` keep their
      // current behavior while teams that integrate on, say, `dev` can point there.
      new Option(
        "--base-branch <branch>",
        "origin branch to start work from and target the PR at (default: repository default branch)"
      )
    )
    .addOption(
      // Optional solo-developer escape hatch: also run issues that have no
      // assignee. It disables the single-assignee collision guard, so it is not
      // for team use (ADR-0018).
      new Option(
        "--implement-unassigned",
        "also run issues that have no assignee (solo-developer escape hatch)"
      )
    )
    .action(
      async (options: {
        issue?: number;
        agent: AgentName;
        baseBranch?: string;
        implementUnassigned?: boolean;
      }) => {
        const runOptions: RunOptions = {
          baseBranch: options.baseBranch,
          implementUnassigned: options.implementUnassigned
        };

        if (typeof options.issue === "number") {
          await dispatch.runExplicit(options.issue, options.agent, runOptions);
          return;
        }

        await dispatch.runBatch(options.agent, runOptions);
      }
    );
}

function parseIssueNumber(value: string): number {
  const issueNumber = Number(value);

  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw diagnostics.KB_R0002();
  }

  return issueNumber;
}
