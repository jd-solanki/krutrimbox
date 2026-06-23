import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  CommandSandboxRunner,
  resolveCodingAgent,
  toHttpsRemoteUrl
} from "../src/lib/factory/index";
import type { CommandRunner } from "../src/lib/github";

const codex = resolveCodingAgent("codex");
const claude = resolveCodingAgent("claude");

// A real `claude -p --output-format stream-json --verbose` capture: hook noise,
// the init line, one assistant turn, a rate-limit event, and the terminal
// `result`. The final assistant text lives in the `result` event's `result`.
const claudeStreamJson = readFileSync(
  new URL("./fixtures/claude-stream.jsonl", import.meta.url),
  "utf8"
);

describe("CommandSandboxRunner", () => {
  test("resumes an existing origin branch by cutting it from its own origin tip", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });

      if (args.includes("ls-remote")) {
        return "abc123\trefs/heads/krutrimbox/issue-1\n";
      }

      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1",
      baseBranch: "main"
    });

    expect(calls.map((call) => call.args.slice(5))).toEqual([
      ["git", "ls-remote", "--heads", "origin", "krutrimbox/issue-1"],
      ["git", "fetch", "origin", "krutrimbox/issue-1"],
      ["git", "checkout", "-B", "krutrimbox/issue-1", "FETCH_HEAD"]
    ]);
  });

  test("cuts a brand-new branch from the base branch's origin tip, not the clone HEAD", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });

      if (args.includes("ls-remote") && args.includes("main")) {
        return "def456\trefs/heads/main\n";
      }

      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.checkoutBranch({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1",
      baseBranch: "main"
    });

    expect(calls.map((call) => call.args.slice(5))).toEqual([
      ["git", "ls-remote", "--heads", "origin", "krutrimbox/issue-1"],
      ["git", "ls-remote", "--heads", "origin", "main"],
      ["git", "fetch", "origin", "main"],
      ["git", "checkout", "-B", "krutrimbox/issue-1", "FETCH_HEAD"]
    ]);
  });

  test("fails fast when the base branch does not exist on origin", async () => {
    const runner: CommandRunner = async () => "";
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await expect(
      sandbox.checkoutBranch({
        sandboxName: "krutrimbox-issue-1-codex",
        branchName: "krutrimbox/issue-1",
        baseBranch: "dev"
      })
    ).rejects.toThrow('Base branch "dev" does not exist on origin.');
  });

  test("creates the sandbox with the Agent Backend's `sbx` agent name and template", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return command === "sbx" && args[0] === "ls" ? '{"sandboxes":[]}' : "";
    };
    const sandbox = new CommandSandboxRunner(
      runner,
      "/workspace/krutrimbox",
      claude,
      "docker.io/library/krutrimbox-claude:pnpm"
    );

    await sandbox.ensureSandbox({ sandboxName: "krutrimbox-issue-1-claude" });

    const createCall = calls.find((call) => call.command === "sbx" && call.args[0] === "create");
    expect(createCall?.args).toEqual([
      "create",
      "--clone",
      "--template",
      "docker.io/library/krutrimbox-claude:pnpm",
      "--name",
      "krutrimbox-issue-1-claude",
      "claude",
      "/workspace/krutrimbox"
    ]);
  });

  test("rewrites an SSH-alias `origin` to its HTTPS GitHub form before remote work", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "sbx" && args[0] === "ls") {
        return '{"sandboxes":[]}';
      }
      if (args.includes("get-url")) {
        return "git@github-personal:jd-solanki/code-factory.git\n";
      }
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", claude, "template");

    await sandbox.ensureSandbox({ sandboxName: "krutrimbox-issue-1-claude" });

    expect(calls.at(-1)?.args.slice(5)).toEqual([
      "git",
      "remote",
      "set-url",
      "origin",
      "https://github.com/jd-solanki/code-factory.git"
    ]);
  });

  test("normalizes the origin of a reused sandbox without recreating it", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "sbx" && args[0] === "ls") {
        return '{"sandboxes":[{"name":"krutrimbox-issue-1-codex"}]}';
      }
      if (args.includes("get-url")) {
        return "git@github-personal:jd-solanki/code-factory.git\n";
      }
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.ensureSandbox({ sandboxName: "krutrimbox-issue-1-codex" });

    expect(calls.some((call) => call.command === "sbx" && call.args[0] === "create")).toBe(false);
    expect(calls.at(-1)?.args.slice(5)).toEqual([
      "git",
      "remote",
      "set-url",
      "origin",
      "https://github.com/jd-solanki/code-factory.git"
    ]);
  });

  test("leaves an HTTPS `origin` untouched so no set-url runs", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "sbx" && args[0] === "ls") {
        return '{"sandboxes":[]}';
      }
      if (args.includes("get-url")) {
        return "https://github.com/jd-solanki/code-factory.git\n";
      }
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.ensureSandbox({ sandboxName: "krutrimbox-issue-1-codex" });

    expect(calls.some((call) => call.args.includes("set-url"))).toBe(false);
  });

  test("runs an AFK Issue through the Agent Backend's non-interactive exec command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", claude, "template");

    await sandbox.runAfkIssue({
      sandboxName: "krutrimbox-issue-1-claude",
      branchName: "krutrimbox/issue-1",
      prompt: "implement #4"
    });

    expect(calls[0].args.slice(5)).toEqual([
      "claude",
      "-p",
      "implement #4",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions"
    ]);
  });

  test("tolerates a non-JSON preamble in `sbx ls` output instead of failing to parse it", async () => {
    // `sbx ls --json` can print progress (e.g. "Starting sandbox daemon...") before
    // the JSON. The existing sandbox must still be recognized so no duplicate create runs.
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (command === "sbx" && args[0] === "ls") {
        return 'Starting sandbox daemon...\n{"sandboxes":[{"name":"krutrimbox-issue-1-codex"}]}';
      }
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.ensureSandbox({ sandboxName: "krutrimbox-issue-1-codex" });

    expect(calls.some((call) => call.command === "sbx" && call.args[0] === "create")).toBe(false);
  });

  test("raises an Expected agent-failure diagnostic, keeping the exec error as its cause", async () => {
    const execError = new Error(
      "Command failed with exit code 1: sbx exec ... claude\nagent stderr here"
    );
    const runner: CommandRunner = async () => {
      throw execError;
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", claude, "template");

    const failure = await sandbox
      .runAfkIssue({
        sandboxName: "krutrimbox-issue-1-claude",
        branchName: "krutrimbox/issue-1",
        prompt: "implement #4"
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect((failure as Error).name).toBe("KB_R0009");
    expect((failure as Error).message).toContain("Sandboxed Agent");
    expect(((failure as Error).cause as Error)).toBe(execError);
  });

  test("runs an Agent Step session through the Codex Agent Backend's exec command", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "review body";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    const review = await sandbox.runAgentSession({
      sandboxName: "krutrimbox-issue-1-codex",
      prompt: "review the diff"
    });

    expect(review).toBe("review body");
    expect(calls[0].args.slice(5)).toEqual([
      "codex",
      "exec",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "review the diff"
    ]);
  });

  test("returns the Claude Agent Backend's final message as the session output, not the raw event stream", async () => {
    const runner: CommandRunner = async () => claudeStreamJson;
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", claude, "template");

    const review = await sandbox.runAgentSession({
      sandboxName: "krutrimbox-issue-1-claude",
      prompt: "review the diff"
    });

    expect(review).toBe("I reviewed the diff. The change looks correct.");
  });

  test("hasWorkingTreeChanges reports a dirty working tree from git status", async () => {
    const runner: CommandRunner = async () => " M src/foo.ts\n";
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await expect(
      sandbox.hasWorkingTreeChanges({ sandboxName: "krutrimbox-issue-1-codex" })
    ).resolves.toBe(true);
  });

  test("hasWorkingTreeChanges reports a clean working tree as no changes", async () => {
    const runner: CommandRunner = async () => "";
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await expect(
      sandbox.hasWorkingTreeChanges({ sandboxName: "krutrimbox-issue-1-codex" })
    ).resolves.toBe(false);
  });

  test("commitReviewChanges commits without a Refs footer and pushes from the host", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.commitReviewChanges({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1",
      subject: 'chore: agent action "simplify" changes',
      body: "Simplify the code."
    });

    const commit = calls.find((call) => call.args.includes("commit"));
    expect(commit?.args.slice(-4)).toEqual([
      "-m",
      'chore: agent action "simplify" changes',
      "-m",
      "Simplify the code."
    ]);
    // No `Refs #` footer: a review commit must stay out of the Done Set.
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("Refs #");
    expect(calls.at(-1)).toEqual({
      command: "git",
      args: ["-C", "/workspace/krutrimbox", "push", "origin", "FETCH_HEAD:refs/heads/krutrimbox/issue-1"]
    });
  });

  test("streams readable lines into the run log for a Claude AFK Issue, not raw JSON", async () => {
    const runner: CommandRunner = async (_command, _args, options) => {
      options?.output?.write(claudeStreamJson);
      return claudeStreamJson;
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", claude, "template");

    let logged = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        logged += chunk.toString();
        callback();
      }
    });

    await sandbox.runAfkIssue({
      sandboxName: "krutrimbox-issue-1-claude",
      branchName: "krutrimbox/issue-1",
      prompt: "implement #4",
      output
    });

    expect(logged).toContain("● claude session (model: claude-sonnet-4-6)");
    expect(logged).toContain("I reviewed the diff. The change looks correct.");
    expect(logged).not.toContain('"type":"result"');
  });

  test("commits the Implementation Issue title as the subject above the Issue Reference Footer", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.commitAndPush({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1",
      subject: "Generalize Implementation Sequence: standalone sequence-of-one",
      issueNumber: 4
    });

    const sandboxGit = calls.filter((call) => call.command === "sbx").map((call) => call.args.slice(5));
    expect(sandboxGit).toEqual([
      ["git", "add", "-A"],
      [
        "git",
        "commit",
        "-m",
        "Generalize Implementation Sequence: standalone sequence-of-one",
        "-m",
        "Refs #4"
      ]
    ]);
  });

  test("publishes the commit from the host via the sandbox remote, never pushing inside the sandbox", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.commitAndPush({
      sandboxName: "krutrimbox-issue-1-codex",
      branchName: "krutrimbox/issue-1",
      subject: "Generalize Implementation Sequence: standalone sequence-of-one",
      issueNumber: 4
    });

    const hostGit = calls.filter((call) => call.command === "git").map((call) => call.args);
    expect(hostGit).toEqual([
      ["-C", "/workspace/krutrimbox", "fetch", "sandbox-krutrimbox-issue-1-codex", "krutrimbox/issue-1"],
      [
        "-C",
        "/workspace/krutrimbox",
        "push",
        "origin",
        "FETCH_HEAD:refs/heads/krutrimbox/issue-1"
      ]
    ]);

    const sandboxGit = calls.filter((call) => call.command === "sbx").map((call) => call.args.slice(5));
    expect(sandboxGit.some((command) => command.includes("push"))).toBe(false);
  });

  test("removes clone sandboxes without an interactive confirmation prompt", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return "";
    };
    const sandbox = new CommandSandboxRunner(runner, "/workspace/krutrimbox", codex, "template");

    await sandbox.removeSandbox({ sandboxName: "krutrimbox-issue-1-codex" });

    expect(calls).toEqual([
      {
        command: "sbx",
        args: ["rm", "--force", "krutrimbox-issue-1-codex"]
      }
    ]);
  });
});

