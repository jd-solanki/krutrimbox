import { createHash } from "node:crypto";
import type { GitHubIssue } from "../github";
import { diagnostics } from "../diagnostics";
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
  // The issue's GitHub assignees, carried through so the Implementation Sequence
  // walk can decide whether this issue is the Operator's to implement (ADR-0018).
  assignees: Array<{ login: string }>;
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
      throw diagnostics.KB_R0006({
        number: issue.number,
        afkLabel: AFK_LABEL,
        hitlLabel: HITL_LABEL
      });
    }

    openIssues.push({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: "OPEN",
      kind: stateLabels[0] === AFK_LABEL ? "afk" : "hitl",
      labels,
      assignees: issue.assignees
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

// Docker maps the Target Issue Sandbox name to a container hostname, whose RFC
// 1035 label cap is 63 characters; `sbx create` rejects anything longer outright,
// so the name must fit within this budget.
const MAX_SANDBOX_NAME_LENGTH = 63;

// The Target Issue Sandbox name is keyed on (Repository, Target Issue, Agent
// Backend) so a run with one agent never reuses a sandbox built for another
// agent's CLI and template image, and so two repositories that share an issue
// number never collide in `sbx`'s host-global namespace (ADR-0007). The Target
// Issue Branch stays repo- and agent-blind, since branches live inside each
// repository's own git, so the Done Set and HITL resume are unaffected.
//
// The issue number, repository fingerprint, and agent all carry identity or
// uniqueness and are never trimmed. Only the readable repository slug — which
// exists purely for `sbx ls` legibility — is clamped to whatever budget remains
// after the fixed parts, so a long repository slug can never push the name past
// the hostname limit. The fingerprint still distinguishes two repositories whose
// readable slugs clamp to the same leading text.
export function deterministicTargetIssueSandbox(
  targetIssueNumber: number,
  repositorySlug: string,
  agentName: AgentName
): string {
  const { readableSlug, fingerprint } = repositorySlugParts(repositorySlug);
  const head = `${deterministicTargetIssueSlug(targetIssueNumber)}-`;
  const suffix = `-${fingerprint}-${agentName}`;
  const slugBudget = Math.max(0, MAX_SANDBOX_NAME_LENGTH - head.length - suffix.length);
  const clampedSlug = readableSlug.slice(0, slugBudget).replace(/-+$/, "");

  return `${head}${clampedSlug}${suffix}`;
}

// Splits a GitHub `owner/name` into the two pieces the sandbox name needs. The
// readable slug is the lowercased identity with every run of non-alphanumeric
// characters (the `/` separator, dots, underscores) collapsed to a single hyphen
// and edge hyphens trimmed, so `sbx ls` stays scannable. The fingerprint is the
// first 8 hex digits of the SHA-256 of that same lowercased identity, which keeps
// the name unique even when two distinct repositories slugify to the same readable
// text (e.g. `acme/foo.bar` and `acme/foo-bar`) — and crucially still does so after
// the readable slug is clamped to fit the hostname limit. Lowercasing before both
// steps means case-only spellings of one repository — which GitHub does not allow
// to coexist — never produce two different sandboxes.
function repositorySlugParts(repositorySlug: string): { readableSlug: string; fingerprint: string } {
  const canonicalSlug = repositorySlug.toLowerCase();
  const readableSlug = canonicalSlug.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const fingerprint = createHash("sha256").update(canonicalSlug).digest("hex").slice(0, 8);

  return { readableSlug, fingerprint };
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
