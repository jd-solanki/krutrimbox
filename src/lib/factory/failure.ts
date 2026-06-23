import { Diagnostic } from "nostics";
import { REPORTABLE_INTERNAL_CODES } from "../diagnostics";

// The coarse stage a Factory Run was in when something failed — the primary
// context krutrimbox reports, alongside the specific operation that broke. It
// gives a maintainer a stable bucket to triage by and tells the operator where
// in the run the failure happened.
export type RunPhase =
  | "discovery"
  | "sandbox-setup"
  | "agent"
  | "commit"
  | "pull-request"
  | "hook";

// How many trailing lines of the failure detail the GitHub comment keeps in its
// collapsed block. The full detail always lives in the run log; the comment shows
// only the tail so a maintainer can triage from the issue without it ballooning.
const COMMENT_DETAIL_TAIL_LINES = 40;

// A failure reduced to what every surface (run log, GitHub comment, terminal)
// needs to render it, independent of how it is presented. Built once by
// `diagnose` at the catch site so the run log and the comment never diverge.
export interface DiagnosedFailure {
  phase: RunPhase;
  // The `KB_*` code for an Expected Failure, or null for an Unexpected one.
  code: string | null;
  // True when this is a likely krutrimbox bug worth reporting (uncoded, or a coded
  // krutrimbox invariant), false when the operator can fix it.
  reportable: boolean;
  // The diagnosis, as a single human sentence: the diagnostic's `why`, or the
  // error's message.
  summary: string;
  fix: string | null;
  docs: string | null;
  // The full multi-line detail — message, cause chain, and stack — for the run
  // log's FAILURE block and the comment's collapsed tail.
  detail: string;
}

// A failure is the operator's to resolve when krutrimbox anticipated it: a coded
// (Expected) diagnostic that is not one of krutrimbox's own invariants. Anything
// else — an uncoded error, or an internal-invariant diagnostic — is presented as
// a likely krutrimbox bug worth reporting.
export function isReportable(error: unknown): boolean {
  if (error instanceof Diagnostic) {
    return REPORTABLE_INTERNAL_CODES.has(error.name);
  }
  return true;
}

// Reduces any thrown value, in the context of the Run Phase it surfaced in, to a
// DiagnosedFailure. A Diagnostic contributes its code, `why`, `fix`, and `docs`; a
// plain error contributes its message and is treated as reportable.
export function diagnose(error: unknown, phase: RunPhase): DiagnosedFailure {
  if (error instanceof Diagnostic) {
    return {
      phase,
      code: error.name,
      reportable: isReportable(error),
      summary: error.why,
      fix: error.fix ?? null,
      docs: error.docs ?? null,
      detail: buildDetail(error)
    };
  }

  return {
    phase,
    code: null,
    reportable: true,
    summary: error instanceof Error ? error.message : String(error),
    fix: null,
    docs: null,
    detail: buildDetail(error)
  };
}

// The plain-text FAILURE block appended to the run log so every failure — not
// just an agent's streamed output — leaves a clearly marked, self-contained
// record that can be attached to a bug report.
export function formatFailureBlock(failure: DiagnosedFailure): string {
  const lines = [
    `--- FAILURE [phase: ${failure.phase}] ---`,
    failure.code ? `${failure.summary} [${failure.code}]` : failure.summary
  ];

  if (failure.reportable) {
    lines.push("Likely a krutrimbox bug — please report it.");
  }
  if (failure.fix) {
    lines.push(`Fix: ${failure.fix}`);
  }
  if (failure.docs) {
    lines.push(`Docs: ${failure.docs}`);
  }
  if (failure.detail && failure.detail !== failure.summary) {
    lines.push("", failure.detail);
  }

  return lines.join("\n");
}

export interface ReportUrlInput {
  // The repository's `bugs.url`, e.g. `https://github.com/owner/repo/issues`.
  issuesUrl: string;
  version: string;
  agentName: string;
  phase: RunPhase;
  summary: string;
  // The `KB_*` code for a coded krutrimbox invariant, or null for an uncoded
  // Unexpected Failure — the most triageable field, so it leads the report.
  code: string | null;
  // The local run log to attach to the report. GitHub cannot accept a file through
  // a URL, so the body instructs the operator to attach it by hand.
  logFilePath: string | null;
  environment: { os: string; node: string };
}

