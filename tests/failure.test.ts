import { describe, expect, test } from "vitest";
import { diagnostics } from "../src/lib/diagnostics";
import {
  buildReportUrl,
  diagnose,
  formatFailureBlock,
  isReportable,
  renderFailureBody
} from "../src/lib/factory/failure";

describe("isReportable", () => {
  test("an uncoded error is a likely krutrimbox bug worth reporting", () => {
    expect(isReportable(new Error("Unexpected token 'S'"))).toBe(true);
    expect(isReportable("not even an error")).toBe(true);
  });

  test("an Expected diagnostic the operator can fix is not reportable", () => {
    expect(isReportable(diagnostics.KB_R0009({ detail: "exit code 1" }))).toBe(false);
  });

  test("a coded krutrimbox invariant is reportable like an uncoded error", () => {
    expect(isReportable(diagnostics.KB_R0007())).toBe(true);
  });
});

describe("diagnose", () => {
  test("lifts an Expected diagnostic's why, fix, and docs into the report", () => {
    const failure = diagnose(diagnostics.KB_R0009({ detail: "exit code 1" }), "agent");

    expect(failure.code).toBe("KB_R0009");
    expect(failure.reportable).toBe(false);
    expect(failure.fix).toBeTruthy();
    expect(failure.docs).toContain("kb_r0009");
    expect(failure.phase).toBe("agent");
  });

  test("treats an uncoded error as reportable with no fix and keeps its message", () => {
    const failure = diagnose(new Error("Unexpected token 'S'"), "sandbox-setup");

    expect(failure.code).toBeNull();
    expect(failure.reportable).toBe(true);
    expect(failure.fix).toBeNull();
    expect(failure.summary).toBe("Unexpected token 'S'");
  });

  test("preserves an underlying cause in the detail so the run log shows the original output", () => {
    const cause = new Error("Command failed with exit code 1: sbx exec ...\nStarting sandbox daemon...");
    const wrapped = diagnostics.KB_R0009({ detail: "exit code 1" });
    (wrapped as Error).cause = cause;

    const failure = diagnose(wrapped, "agent");

    expect(failure.detail).toContain("Starting sandbox daemon...");
  });
});

describe("formatFailureBlock", () => {
  test("labels the phase and invites a report for an unexpected failure", () => {
    const block = formatFailureBlock(diagnose(new Error("boom"), "sandbox-setup"));

    expect(block).toContain("FAILURE");
    expect(block).toContain("phase: sandbox-setup");
    expect(block).toContain("boom");
    expect(block.toLowerCase()).toContain("krutrimbox bug");
  });

  test("shows the fix instead of a report invitation for an expected failure", () => {
    const block = formatFailureBlock(diagnose(diagnostics.KB_R0009({ detail: "exit code 1" }), "agent"));

    expect(block).toContain("KB_R0009");
    expect(block).toContain("Fix:");
    expect(block.toLowerCase()).not.toContain("likely a krutrimbox bug");
  });
});

describe("buildReportUrl", () => {
  test("builds a prefilled new-issue link carrying the environment and a log-attach instruction", () => {
    const url = buildReportUrl({
      issuesUrl: "https://github.com/jd-solanki/krutrimbox/issues",
      version: "0.0.6",
      agentName: "claude",
      phase: "sandbox-setup",
      summary: "Unexpected token 'S'",
      code: null,
      logFilePath: "/repo/.krutrimbox/logs/krutrimbox-issue-29--x.log",
      environment: { os: "linux", node: "v22.0.0" }
    });

    expect(url.startsWith("https://github.com/jd-solanki/krutrimbox/issues/new?")).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("0.0.6");
    expect(decoded).toContain("linux");
    expect(decoded).toContain("v22.0.0");
    expect(decoded).toContain("claude");
    expect(decoded).toContain("sandbox-setup");
    expect(decoded).toContain("krutrimbox-issue-29--x.log");
  });

  test("leads with the diagnostic code when a krutrimbox invariant is reported", () => {
    const url = buildReportUrl({
      issuesUrl: "https://github.com/jd-solanki/krutrimbox/issues",
      version: "0.0.6",
      agentName: "claude",
      phase: "discovery",
      summary: "Unexpected GitHub search result type: Repository",
      code: "KB_R0005",
      logFilePath: null,
      environment: { os: "linux", node: "v22.0.0" }
    });

    expect(decodeURIComponent(url)).toContain("KB_R0005");
  });
});

describe("renderFailureBody", () => {
  const reportableFailure = diagnose(new Error("Unexpected token 'S'"), "sandbox-setup");
  const agentFailure = diagnose(diagnostics.KB_R0009({ detail: "exit code 1" }), "agent");

  test("flags an unexpected failure as a krutrimbox bug and links the report", () => {
    const body = renderFailureBody({
      failure: reportableFailure,
      reportUrl: "https://github.com/jd-solanki/krutrimbox/issues/new?title=x",
      sandbox: null,
      logFilePath: "/repo/.krutrimbox/logs/x.log"
    });

    expect(body.toLowerCase()).toContain("likely a krutrimbox bug");
    expect(body).toContain("https://github.com/jd-solanki/krutrimbox/issues/new?title=x");
    expect(body).toContain("/repo/.krutrimbox/logs/x.log");
  });

  test("shows the agent fix and no report link for an expected agent failure", () => {
    const body = renderFailureBody({
      failure: agentFailure,
      reportUrl: null,
      sandbox: { name: "krutrimbox-issue-29-claude", branchName: "krutrimbox/issue-29" },
      logFilePath: null
    });

    expect(body).not.toContain("issues/new");
    expect(body).toContain("krutrimbox/issue-29");
  });

  test("includes sandbox inspection guidance only when a sandbox exists", () => {
    const withSandbox = renderFailureBody({
      failure: agentFailure,
      reportUrl: null,
      sandbox: { name: "krutrimbox-issue-29-claude", branchName: "krutrimbox/issue-29" },
      logFilePath: null
    });
    const withoutSandbox = renderFailureBody({
      failure: reportableFailure,
      reportUrl: "https://x/new",
      sandbox: null,
      logFilePath: null
    });

    expect(withSandbox).toContain("sbx shell krutrimbox-issue-29-claude");
    expect(withoutSandbox).not.toContain("sbx shell");
  });
});
