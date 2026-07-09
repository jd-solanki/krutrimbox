import { Diagnostic } from "nostics";
import { describe, expect, test } from "vitest";
import type { CommandRunner } from "../src/lib/github";
import {
  SandboxInspector,
  matchTargetIssueSandboxes,
  parseGitStatus,
  parseProcessSnapshot,
  renderInspectOutcome,
  type InspectOutcome,
  type SandboxInspectorDeps
} from "../src/lib/factory/inspect";

// A `ps -eo pid,ppid,stat,time,args` capture: init, the Sandboxed Agent, and a
// child install with `cpu` seconds of cumulative CPU time. Raising `cpu` between
// two samples is the only "work happened" signal the verdict trusts.
function psWithInstall(cpu: number): string {
  return [
    "    PID    PPID STAT     TIME COMMAND",
    "      1       0 Ss   00:00:01 /sbin/init",
    "     42       1 Ssl  00:00:10 claude -p implement #4 --output-format stream-json",
    `     57      42 R    ${formatCpu(cpu)} node /usr/local/bin/pnpm install`
  ].join("\n");
}

// The agent alone with no child sub-command — between tool calls or awaiting the model.
const PS_AGENT_ONLY = [
  "    PID    PPID STAT     TIME COMMAND",
  "      1       0 Ss   00:00:01 /sbin/init",
  "     42       1 Ssl  00:00:10 claude -p implement #4 --output-format stream-json"
].join("\n");

// No Sandboxed Agent process at all — the run crashed or finished.
const PS_NO_AGENT = ["    PID    PPID STAT     TIME COMMAND", "      1       0 Ss   00:00:01 /sbin/init"].join(
  "\n"
);

function formatCpu(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `00:${mm}:${ss}`;
}

interface Scenario {
  sandboxes?: string[];
  lsError?: boolean;
  psSamples?: string[];
  // A stopped sandbox fails every `sbx exec` (both the ps sample and the git read).
  execError?: boolean;
  gitStatus?: string;
  policyLog?: string;
  locked?: boolean;
  hostLogTail?: string | null;
}

function buildInspector(scenario: Scenario): SandboxInspector {
  const psQueue = [...(scenario.psSamples ?? [])];

  const runner: CommandRunner = async (command, args) => {
    if (command !== "sbx") {
      return "";
    }
    if (args[0] === "ls") {
      if (scenario.lsError) {
        throw new Error("sbx: command not found");
      }
      const names = (scenario.sandboxes ?? []).map((name) => ({ name }));
      return JSON.stringify({ sandboxes: names });
    }
    if (args[0] === "policy") {
      return scenario.policyLog ?? "";
    }
    if (args[0] === "exec") {
      if (scenario.execError) {
        throw new Error("Error: container is not running");
      }
      if (args.includes("ps")) {
        return psQueue.length > 1 ? psQueue.shift()! : psQueue[0] ?? PS_NO_AGENT;
      }
      if (args.includes("status")) {
        return scenario.gitStatus ?? "## krutrimbox/issue-1...origin/krutrimbox/issue-1\n";
      }
    }
    return "";
  };

  const deps: SandboxInspectorDeps = {
    runner,
    isIssueLocked: async () => scenario.locked ?? false,
    readHostLogTail: async () =>
      scenario.hostLogTail === undefined ? "krutrimbox: last log line" : scenario.hostLogTail,
    sleep: async () => {},
    workspacePath: "/workspace/acme-webapp"
  };

  return new SandboxInspector(deps);
}

function reportOf(outcome: InspectOutcome) {
  if (outcome.kind !== "reported") {
    throw new Error(`expected a report, got ${outcome.kind}`);
  }
  return outcome.report;
}

