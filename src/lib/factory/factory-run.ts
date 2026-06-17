import type { GitHubClient, GitHubIssue } from "../github";
import type { CodingAgent } from "./coding-agent";
import { fetchDoneSet } from "./done-set";
import { formatEarlierIssues, formatLaterIssues } from "./format";
import { TargetIssuePullRequest } from "./target-issue-pull-request";
import type { SandboxRunner } from "./sandbox-runner";
import {
  buildImplementationSequence,
  deterministicTargetIssueBranch,
  deterministicTargetIssueSandbox,
  parseBlockingIssueNumbers,
  type ImplementationIssue,
  type ImplementationSequence,
  type ResolvedIssue
} from "./sequence";
import { classifyOwnership, isImplementable, type IssueOwnership } from "./ownership";
import type { TemplateRenderer } from "./template-renderer";

// The terminal outcome of one Factory Run against a locked Target Issue. `skipped` is a
// dispatch concern (no run ever started), so it is not a Factory Run outcome.
export type FactoryRunOutcome = "completed" | "paused" | "issue-error";

// The seams a Factory Run drives. The Target Issue Lock is deliberately absent: a
// FactoryRun exists only while krutrimbox holds its lock, so locking is a
// dispatch concern above the run, not a dependency of the run itself.
export interface FactoryRunDependencies {
  github: GitHubClient;
  sandbox: SandboxRunner;
  // The Agent Backend chosen for this run. It scopes the Target Issue Sandbox
  // name; the SandboxRunner is already wired to the same agent.
  agent: CodingAgent;
  // The current repository's `owner/name`, resolved once at dispatch. Scopes the
  // Target Issue Sandbox name to this repository (ADR-0007).
  repositorySlug: string;
  // The origin branch the Target Issue Branch is cut from and the base the Target
  // Issue Pull Request targets. Resolved once at dispatch (the `--base-branch`
  // flag, or the repository default branch). The same value drives the branch cut
  // and the PR base so the two never disagree.
  baseBranch: string;
  // The Operator: the authenticated GitHub user this run implements work for.
  // krutrimbox implements a Due Issue only when it is assigned to exactly the
  // Operator (ADR-0018, ADR-0019).
  operator: string;
  // The Implement-Unassigned Override (`--implement-unassigned`): when true a
  // zero-assignee Due Issue counts as the Operator's. A solo-developer escape
  // hatch that disables the single-assignee collision guard.
  allowUnassigned: boolean;
  templates: TemplateRenderer;
  logger: Pick<Console, "log">;
  // Where the sandbox/agent output stream is sent for this run. Omitted in tests
  // and when no per-run log file is in use.
  output?: NodeJS.WritableStream;
}

// Per-Implementation-Issue outcome used to drive the sequence walk. Distinct
// from FactoryRunOutcome: an Implementation Issue completes or errors; the run
// as a whole completes, pauses, or stops on an issue error.
type IssueOutcome = "completed" | "error";

// One execution attempt by krutrimbox against a single locked Target Issue. The
// Target Issue Branch and Target Issue Sandbox names are derived once and held as invariants;
// `doneSet` and `processedIssues` are intra-run bookkeeping rebuilt fresh every
// run from the branch's Refs footers (ADR-0015), never persisted separately.
// Single-use: call `process()` once.
export class FactoryRun {
  private readonly github: GitHubClient;
  private readonly sandbox: SandboxRunner;
  private readonly templates: TemplateRenderer;
  private readonly logger: Pick<Console, "log">;
  private readonly output?: NodeJS.WritableStream;
  // The run's Agent Backend name, surfaced in rerun commands so a resumed run
  // re-selects the same agent (`--agent` is required and has no default).
  private readonly agentName: string;
  private readonly baseBranch: string;
  private readonly operator: string;
  private readonly allowUnassigned: boolean;
  public readonly branchName: string;
  public readonly sandboxName: string;
  private readonly targetIssuePullRequest: TargetIssuePullRequest;
  private readonly doneSet = new Set<number>();
  private readonly processedIssues: ResolvedIssue[] = [];

