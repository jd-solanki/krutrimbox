import type { CommandRunner } from "../github";
import { diagnostics } from "../diagnostics";
import type { CodingAgent } from "./coding-agent";
import { RunLogStream } from "./run-log-stream";

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

export interface SandboxAgentSessionInput extends SandboxInput {
  prompt: string;
  output?: NodeJS.WritableStream;
}

export interface SandboxReviewCommitInput extends SandboxBranchInput {
  // The commit subject and body for an Agent Step's code changes. The body
  // carries the step's prompt for traceability (ADR-0021). Unlike AFK commits,
  // a review commit carries no `Refs #` footer, so it never enters the Done Set.
  subject: string;
  body: string;
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
  // that secret authenticate the sandbox's `ls-remote`/`fetch` reads. Those are the
  // only origin operations the sandbox performs — the Target Issue Branch push runs
  // on the host (see `commitAndPush`), so this secret never needs write access. Run
  // before any remote operation; idempotent, since an already-HTTPS `origin` is left
  // untouched and reused sandboxes pay only for the read.
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
        throw diagnostics.KB_R0003({ baseBranch: input.baseBranch });
      }
    }

    await this.exec(input.sandboxName, ["git", "fetch", "origin", sourceRef]);
    await this.exec(input.sandboxName, ["git", "checkout", "-B", input.branchName, "FETCH_HEAD"]);
  }

  public async runAfkIssue(input: SandboxAfkInput): Promise<void> {
    await this.runAgent(input.sandboxName, input.prompt, input.output);
  }

  public async runAgentSession(input: SandboxAgentSessionInput): Promise<string> {
    return this.runAgent(input.sandboxName, input.prompt, input.output);
  }

  // Runs one Sandboxed Agent session and returns its caller-facing text. The two
  // public entry points differ only in whether they use that text: a Review
  // Pipeline Agent Step returns it as a Step Output, an AFK Issue discards it.
  //
  // A structured-output agent (one with a run-log codec) speaks newline-delimited
  // JSON: its raw stdout is decoded to readable lines on the way to the run log,
  // and to the final assistant message on the way to the caller. A plain-prose
  // agent (Codex) has no codec, so its output streams to the run log and returns
  // to the caller verbatim — the exact path it took before codecs existed.
  private async runAgent(
    sandboxName: string,
    prompt: string,
    output?: NodeJS.WritableStream
  ): Promise<string> {
    const command = this.agent.buildExecCommand(prompt);
    const codec = this.agent.runLogCodec;

    if (!codec) {
      return this.exec(sandboxName, command, { output });
    }

    // Render to the run log only when there is one; the caller-facing text is
    // extracted regardless (an Agent Step needs it even with no run-log output).
    const renderStream = output ? new RunLogStream(codec, output) : undefined;
    const stdout = await this.exec(sandboxName, command, { output: renderStream ?? output });
    renderStream?.flush();

    return codec.extractResultText(stdout);
  }

  public async removeSandbox(input: SandboxInput): Promise<void> {
    await this.runner("sbx", ["rm", "--force", input.sandboxName]);
  }

  // Commits the agent's work inside the sandbox, then publishes it from the HOST.
  //
  // The commit is local to the sandbox clone and needs no credential. The push does
  // need a write credential — and we deliberately keep that credential off the
  // sandbox so the injected `github` secret can be read-only. The inner agent runs
  // with approvals bypassed, so a read-only token is its hard write boundary: even
  // if it ignores its prompt, it cannot mutate GitHub.
  //
  // Docker clone mode already exposes the sandbox clone as a `sandbox-<name>` git
  // remote on the host (and keeps its URL current across restarts). So the host
  // fetches the new commit through that remote and pushes it to `origin` with the
  // host's own git credentials. A failed push throws, which leaves the issue out of
  // the Done Set and so resumable on the next run.
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

    await this.publishBranch(input.sandboxName, input.branchName);
  }

  // Whether the sandbox working tree has uncommitted changes — the signal that a
  // Review Pipeline Agent Step modified code that should be committed (ADR-0021).
  // Kept a pure query so the caller decides whether to commit (see commitReviewChanges).
  public async hasWorkingTreeChanges(input: SandboxInput): Promise<boolean> {
    const status = await this.exec(input.sandboxName, ["git", "status", "--porcelain"]);
    return status.trim().length > 0;
  }

  // Commits an Agent Step's code changes in the sandbox and publishes them from the
  // HOST, the same read-only-token-in / host-push-out boundary as commitAndPush.
  // The body carries the step's prompt for traceability, and there is deliberately
  // no `Refs #` footer: a review commit completes no Implementation Issue, so it
  // must stay out of the Done Set.
  public async commitReviewChanges(input: SandboxReviewCommitInput): Promise<void> {
    await this.exec(input.sandboxName, ["git", "add", "-A"]);
    await this.exec(input.sandboxName, [
      "git",
      "commit",
      "-m",
      input.subject,
      "-m",
      input.body
    ]);

    await this.publishBranch(input.sandboxName, input.branchName);
  }

  // Pushes the sandbox clone's branch tip to origin with the host's credentials.
  // Docker clone mode exposes the sandbox clone as a `sandbox-<name>` host remote,
  // so the host fetches the new commit through it and pushes to origin — no write
  // credential ever enters the sandbox. A failed push throws and leaves the branch
  // unchanged, so the work stays resumable.
  private async publishBranch(sandboxName: string, branchName: string): Promise<void> {
    const sandboxRemote = `sandbox-${sandboxName}`;
    await this.hostGit(["fetch", sandboxRemote, branchName]);
    await this.hostGit(["push", "origin", `FETCH_HEAD:refs/heads/${branchName}`]);
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

  // Runs git on the HOST, in the host repository clone, with the host's own
  // credentials — the counterpart to `exec`, which runs git inside the sandbox.
  // This is how a sandbox commit reaches `origin` without a write credential ever
  // entering the sandbox.
  private hostGit(command: string[]): Promise<string> {
    return this.runner("git", ["-C", this.workspacePath, ...command]);
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
  | "runAgentSession"
  | "hasWorkingTreeChanges"
  | "commitReviewChanges"
  | "removeSandbox"
>;
