// Who, if anyone, krutrimbox treats as the rightful implementer of an issue.
// krutrimbox routes work by GitHub assignee rather than by author: an issue is
// the Operator's to implement only when it is assigned to exactly the Operator
// (see ADR-0017, ADR-0018). This module is the single home for that rule so the
// same judgement drives both discovery and the Implementation Sequence walk.

// The Operator's relationship to one issue, derived purely from its assignees:
// - "owned"               assigned to exactly the Operator and nobody else.
// - "assigned-to-others"  assigned to exactly one person who is not the Operator.
// - "multiple-assignees"  assigned to more than one person, so no single owner
//                         can be inferred (ambiguous even if the Operator is one).
// - "unassigned"          assigned to nobody.
export type IssueOwnership =
  | "owned"
  | "assigned-to-others"
  | "multiple-assignees"
  | "unassigned";

// The minimal slice of an issue this rule depends on: only its assignees.
interface AssignedIssue {
  assignees: ReadonlyArray<{ login: string }>;
}

// Classifies an issue's ownership for `operator` (the authenticated GitHub user's
// login). Pure: it reads only the issue's assignees and never the author.
export function classifyOwnership(issue: AssignedIssue, operator: string): IssueOwnership {
  if (issue.assignees.length === 0) {
    return "unassigned";
  }

  if (issue.assignees.length > 1) {
    return "multiple-assignees";
  }

  return issue.assignees[0].login === operator ? "owned" : "assigned-to-others";
}

// Whether krutrimbox may implement an issue with the given ownership. An Owned
// Issue always qualifies; an unassigned issue qualifies only under the
// Implement-Unassigned Override (the `--implement-unassigned` solo-developer
// flag). Work owned by others or ambiguously assigned never qualifies.
export function isImplementable(
  ownership: IssueOwnership,
  options: { allowUnassigned: boolean }
): boolean {
  if (ownership === "owned") {
    return true;
  }

  return ownership === "unassigned" && options.allowUnassigned;
}