  public constructor(
    dependencies: FactoryRunDependencies,
    private readonly targetIssue: GitHubIssue
  ) {
    this.github = dependencies.github;
    this.sandbox = dependencies.sandbox;
    this.templates = dependencies.templates;
    this.logger = dependencies.logger;
    this.output = dependencies.output;
    this.agentName = dependencies.agent.name;
    this.baseBranch = dependencies.baseBranch;
    this.operator = dependencies.operator;
    this.allowUnassigned = dependencies.allowUnassigned;
    this.branchName = deterministicTargetIssueBranch(targetIssue.number);
    this.sandboxName = deterministicTargetIssueSandbox(
      targetIssue.number,
      dependencies.repositorySlug,
      dependencies.agent.name
    );
    this.targetIssuePullRequest = new TargetIssuePullRequest(
      this.github,
      this.templates,
      this.logger,
      targetIssue,
      this.branchName,
      this.sandboxName,
      this.baseBranch
    );
  }

  public async process(): Promise<FactoryRunOutcome> {
    const sequence = await this.buildSequence();

    this.logResolvedIssues(sequence.resolvedIssues);

    if (hasNoOpenIssues(sequence)) {
      return this.completeRunWithNoOpenIssues(sequence);
    }

    this.logOpenImplementationSequence(sequence.openIssues);
    return this.processOpenIssues(sequence);
  }

  private async buildSequence(): Promise<ImplementationSequence> {
    this.logger.log(
      `krutrimbox: building Implementation Sequence for Target Issue #${this.targetIssue.number}.`
    );

    const subIssues = await this.github.getAttachedSubIssues(this.targetIssue.number);
    const doneIssueNumbers = await fetchDoneSet(this.github, this.branchName);

    for (const issueNumber of doneIssueNumbers) {
      this.doneSet.add(issueNumber);
    }

    return buildImplementationSequence(this.targetIssue, subIssues, this.doneSet);
  }

  private logResolvedIssues(issues: ResolvedIssue[]): void {
    for (const issue of issues) {
      this.logger.log(`krutrimbox: skipping Resolved Issue #${issue.number}.`);
    }
  }

  private async completeRunWithNoOpenIssues(
    sequence: ImplementationSequence
  ): Promise<FactoryRunOutcome> {
    this.logger.log(
      `krutrimbox: Target Issue #${this.targetIssue.number} has no open Implementation Issues.`
    );

    if (sequence.resolvedIssues.length > 0) {
      await this.routeFinalReview(sequence);
    }

    return "completed";
  }

  private logOpenImplementationSequence(issues: ImplementationIssue[]): void {
    const orderedIssues = issues.map((issue) => `#${issue.number} (${issue.kind})`).join(", ");
    this.logger.log(
      `krutrimbox: Implementation Sequence for Target Issue #${this.targetIssue.number}: ${orderedIssues}.`
    );
  }

  private async processOpenIssues(sequence: ImplementationSequence): Promise<FactoryRunOutcome> {
    for (const issue of sequence.openIssues) {
      if (issue.kind === "hitl") {
        await this.pauseAtHitl(issue);
        this.logger.log(
          `krutrimbox: paused Target Issue #${this.targetIssue.number} at HITL Issue #${issue.number}.`
        );
        return "paused";
      }

      if (!this.isOperatorsToImplement(issue)) {
        return this.haltAtUnownedDueIssue(issue);
      }

      const priorIssues = [...sequence.resolvedIssues, ...this.processedIssues];
      const laterIssues = sequence.openIssues.filter((candidate) => candidate.number > issue.number);
      const outcome = await this.processAfkIssue(issue, sequence, priorIssues, laterIssues);

      if (outcome === "error") {
        return "issue-error";
      }

      this.recordCompletedIssue(issue);
    }

    const allResolvedSequence: ImplementationSequence = {
      openIssues: [],
      resolvedIssues: [...sequence.resolvedIssues, ...this.processedIssues]
    };
    await this.routeFinalReview(allResolvedSequence);

    return "completed";
  }

  // Whether the Due Issue is the Operator's to implement: assigned to exactly the
  // Operator, or unassigned under the Implement-Unassigned Override (ADR-0018).
  private isOperatorsToImplement(issue: ImplementationIssue): boolean {
    return isImplementable(classifyOwnership(issue, this.operator), {
      allowUnassigned: this.allowUnassigned
    });
  }

  // Stops the walk at a Due Issue the Operator may not implement. It is an error
  // when nothing has been implemented this run — the Operator entered a Target
  // Issue with nothing for them to do — and a handoff pause once the Operator has
  // already delivered earlier Implementation Issues this run (ADR-0019).
  private haltAtUnownedDueIssue(issue: ImplementationIssue): FactoryRunOutcome {
    const reason = describeUnownedDueIssue(issue, classifyOwnership(issue, this.operator));

    if (this.processedIssues.length === 0) {
      this.logger.log(`krutrimbox: stopped Target Issue #${this.targetIssue.number}; ${reason}`);
      return "issue-error";
    }

    this.logger.log(
      `krutrimbox: paused Target Issue #${this.targetIssue.number}; ${reason} Handing off to its assignee.`
    );
    return "paused";
  }

