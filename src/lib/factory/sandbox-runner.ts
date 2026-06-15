import type { CommandRunner } from "../github";
import type { CodingAgent } from "./coding-agent";

export interface SandboxInput {
  sandboxName: string;
}

export interface SandboxBranchInput extends SandboxInput {
  branchName: string;
}

export interface SandboxAfkInput extends SandboxBranchInput {
  prompt: string;
  output?: NodeJS.WritableStream;
}

export interface SandboxCommitInput extends SandboxBranchInput {
  issueNumber: number;
}

export interface SandboxFinalReviewInput extends SandboxInput {
  prompt: string;
  output?: NodeJS.WritableStream;
}

interface SandboxExecOptions {
  output?: NodeJS.WritableStream;
}

// Drives one Target Issue Sandbox through `sbx`: create/reuse, branch checkout,
// the inner AFK and final-review runs, commit/push, and teardown. All sandbox
// state lives behind these methods so Factory Runs never shell out directly. The
// Agent Backend supplies the only agent-specific bits — the `sbx create` agent
// name and the non-interactive exec command — so this class is agent-agnostic.
export class CommandSandboxRunner {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly workspacePath: string,
    private readonly agent: CodingAgent,
    private readonly templateImage: string
  ) {}

  public async ensureSandbox(input: SandboxInput): Promise<void> {
    const output = await this.runner("sbx", ["ls", "--json"]);
    const { sandboxes } = JSON.parse(output) as { sandboxes: Array<{ name: string }> };
    if (!sandboxes.some((s) => s.name === input.sandboxName)) {
      await this.runner("sbx", [
        "create",
        "--clone",
        "--template",
        this.templateImage,
        "--name",
        input.sandboxName,
        this.agent.sbxAgentName,
        this.workspacePath
      ]);
    }
  }

  public async checkoutBranch(input: SandboxBranchInput): Promise<void> {
    const localBranch = await this.exec(input.sandboxName, [
      "git",
      "branch",
      "--list",
      input.branchName
    ]);
    const remoteBranch = await this.exec(input.sandboxName, [
      "git",
      "ls-remote",
      "--heads",
      "origin",
      input.branchName
    ]);

    if (localBranch.trim()) {
      await this.exec(input.sandboxName, ["git", "checkout", input.branchName]);
    } else {
      await this.exec(input.sandboxName, ["git", "checkout", "-B", input.branchName]);
    }

    if (remoteBranch.trim()) {
      await this.exec(input.sandboxName, [
        "git",
        "pull",
        "--no-rebase",
        "--autostash",
        "--no-edit",
        "origin",
        input.branchName
      ]);
    }
  }

  public async runAfkIssue(input: SandboxAfkInput): Promise<void> {
    await this.exec(input.sandboxName, this.agent.buildExecCommand(input.prompt), {
      output: input.output
    });
  }

  public async runFinalReview(input: SandboxFinalReviewInput): Promise<string> {
    return this.exec(input.sandboxName, this.agent.buildExecCommand(input.prompt), {
      output: input.output
    });
  }

  public async removeSandbox(input: SandboxInput): Promise<void> {
    await this.runner("sbx", ["rm", "--force", input.sandboxName]);
  }

  public async commitAndPush(input: SandboxCommitInput): Promise<void> {
    await this.exec(input.sandboxName, ["git", "add", "-A"]);
    await this.exec(input.sandboxName, [
      "git",
      "commit",
      "-m",
      "chore: krutrimbox implementation",
      "-m",
      `Refs #${input.issueNumber}`
    ]);
    await this.exec(input.sandboxName, ["git", "push", "-u", "origin", input.branchName]);
  }

  private exec(
    sandboxName: string,
    command: string[],
    options: SandboxExecOptions = {}
  ): Promise<string> {
    const args = ["exec", "--workdir", this.workspacePath];
    args.push(sandboxName, "--", ...command);

    return this.runner("sbx", args, { output: options.output });
  }
}

// Injection seam: the public surface of CommandSandboxRunner, so fakes need no separate contract.
export type SandboxRunner = Pick<
  CommandSandboxRunner,
  | "ensureSandbox"
  | "checkoutBranch"
  | "runAfkIssue"
  | "commitAndPush"
  | "runFinalReview"
  | "removeSandbox"
>;
