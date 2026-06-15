import {
  parseBlockingIssueNumbers,
  type ImplementationIssue,
  type ImplementationSequence,
  type ResolvedIssue
} from "./sequence";

export function formatImplementationChecklist(
  sequence: ImplementationSequence,
  doneSet: Set<number>
): string {
  const issues = [...sequence.resolvedIssues, ...sequence.openIssues].sort(
    (left, right) => left.number - right.number
  );

  if (issues.length === 0) {
    return "- No Implementation Issues found.";
  }

  return issues
    .map((issue) => `- [${doneSet.has(issue.number) ? "x" : " "}] #${issue.number} - ${issue.title}`)
    .join("\n");
}

export function formatClosingKeywords(
  targetIssueNumber: number,
  sequence: ImplementationSequence
): string {
  const issueNumbers = [
    targetIssueNumber,
    ...[...sequence.resolvedIssues, ...sequence.openIssues].map((issue) => issue.number)
  ];
  const uniqueIssueNumbers = [...new Set(issueNumbers)].sort((left, right) => left - right);

  return uniqueIssueNumbers.map((issueNumber) => `Closes #${issueNumber}`).join("\n");
}

export function formatEarlierIssues(issues: ResolvedIssue[]): string {
  if (issues.length === 0) {
    return "None.";
  }

  return issues.map((issue) => `- #${issue.number} - ${issue.title} (${issue.state})`).join("\n");
}

export function formatLaterIssues(issues: ImplementationIssue[]): string {
  if (issues.length === 0) {
    return "None.";
  }

  return issues
    .map((issue) => {
      const blockers = parseBlockingIssueNumbers(issue.body);
      const blockerText = blockers.length > 0 ? `, blocked by ${blockers.map((number) => `#${number}`).join(", ")}` : "";
      return `- #${issue.number} - ${issue.title} (${issue.kind}${blockerText})`;
    })
    .join("\n");
}