// Builds a prefilled "new issue" link for a reportable failure, pre-populating
// the code, environment, and a log-attach instruction so a maintainer gets what
// they need on the first round-trip instead of asking for it. Used for both an
// uncoded Unexpected Failure and a coded krutrimbox invariant.
export function buildReportUrl(input: ReportUrlInput): string {
  const label = input.code ?? "Unexpected error";
  const title = `${label}: ${truncate(input.summary, 80)}`;
  const body = [
    "krutrimbox hit a failure that looks like a bug.",
    "",
    `- Code: ${input.code ?? "(none — uncoded)"}`,
    `- Version: ${input.version}`,
    `- OS: ${input.environment.os}`,
    `- Node: ${input.environment.node}`,
    `- Agent: ${input.agentName}`,
    `- Phase: ${input.phase}`,
    "",
    "Summary:",
    input.summary,
    "",
    `Please attach the run log: ${input.logFilePath ?? ".krutrimbox/logs/<this run>.log"}`
  ].join("\n");

  const query = `title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return `${input.issuesUrl}/new?${query}`;
}

export interface FailureBodyInput {
  failure: DiagnosedFailure;
  // The prefilled report link, or null when the operator can fix the failure.
  reportUrl: string | null;
  // The Target Issue Sandbox, or null when none was created — gating the
  // inspection guidance so krutrimbox never points at a sandbox that never existed.
  sandbox: { name: string; branchName: string } | null;
  logFilePath: string | null;
}

// Renders the body of the AFK failure comment: the diagnosis, what to do about it
// (fix vs report), sandbox inspection guidance when a sandbox exists, and a
// collapsed tail of the failure detail. The surrounding comment template owns the
// framing and rerun command; this owns everything that varies by failure.
export function renderFailureBody(input: FailureBodyInput): string {
  const { failure } = input;
  const sections: string[] = [];

  if (failure.reportable) {
    sections.push("**Unexpected error** — this is likely a krutrimbox bug, not your project.");
    sections.push(`> ${failure.summary}`);
    if (input.reportUrl) {
      const attach = input.logFilePath ? ` and attach the run log at \`${input.logFilePath}\`` : "";
      sections.push(`[**Report this bug**](${input.reportUrl})${attach}.`);
    }
  } else {
    sections.push(`> ${failure.summary}`);
    if (failure.fix) {
      sections.push(`**How to resolve:** ${failure.fix}`);
    }
    if (failure.docs) {
      sections.push(`See ${failure.docs}.`);
    }
  }

  if (input.sandbox) {
    sections.push(renderSandboxSection(input.sandbox));
  }

  if (failure.detail && failure.detail !== failure.summary) {
    sections.push(renderDetailSection(failure.detail));
  }

  return sections.join("\n\n");
}

function renderSandboxSection(sandbox: { name: string; branchName: string }): string {
  return [
    "**Inspect the sandbox**",
    "",
    "```sh",
    `sbx shell ${sandbox.name}`,
    `# inside: git status, git diff, git log ${sandbox.branchName}`,
    "```",
    "",
    "Clean up once you no longer need it:",
    "",
    "```sh",
    `sbx rm ${sandbox.name}`,
    "```"
  ].join("\n");
}

function renderDetailSection(detail: string): string {
  return [
    "<details><summary>Error detail</summary>",
    "",
    "```text",
    tail(detail, COMMENT_DETAIL_TAIL_LINES),
    "```",
    "",
    "</details>"
  ].join("\n");
}

// The full diagnostic record: the error's stack (which includes its message),
// followed by any cause chain so a wrapped failure (e.g. an agent exec error
// behind KB_R0009) still shows the original output.
function buildDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.stack ?? error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  while (cause instanceof Error) {
    parts.push(`Caused by: ${cause.stack ?? cause.message}`);
    cause = (cause as { cause?: unknown }).cause;
  }

  return parts.join("\n");
}

function tail(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join("\n");
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
