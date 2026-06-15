import type { GitHubIssue } from "../github";
import type { AgentName } from "./coding-agent";
import {
  AFK_LABEL,
  HITL_LABEL,
  TARGET_ISSUE_BRANCH_PREFIX,
  TARGET_ISSUE_SANDBOX_PREFIX
} from "./constants";

export interface ImplementationIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN";
  kind: "afk" | "hitl";
  labels: string[];
}

export interface ResolvedIssue {
  number: number;
  title: string;
  state: "CLOSED";
  labels: string[];
}

export interface ImplementationSequence {
  openIssues: ImplementationIssue[];
  resolvedIssues: ResolvedIssue[];
}

export function buildImplementationSequence(
  targetIssue: GitHubIssue,
  attachedSubIssues: GitHubIssue[],
  doneSet: Set<number>
): ImplementationSequence {
  const openIssues: ImplementationIssue[] = [];
  const resolvedIssues: ResolvedIssue[] = [];
  const candidateIssues = attachedSubIssues.length > 0 ? attachedSubIssues : [targetIssue];

  for (const issue of candidateIssues) {
    const labels = labelNames(issue);

    if (attachedSubIssues.length > 0 && issue.parentNumber !== targetIssue.number) {
      continue;
    }

    if (doneSet.has(issue.number)) {
      resolvedIssues.push({
        number: issue.number,
        title: issue.title,
        state: "CLOSED",
        labels
      });
      continue;
    }

    const stateLabels = labels.filter((label) => label === AFK_LABEL || label === HITL_LABEL);

    if (stateLabels.length !== 1) {
      throw new Error(
        `Implementation Issue #${issue.number} must have exactly one open state label: ${AFK_LABEL} or ${HITL_LABEL}.`
      );
    }

    openIssues.push({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: "OPEN",
      kind: stateLabels[0] === AFK_LABEL ? "afk" : "hitl",
      labels
    });
  }

  openIssues.sort((left, right) => left.number - right.number);
  resolvedIssues.sort((left, right) => left.number - right.number);

  return {
    openIssues,
    resolvedIssues
  };
}

export function deterministicTargetIssueBranch(targetIssueNumber: number): string {
  return `${TARGET_ISSUE_BRANCH_PREFIX}${targetIssueNumber}`;
}

// The agent-blind slug for a Target Issue's local artifacts (e.g. the per-run
// log file). Keyed only on the Target Issue, since those artifacts are shared
// across whichever Agent Backend a run uses.
export function deterministicTargetIssueSlug(targetIssueNumber: number): string {
  return `${TARGET_ISSUE_SANDBOX_PREFIX}${targetIssueNumber}`;
}

// The Target Issue Sandbox name is keyed on (Target Issue, Agent Backend) so a
// run with one agent never reuses a sandbox built for another agent's CLI and
// template image (ADR-0007). The Target Issue Branch stays agent-blind, so the
// Done Set and HITL resume are unaffected when the agent changes between runs.
export function deterministicTargetIssueSandbox(
  targetIssueNumber: number,
  agentName: AgentName
): string {
  return `${deterministicTargetIssueSlug(targetIssueNumber)}-${agentName}`;
}

export function parseBlockingIssueNumbers(body: string): number[] {
  const section = extractMarkdownSection(body, "Blocked by");
  const numbers = new Set<number>();

  for (const match of section.matchAll(/#(\d+)\b/g)) {
    numbers.add(Number(match[1]));
  }

  return [...numbers].sort((left, right) => left - right);
}

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels.map((label) => label.name);
}

function extractMarkdownSection(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);

  if (startIndex === -1) {
    return "";
  }

  const sectionLines: string[] = [];

  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("## ")) {
      break;
    }

    sectionLines.push(line);
  }

  return sectionLines.join("\n");
}
