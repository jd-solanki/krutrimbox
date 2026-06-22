import type { CommandRunner, GitHubClient } from "../../github";
import type { InterpolationValues } from "../../../utils/interpolate";
import type { SandboxRunner } from "../sandbox-runner";

// The named lifecycle points krutrimbox fires through `hookable` (ADR-0021),
// mapping each hook name to the context its handlers receive. The names live in
// ./names so the config schema can validate against them without an import cycle.
// Add new lifecycle points to both as the surface grows.
export interface KrutrimboxHooks {
  "pull-request:ready": (context: HookContext) => void | Promise<void>;
}

// What a Hook Action receives when its hook fires: the interpolation variables
// (`{{pr_number}}`, …), the running branch/sandbox identifiers Agent and Command
// Actions act on, and the accumulating Action Outputs that later actions interpolate.
export interface HookContext {
  pullRequestNumber: number;
  branchName: string;
  sandboxName: string;
  variables: InterpolationValues;
  outputs: Map<string, string>;
}

// The seams Hook Actions drive, narrowed to the exact GitHub and sandbox
// operations they need so a test fake implements only those.
export interface HookActionDependencies {
  github: Pick<GitHubClient, "createIssueComment">;
  sandbox: Pick<SandboxRunner, "runAgentSession" | "hasWorkingTreeChanges" | "commitReviewChanges">;
  // Runs an allowlisted `gh` Command Action on the HOST with the Operator's
  // credential — the same write boundary as every other krutrimbox GitHub change.
  runHostCommand: CommandRunner;
  logger: Pick<Console, "log">;
  // Where an Agent Action's session output streams while it runs; omitted in tests.
  output?: NodeJS.WritableStream;
}
