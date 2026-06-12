import type { CommandRunner } from "../github.js";
import { SANDBOX_CODEX_EXEC_FLAGS } from "./constants.js";

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

// Drives one PRD Sandbox through `sbx`: create/reuse, branch checkout, the inner
// Codex AFK and final-review runs, commit/push, and teardown. All sandbox state
// lives behind these methods so Factory Runs never shell out directly.
export class CommandSandboxRunner {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly workspacePath: string,
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
        "codex",
        this.workspacePath
      ]);
    }
  }

  public async checkoutBranch(input: SandboxBranchInput): Promise<void> {
    await this.exec(input.sandboxName, ["git", "checkout", "-B", input.branchName]);
  }

  public async runAfkIssue(input: SandboxAfkInput): Promise<void> {
    await this.exec(input.sandboxName, this.codexExecCommand(input.prompt), { output: input.output });
  }

  public async runFinalReview(input: SandboxFinalReviewInput): Promise<string> {
    return this.exec(input.sandboxName, this.codexExecCommand(input.prompt), { output: input.output });
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
      "chore: code factory implementation",
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

  private codexExecCommand(prompt: string): string[] {
    return ["codex", "exec", ...SANDBOX_CODEX_EXEC_FLAGS, prompt];
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