describe("SandboxInspector.inspect", () => {
  test("reports BUSY when the agent subtree burns CPU between the two samples", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"],
      psSamples: [psWithInstall(30), psWithInstall(45)],
      locked: true
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("busy");
    expect(report.activeCommand).toContain("pnpm install");
    expect(report.liveness).toBe("live");
    expect(report.policyLog).toBeNull();
    expect(report.hostLogTail).toBeNull();
  });

  test("reports STALLED when a sub-command is running but the subtree makes no CPU progress", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"],
      psSamples: [psWithInstall(30), psWithInstall(30)],
      policyLog: "DENY registry.npmjs.org",
      hostLogTail: "krutrimbox: running pnpm install",
      locked: true
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("stalled");
    expect(report.activeCommand).toContain("pnpm install");
    expect(report.policyLog).toBe("DENY registry.npmjs.org");
    expect(report.hostLogTail).toBe("krutrimbox: running pnpm install");
  });

  test("reports BUSY when one sub-command finished and a new one started (churn, not a stall)", async () => {
    // sample1: install (pid 57, 30s). sample2: install gone, a build (pid 58) has
    // started at 5s. A subtree-total comparison would see 40s → 15s and misread
    // progress as a stall; a fresh sub-command is progress.
    const sampleA = [
      "    PID    PPID STAT     TIME COMMAND",
      "     42       1 Ssl  00:00:10 claude -p implement #4",
      "     57      42 R    00:00:30 node /usr/local/bin/pnpm install"
    ].join("\n");
    const sampleB = [
      "    PID    PPID STAT     TIME COMMAND",
      "     42       1 Ssl  00:00:10 claude -p implement #4",
      "     58      42 R    00:00:05 node /usr/local/bin/pnpm build"
    ].join("\n");
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"],
      psSamples: [sampleA, sampleB],
      locked: true
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("busy");
    expect(report.activeCommand).toContain("pnpm build");
  });

  test("reports BUSY (thinking) when only the agent process is present with flat CPU", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"],
      psSamples: [PS_AGENT_ONLY, PS_AGENT_ONLY],
      locked: true
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("busy");
    expect(report.activeCommand).toBeNull();
    expect(report.policyLog).toBeNull();
  });

  test("reports EXITED with a STALE liveness when the lock is held but no agent runs", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"],
      psSamples: [PS_NO_AGENT, PS_NO_AGENT],
      locked: true
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("exited");
    expect(report.liveness).toBe("stale");
    expect(report.hostLogTail).toBe("krutrimbox: last log line");
  });

  test("reports EXITED with a LEFT-BEHIND liveness when neither lock nor agent is present", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"],
      psSamples: [PS_NO_AGENT, PS_NO_AGENT],
      locked: false
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.liveness).toBe("left-behind");
  });

  test("degrades work to unavailable when the container is stopped so `sbx exec` fails", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex"],
      execError: true,
      locked: false
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("exited");
    expect(report.execReachable).toBe(false);
    expect(report.work).toBeNull();
    expect(renderInspectOutcome({ kind: "reported", report })).toContain("sandbox is stopped");
  });

  test("distinguishes a crashed agent in a running sandbox from a stopped sandbox", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex"],
      psSamples: [PS_NO_AGENT, PS_NO_AGENT],
      locked: true
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.verdict).toBe("exited");
    expect(report.execReachable).toBe(true);
    expect(renderInspectOutcome({ kind: "reported", report })).toContain("crashed or finished");
  });

  test("returns a no-sandbox outcome (not an error) when no sandbox exists for the issue", async () => {
    const inspector = buildInspector({ sandboxes: ["krutrimbox-issue-2-acme-webapp-1a2b3c4d-codex"] });

    const outcome = await inspector.inspect({ issueNumber: 1 });

    expect(outcome.kind).toBe("no-sandbox");
  });

  test("infers the agent from the single matching sandbox without --agent", async () => {
    const inspector = buildInspector({
      sandboxes: ["krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex"],
      psSamples: [psWithInstall(30), psWithInstall(45)]
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1 }));

    expect(report.agent).toBe("codex");
  });

  test("demands --agent when the same issue ran under both backends", async () => {
    const inspector = buildInspector({
      sandboxes: [
        "krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex",
        "krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"
      ]
    });

    const error = await inspector.inspect({ issueNumber: 1 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Diagnostic);
    expect((error as Diagnostic).name).toBe("KB_R0014");
  });

  test("narrows to the named backend when --agent breaks the tie", async () => {
    const inspector = buildInspector({
      sandboxes: [
        "krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex",
        "krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"
      ],
      psSamples: [psWithInstall(30), psWithInstall(45)]
    });

    const report = reportOf(await inspector.inspect({ issueNumber: 1, agent: "claude" }));

    expect(report.agent).toBe("claude");
    expect(report.sandboxName).toContain("-claude");
  });

  test("raises KB_R0015 when `sbx ls` itself fails", async () => {
    const inspector = buildInspector({ lsError: true });

    const error = await inspector.inspect({ issueNumber: 1 }).catch((caught: unknown) => caught);

    expect((error as Diagnostic).name).toBe("KB_R0015");
  });
});

describe("matchTargetIssueSandboxes", () => {
  test("matches by the issue prefix and tags each by its Agent Backend suffix", () => {
    const matches = matchTargetIssueSandboxes(
      [
        "krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex",
        "krutrimbox-issue-1-acme-webapp-1a2b3c4d-claude"
      ],
      1
    );

    expect(matches.map((match) => match.agent).sort()).toEqual(["claude", "codex"]);
  });

  test("does not confuse issue 1 with issue 15", () => {
    const matches = matchTargetIssueSandboxes(["krutrimbox-issue-15-acme-webapp-1a2b3c4d-codex"], 1);

    expect(matches).toEqual([]);
  });
});

describe("parseProcessSnapshot", () => {
  test("drops the header row and keeps command arguments with embedded spaces", () => {
    const processes = parseProcessSnapshot(psWithInstall(30));

    expect(processes.map((process) => process.pid)).toEqual([1, 42, 57]);
    expect(processes[2].args).toBe("node /usr/local/bin/pnpm install");
    expect(processes[2].cpuSeconds).toBe(30);
  });
});

describe("parseGitStatus", () => {
  test("reads the branch from the header and counts changed files", () => {
    const work = parseGitStatus(
      "## krutrimbox/issue-1...origin/krutrimbox/issue-1\n M src/a.ts\n?? src/b.ts\n"
    );

    expect(work).toEqual({ branch: "krutrimbox/issue-1", changedFiles: 2 });
  });
});

describe("renderInspectOutcome", () => {
  test("renders the no-sandbox state as an informative line, not an error", () => {
    const text = renderInspectOutcome({ kind: "no-sandbox", issueNumber: 7 });

    expect(text).toContain("No Target Issue Sandbox for #7");
  });

  test("leads a report with liveness and verdict and shows the active command", () => {
    const text = renderInspectOutcome({
      kind: "reported",
      report: {
        issueNumber: 1,
        agent: "codex",
        sandboxName: "krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex",
        liveness: "live",
        verdict: "busy",
        execReachable: true,
        activeCommand: "pnpm install",
        work: { branch: "krutrimbox/issue-1", changedFiles: 3 },
        policyLog: null,
        hostLogTail: null
      }
    });

    expect(text).toContain("BUSY");
    expect(text).toContain("pnpm install");
    expect(text).toContain("3 files changed");
  });
});
