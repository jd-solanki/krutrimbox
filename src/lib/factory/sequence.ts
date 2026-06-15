import type { GitHubIssue } from "../github";
import {
  AFK_LABEL,
  HITL_LABEL,
  IMPLEMENTATION_LABEL,
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
  prdNumber: number,
  attachedSubIssues: GitHubIssue[],
  doneSet: Set<number>
): ImplementationSequence {
  const openIssues: ImplementationIssue[] = [];
  const resolvedIssues: ResolvedIssue[] = [];

  for (const issue of attachedSubIssues) {
    const labels = labelNames(issue);

    if (!labels.includes(IMPLEMENTATION_LABEL) || issue.parentNumber !== prdNumber) {
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

export function deterministicTargetIssueSandbox(targetIssueNumber: number): string {
  return `${TARGET_ISSUE_SANDBOX_PREFIX}${targetIssueNumber}`;
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
