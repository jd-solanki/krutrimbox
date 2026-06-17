import type { CommandRunner } from "../github";
import type { CodingAgent } from "./coding-agent";

export interface SandboxInput {
  sandboxName: string;
}

export interface SandboxBranchInput extends SandboxInput {
  branchName: string;
}

export interface SandboxCheckoutInput extends SandboxBranchInput {
  // The origin branch a brand-new Target Issue Branch is cut from. Ignored when the
  // Target Issue Branch already exists on origin (a resume), which is always cut
  // from its own origin tip instead.
  baseBranch: string;
}

export interface SandboxAfkInput extends SandboxBranchInput {
  prompt: string;
  output?: NodeJS.WritableStream;
}

export interface SandboxCommitInput extends SandboxBranchInput {
  // The commit subject line: the Implementation Issue's title verbatim. A
  // Standalone Target Issue commits under its own title; a Parent Target Issue
  // commits each Implementation Issue under that sub-issue's title.
  subject: string;
  issueNumber: number;
}

export interface SandboxFinalReviewInput extends SandboxInput {
  prompt: string;
  output?: NodeJS.WritableStream;
}

interface SandboxExecOptions {
  output?: NodeJS.WritableStream;
}

interface SshRemote {
  host: string;
  repoPath: string;
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

    await this.normalizeOrigin(input.sandboxName);
  }

  // Rewrites the sandbox clone's `origin` to HTTPS so later remote git operations
  // can authenticate. Why this is needed, and why HTTPS specifically:
  //
  // The scenario: `sbx create --clone` gives the sandbox a private clone that
  // inherits the host repo's `origin` URL verbatim. Many hosts use an SSH remote,
  // commonly an `~/.ssh/config` alias such as `git@github-personal:owner/repo.git`.
  // Inside the sandbox that remote is unusable on two counts: the sandbox carries no
  // SSH keys to authenticate with, and no `~/.ssh/config` to resolve the alias — so
  // even name resolution fails ("Could not resolve hostname github-personal") on the
  // first `git ls-remote`/`pull`/`push`.
  //
  // Why HTTPS is the fix: the only credential krutrimbox injects into a sandbox is
  // Docker Sandboxes' `github` secret, and the credential proxy applies it to HTTPS
  // GitHub requests only — never SSH. We deliberately do not forward host SSH keys
  // into the sandbox. So converting `origin` to its HTTPS GitHub form is what lets
  // that secret authenticate the push at the end of the run. Run before any remote
  // operation; idempotent, since an already-HTTPS `origin` is left untouched and
  // reused sandboxes pay only for the read.
  private async normalizeOrigin(sandboxName: string): Promise<void> {
    const current = (
      await this.exec(sandboxName, ["git", "remote", "get-url", "origin"])
    ).trim();
    const https = toHttpsRemoteUrl(current);
    if (https && https !== current) {
      await this.exec(sandboxName, ["git", "remote", "set-url", "origin", https]);
    }
  }

  // Cuts the Target Issue Branch from a known origin ref, never from the sandbox
  // clone's current HEAD. `sbx create --clone` follows whichever ref the host had
  // checked out at create time (including local unpushed commits), so cutting from
  // HEAD would leak unrelated host work into the branch. Instead:
  //   - resume (branch already on origin): cut from `origin/<branch>` so the branch
  //     resumes exactly where its last push left off;
  //   - new branch: cut from `origin/<baseBranch>` (the repository default branch,
  //     or whatever `--base-branch` selected).
  // `git checkout -B <branch> FETCH_HEAD` resets the local branch to that origin
  // ref regardless of the clone's HEAD, which is the whole point.
  public async checkoutBranch(input: SandboxCheckoutInput): Promise<void> {
    const remoteBranch = await this.exec(input.sandboxName, [
      "git",
      "ls-remote",
      "--heads",
      "origin",
      input.branchName
    ]);

    const sourceRef = remoteBranch.trim() ? input.branchName : input.baseBranch;

    if (!remoteBranch.trim()) {
      const baseRef = await this.exec(input.sandboxName, [
        "git",
        "ls-remote",
        "--heads",
        "origin",
        input.baseBranch
      ]);

      if (!baseRef.trim()) {
        throw new Error(`Base branch "${input.baseBranch}" does not exist on origin.`);
      }
    }

    await this.exec(input.sandboxName, ["git", "fetch", "origin", sourceRef]);
    await this.exec(input.sandboxName, ["git", "checkout", "-B", input.branchName, "FETCH_HEAD"]);
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
      input.subject,
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

// Converts an `origin` remote URL to its HTTPS GitHub form (see `normalizeOrigin`
// for why the sandbox needs this). Returns null when no rewrite is needed or
// possible: URLs that are already HTTP(S) are left alone, and unrecognized shapes
// are not touched. SSH remotes (scp-style `git@host:owner/repo` or
// `ssh://git@host/owner/repo`) are rewritten. The host is only a usable hostname
// when it contains a dot — a real host (e.g. `github.com`, or an Enterprise host)
// is kept as-is, whereas a dotless host is an `~/.ssh/config` alias whose true
// target we can't recover, so we fall back to `github.com`.
export function toHttpsRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) {
    return null;
  }

  const remote = parseSshRemote(trimmed);
  if (!remote) {
    return null;
  }

  return `https://${normalizeRemoteHost(remote.host)}/${normalizeRepoPath(remote.repoPath)}.git`;
}

function parseSshRemote(url: string): SshRemote | undefined {
  const sshUrl = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  if (sshUrl) {
    return { host: sshUrl[1], repoPath: sshUrl[2] };
  }

  const scpUrl = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(url);
  if (scpUrl) {
    return { host: scpUrl[1], repoPath: scpUrl[2] };
  }

  return undefined;
}

function normalizeRemoteHost(host: string): string {
  return host.includes(".") ? host : "github.com";
}

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replace(/^\/+/, "").replace(/\.git$/i, "");
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
