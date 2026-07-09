import { Command, Option } from "commander";
import { AGENT_NAMES, type AgentName } from "../lib/factory/agents/coding-agent";
import {
  createStatusDispatch,
  renderInspectOutcome,
  type StatusDispatch
} from "../lib/factory/inspect";
import { parseIssueNumber } from "./run";

// Reports what the Sandboxed Agent in a Target Issue Sandbox is doing right now —
// busy, stalled, or exited — from a read-only Sandbox Inspection (ADR-0025). The
// dispatch is injected so tests exercise flag parsing without touching `sbx`.
export function createStatusCommand(
  dispatch: StatusDispatch = createStatusDispatch(process.cwd())
): Command {
  return new Command("status")
    .description("Report what the Sandboxed Agent in a Target Issue Sandbox is doing right now.")
    .addOption(
      // Required: the Target Issue whose sandbox to inspect. Unlike `kb run`, there
      // is no batch mode — inspection is always of one named issue.
      new Option("--issue <number>", "the Target Issue whose sandbox to inspect")
        .argParser(parseIssueNumber)
        .makeOptionMandatory()
    )
    .addOption(
      // Optional: the Agent Backend, needed only to break the tie when the same
      // issue was run under both backends (ADR-0025). Otherwise inferred from the
      // one sandbox that exists.
      new Option("--agent <agent>", "the Agent Backend whose sandbox to inspect (if run under both)")
        .choices([...AGENT_NAMES])
    )
    .action(async (options: { issue: number; agent?: AgentName }) => {
      const outcome = await dispatch.inspect({ issueNumber: options.issue, agent: options.agent });
      process.stdout.write(`${renderInspectOutcome(outcome)}\n`);
    });
}