describe("toHttpsRemoteUrl", () => {
  test("rewrites an scp-style SSH alias remote to github.com over HTTPS", () => {
    expect(toHttpsRemoteUrl("git@github-personal:jd-solanki/code-factory.git")).toBe(
      "https://github.com/jd-solanki/code-factory.git"
    );
  });

  test("rewrites a plain github.com SSH remote", () => {
    expect(toHttpsRemoteUrl("git@github.com:jd-solanki/code-factory.git")).toBe(
      "https://github.com/jd-solanki/code-factory.git"
    );
  });

  test("rewrites an `ssh://` remote and tolerates a port", () => {
    expect(toHttpsRemoteUrl("ssh://git@github.com:22/jd-solanki/code-factory.git")).toBe(
      "https://github.com/jd-solanki/code-factory.git"
    );
  });

  test("preserves a real (dotted) host for GitHub Enterprise SSH remotes", () => {
    expect(toHttpsRemoteUrl("git@git.example.com:team/repo.git")).toBe(
      "https://git.example.com/team/repo.git"
    );
  });

  test("appends a `.git` suffix when the SSH remote omits it", () => {
    expect(toHttpsRemoteUrl("git@github-personal:jd-solanki/code-factory")).toBe(
      "https://github.com/jd-solanki/code-factory.git"
    );
  });

  test("returns null for remotes that are already HTTP(S)", () => {
    expect(toHttpsRemoteUrl("https://github.com/jd-solanki/code-factory.git")).toBeNull();
    expect(toHttpsRemoteUrl("http://github.com/jd-solanki/code-factory.git")).toBeNull();
  });

  test("returns null for empty or unrecognized input", () => {
    expect(toHttpsRemoteUrl("")).toBeNull();
    expect(toHttpsRemoteUrl("   ")).toBeNull();
    expect(toHttpsRemoteUrl("not a url")).toBeNull();
  });
});