  private recordCompletedIssue(issue: ImplementationIssue): void {
    this.doneSet.add(issue.number);
    this.processedIssues.push({
      number: issue.number,
      title: issue.title,
      state: "CLOSED",
      labels: issue.labels
    });
  }

  private async processAfkIssue(
    issue: ImplementationIssue,
    sequence: ImplementationSequence,
    priorIssues: ResolvedIssue[],
    laterIssues: ImplementationIssue[]
  ): Promise<IssueOutcome> {
    const { targetIssue } = this;

    try {
      const unresolvedBlockers = await this.findUnresolvedBlockers(issue);

      if (unresolvedBlockers.length > 0) {
        const issueUrl = await this.github.getIssueUrl(issue.number);
        const commentUrl = await this.postAfkErrorComment(issue, unresolvedBlockers);
        this.logger.log(
          `krutrimbox: stopped Target Issue #${targetIssue.number}; AFK Issue #${issue.number} has unresolved blockers. See ${commentUrl} (issue: ${issueUrl}).`
        );
        return "error";
      }

      await this.sandbox.ensureSandbox({ sandboxName: this.sandboxName });
      await this.sandbox.checkoutBranch({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        baseBranch: this.baseBranch
      });
      await this.sandbox.runAfkIssue({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        prompt: await this.buildAfkPrompt(issue, priorIssues, laterIssues),
        output: this.output
      });
      await this.sandbox.commitAndPush({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        subject: issue.title,
        issueNumber: issue.number
      });

      const doneAfterCurrent = new Set(this.doneSet);
      doneAfterCurrent.add(issue.number);
      await this.targetIssuePullRequest.ensureReflectsSequence(sequence, doneAfterCurrent);
      this.logger.log(`krutrimbox: completed AFK Issue #${issue.number}.`);

      return "completed";
    } catch (error) {
      const issueUrl = await this.github.getIssueUrl(issue.number);
      const commentUrl = await this.postAfkErrorComment(issue, [formatError(error)]);
      this.logger.log(
        `krutrimbox: stopped Target Issue #${targetIssue.number}; AFK Issue #${issue.number} failed. See ${commentUrl} (issue: ${issueUrl}).`
      );
      return "error";
    }
  }

  private async findUnresolvedBlockers(issue: ImplementationIssue): Promise<string[]> {
    const blockerNumbers = parseBlockingIssueNumbers(issue.body);
    const unresolved: string[] = [];

    for (const blockerNumber of blockerNumbers) {
      if (this.doneSet.has(blockerNumber)) {
        continue;
      }

      const blocker = await this.github.getIssue(blockerNumber);

      if (blocker.state !== "CLOSED") {
        unresolved.push(`#${blocker.number} - ${blocker.title} (${blocker.state})`);
      }
    }

    return unresolved;
  }

  private async buildAfkPrompt(
    issue: ImplementationIssue,
    priorIssues: ResolvedIssue[],
    laterIssues: ImplementationIssue[]
  ): Promise<string> {
    return this.templates.renderPrompt("afkIssue", {
      target_issue_branch: this.branchName,
      target_issue_body: this.targetIssue.body,
      issue_body: issue.body,
      earlier_issues: formatEarlierIssues(priorIssues),
      later_issues: formatLaterIssues(laterIssues)
    });
  }

  private async pauseAtHitl(issue: ImplementationIssue): Promise<void> {
    const body = await this.templates.renderTemplate("hitlPauseComment", {
      target_issue_number: this.targetIssue.number,
      target_issue_author: this.targetIssue.author.login,
      issue_number: issue.number,
      issue_title: issue.title,
      target_issue_branch: this.branchName,
      target_issue_sandbox: this.sandboxName,
      agent_name: this.agentName
    });

    await this.upsertComment(this.targetIssue.number, hitlMarker(this.targetIssue.number, issue.number), body);
  }

