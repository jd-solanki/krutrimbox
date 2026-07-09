import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createExecFileCommandRunner } from "../../github";
import { deterministicTargetIssueSlug } from "../issue/sequence";
import { FileTargetIssueLockStore } from "../lock-store";
import {
  SandboxInspector,
  type InspectOutcome,
  type InspectRequest,
  type SandboxLiveness,
  type SandboxStatusReport,
  type SandboxVerdict
} from "./sandbox-inspector";

export * from "./sandbox-inspector";

// The seam the `kb status` command depends on, mirroring `run`'s CliDispatch: the
// command parses flags and renders, the dispatch does the inspection, and tests
// swap in a fake.
export interface StatusDispatch {
  inspect(request: InspectRequest): Promise<InspectOutcome>;
}

// The production dispatch: a SandboxInspector wired to the real `sbx` runner, the
// on-disk Target Issue Lock, this issue's newest host log, and a real inter-sample
// wait — all rooted at `cwd`, the repository the operator launched krutrimbox from.
export function createStatusDispatch(cwd: string): StatusDispatch {
  const lockStore = new FileTargetIssueLockStore(cwd);
  const inspector = new SandboxInspector({
    runner: createExecFileCommandRunner(),
    isIssueLocked: (issueNumber) => lockStore.isHeld(issueNumber),
    readHostLogTail: (issueNumber) => readNewestHostLogTail(cwd, issueNumber),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    workspacePath: cwd
  });

  return { inspect: (request) => inspector.inspect(request) };
}

// How many trailing host-log lines to show as EXITED/STALLED evidence — enough to
// carry the last completed step and any error, without dumping the whole run.
const HOST_LOG_TAIL_LINES = 20;

// The tail of this issue's newest host run log, or null when the log directory or
// a matching file is absent. Run logs are named
// `.krutrimbox/logs/krutrimbox-issue-<n>--<stamp>.log`; the timestamp sorts
// lexicographically, so the last matching name is the newest.
async function readNewestHostLogTail(cwd: string, issueNumber: number): Promise<string | null> {
  const dir = path.join(cwd, ".krutrimbox", "logs");
  const prefix = `${deterministicTargetIssueSlug(issueNumber)}--`;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  const newest = entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .sort()
    .at(-1);
  if (!newest) {
    return null;
  }

  const content = await readFile(path.join(dir, newest), "utf8");
  const lines = content.split("\n").filter((line) => line.length > 0);
  return lines.slice(-HOST_LOG_TAIL_LINES).join("\n");
}

// Renders a Sandbox Inspection outcome as the operator-facing dashboard. Absence
// is a plain informative line, not an error; a report leads with the headline
// Liveness and Verdict, then the evidence each verdict earned.
export function renderInspectOutcome(outcome: InspectOutcome): string {
  if (outcome.kind === "no-sandbox") {
    const under = outcome.agent ? ` under ${outcome.agent}` : "";
    return `No Target Issue Sandbox for #${outcome.issueNumber}${under} — it was never run, or completed and was torn down.`;
  }

  return renderReport(outcome.report);
}

function renderReport(report: SandboxStatusReport): string {
  const lines = [
    `Target Issue #${report.issueNumber} · ${report.sandboxName} · ${report.agent}`,
    `Liveness: ${LIVENESS_LABEL[report.liveness]}`,
    `Verdict:  ${verdictLine(report)}`,
    `Work:     ${workLine(report.work)}`
  ];

  if (report.policyLog) {
    lines.push("", "Recent network policy decisions (evidence):", indent(report.policyLog));
  }
  if (report.hostLogTail) {
    lines.push("", "Last host-log lines:", indent(report.hostLogTail));
  }

  return lines.join("\n");
}

const LIVENESS_LABEL: Record<SandboxLiveness, string> = {
  live: "LIVE (a Factory Run is driving the sandbox)",
  stale: "STALE (lock held but no agent — a crashed or between-sessions run)",
  "left-behind": "LEFT-BEHIND (no run; sandbox kept for inspection)"
};

const VERDICT_LABEL: Record<SandboxVerdict, string> = {
  busy: "BUSY",
  stalled: "STALLED",
  exited: "EXITED"
};

function verdictLine(report: SandboxStatusReport): string {
  const label = VERDICT_LABEL[report.verdict];
  if (report.verdict === "exited") {
    return report.execReachable
      ? `${label} — no Sandboxed Agent process (crashed or finished)`
      : `${label} — the sandbox is stopped (nothing running to inspect)`;
  }
  if (report.activeCommand) {
    const verb = report.verdict === "busy" ? "running" : "pinned on";
    return `${label} — ${verb}: ${report.activeCommand}`;
  }
  return `${label} — agent process only (between tool calls or awaiting the model)`;
}

function workLine(work: { branch: string; changedFiles: number } | null): string {
  if (!work) {
    return "(sandbox stopped — git state unavailable)";
  }
  const files = work.changedFiles === 1 ? "1 file changed" : `${work.changedFiles} files changed`;
  return `${work.branch} · ${files}`;
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