  private async postAfkErrorComment(issue: ImplementationIssue, errors: string[]): Promise<string> {
    const body = await this.templates.renderTemplate("afkErrorComment", {
      target_issue_number: this.targetIssue.number,
      issue_number: issue.number,
      error_summary: errors.join("\n"),
      target_issue_branch: this.branchName,
      target_issue_sandbox: this.sandboxName,
      agent_name: this.agentName
    });

    const comment = await this.upsertComment(issue.number, afkErrorMarker(issue.number), body);
    return comment.url;
  }

  private async routeFinalReview(sequence: ImplementationSequence): Promise<void> {
    const { targetIssue } = this;
    const pr = await this.targetIssuePullRequest.find();

    if (!pr) {
      this.logger.log(
        `krutrimbox: no Target Issue Pull Request found for Target Issue #${targetIssue.number}; skipping final review.`
      );
      return;
    }

    if (!pr.isDraft) {
      this.logger.log(
        `krutrimbox: Target Issue Pull Request #${pr.number} for Target Issue #${targetIssue.number} is already ready for review; skipping final review.`
      );
      return;
    }

    this.logger.log(`krutrimbox: running final review for Target Issue #${targetIssue.number}.`);

    const diff = await this.targetIssuePullRequest.diff(pr.number);
    const prompt = await this.buildFinalReviewPrompt(sequence, diff);

    await this.sandbox.ensureSandbox({ sandboxName: this.sandboxName });
    const reviewBody = await this.sandbox.runFinalReview({
      sandboxName: this.sandboxName,
      prompt,
      output: this.output
    });

    const commentBody = await this.templates.renderTemplate("finalReviewComment", {
      target_issue_number: targetIssue.number,
      review_body: reviewBody
    });

    await this.upsertComment(pr.number, finalReviewMarker(targetIssue.number), commentBody);
    await this.targetIssuePullRequest.routeForReview(pr.number, targetIssue.author.login);

    await this.sandbox.removeSandbox({ sandboxName: this.sandboxName });
    this.logger.log(`krutrimbox: removed Target Issue Sandbox ${this.sandboxName}.`);
  }

  private async buildFinalReviewPrompt(
    sequence: ImplementationSequence,
    diff: string
  ): Promise<string> {
    return this.templates.renderPrompt("finalReview", {
      target_issue_body: this.targetIssue.body,
      implementation_issues: formatEarlierIssues(sequence.resolvedIssues),
      pr_diff: diff
    });
  }

  // krutrimbox owns the Factory Comment Marker, not the template author: the
  // marker is injected here, outside the (possibly project-overridden) template
  // body, so a custom comment template can never break idempotent comment
  // updates. The same marker locates the existing comment and prefixes the body.
  private async upsertComment(issueNumber: number, marker: string, body: string) {
    const markedBody = `${marker}\n\n${body}`;
    const comments = await this.github.listIssueComments(issueNumber);
    const existing = comments.find((comment) => comment.body.includes(marker));

    if (existing) {
      return this.github.updateIssueComment(existing.id, markedBody);
    }

    return this.github.createIssueComment(issueNumber, markedBody);
  }
}

function hitlMarker(targetIssueNumber: number, issueNumber: number): string {
  return `<!-- krutrimbox:hitl-issue-${targetIssueNumber}-implementation-${issueNumber} -->`;
}

function afkErrorMarker(issueNumber: number): string {
  return `<!-- krutrimbox:afk-error-issue-${issueNumber} -->`;
}

function finalReviewMarker(targetIssueNumber: number): string {
  return `<!-- krutrimbox:final-review-issue-${targetIssueNumber} -->`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A run-log reason explaining why a Due Issue is not the Operator's to implement,
// shared by the error (immediate) and handoff (pause) halt cases (ADR-0019).
function describeUnownedDueIssue(issue: ImplementationIssue, ownership: IssueOwnership): string {
  switch (ownership) {
    case "assigned-to-others":
      return `Due Issue #${issue.number} is assigned to ${formatAssignees(issue)}, not you.`;
    case "multiple-assignees":
      return `Due Issue #${issue.number} has multiple assignees (${formatAssignees(issue)}); krutrimbox can't decide who implements it.`;
    case "unassigned":
      return `Due Issue #${issue.number} is not assigned to you; pass --implement-unassigned to run unowned issues.`;
    case "owned":
      return `Due Issue #${issue.number} is yours.`;
  }
}

function formatAssignees(issue: ImplementationIssue): string {
  return issue.assignees.map((assignee) => `@${assignee.login}`).join(", ");
}

function hasNoOpenIssues(sequence: ImplementationSequence): boolean {
  return sequence.openIssues.length === 0;
}
