import type { GitHubClient, GitHubIssue } from "../github";
import { fetchDoneSet } from "./done-set";
import { formatEarlierIssues, formatLaterIssues } from "./format";
import { PrdPullRequest } from "./prd-pull-request";
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
import type { TemplateRenderer } from "./template-renderer";

// The terminal outcome of one Factory Run against a locked PRD. `skipped` is a
// dispatch concern (no run ever started), so it is not a Factory Run outcome.
export type FactoryRunOutcome = "completed" | "paused" | "issue-error";

// The seams a Factory Run drives. The PRD Lock is deliberately absent: a
// FactoryRun exists only while krutrimbox holds its lock, so locking is a
// dispatch concern above the run, not a dependency of the run itself.
export interface FactoryRunDependencies {
  github: GitHubClient;
  sandbox: SandboxRunner;
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

// One execution attempt by krutrimbox against a single locked PRD. The
// PRD Branch and PRD Sandbox names are derived once and held as invariants;
// `doneSet` and `processedIssues` are intra-run bookkeeping rebuilt fresh every
// run from the branch's Refs footers (ADR-0015), never persisted separately.
// Single-use: call `process()` once.
export class FactoryRun {
  private readonly github: GitHubClient;
  private readonly sandbox: SandboxRunner;
  private readonly templates: TemplateRenderer;
  private readonly logger: Pick<Console, "log">;
  private readonly output?: NodeJS.WritableStream;
  public readonly branchName: string;
  public readonly sandboxName: string;
  private readonly prdPullRequest: PrdPullRequest;
  private readonly doneSet = new Set<number>();
  private readonly processedIssues: ResolvedIssue[] = [];

  public constructor(
    dependencies: FactoryRunDependencies,
    private readonly prd: GitHubIssue
  ) {
    this.github = dependencies.github;
    this.sandbox = dependencies.sandbox;
    this.templates = dependencies.templates;
    this.logger = dependencies.logger;
    this.output = dependencies.output;
    this.branchName = deterministicTargetIssueBranch(prd.number);
    this.sandboxName = deterministicTargetIssueSandbox(prd.number);
    this.prdPullRequest = new PrdPullRequest(
      this.github,
      this.templates,
      this.logger,
      prd,
      this.branchName,
      this.sandboxName
    );
  }

  public async process(): Promise<FactoryRunOutcome> {
    const { prd } = this;
    this.logger.log(`krutrimbox: building Implementation Sequence for PRD #${prd.number}.`);

    const subIssues = await this.github.getAttachedSubIssues(prd.number);
    for (const issueNumber of await fetchDoneSet(this.github, this.branchName)) {
      this.doneSet.add(issueNumber);
    }

    const sequence = buildImplementationSequence(prd.number, subIssues, this.doneSet);

    for (const issue of sequence.resolvedIssues) {
      this.logger.log(`krutrimbox: skipping Resolved Issue #${issue.number}.`);
    }

    if (sequence.openIssues.length === 0) {
      this.logger.log(`krutrimbox: PRD #${prd.number} has no open Implementation Issues.`);

      if (sequence.resolvedIssues.length > 0) {
        await this.routeFinalReview(sequence);
      }

      return "completed";
    }

    const orderedIssues = sequence.openIssues
      .map((issue) => `#${issue.number} (${issue.kind})`)
      .join(", ");
    this.logger.log(`krutrimbox: Implementation Sequence for PRD #${prd.number}: ${orderedIssues}.`);

    for (const issue of sequence.openIssues) {
      if (issue.kind === "hitl") {
        await this.pauseAtHitl(issue);
        this.logger.log(`krutrimbox: paused PRD #${prd.number} at HITL Issue #${issue.number}.`);
        return "paused";
      }

      const priorIssues = [...sequence.resolvedIssues, ...this.processedIssues];
      const laterIssues = sequence.openIssues.filter((candidate) => candidate.number > issue.number);
      const outcome = await this.processAfkIssue(issue, sequence, priorIssues, laterIssues);

      if (outcome === "error") {
        return "issue-error";
      }

      this.doneSet.add(issue.number);
      this.processedIssues.push({
        number: issue.number,
        title: issue.title,
        state: "CLOSED",
        labels: issue.labels
      });
    }

    const allResolvedSequence: ImplementationSequence = {
      openIssues: [],
      resolvedIssues: [...sequence.resolvedIssues, ...this.processedIssues]
    };
    await this.routeFinalReview(allResolvedSequence);

    return "completed";
  }

  private async processAfkIssue(
    issue: ImplementationIssue,
    sequence: ImplementationSequence,
    priorIssues: ResolvedIssue[],
    laterIssues: ImplementationIssue[]
  ): Promise<IssueOutcome> {
    const { prd } = this;

    try {
      const unresolvedBlockers = await this.findUnresolvedBlockers(issue);

      if (unresolvedBlockers.length > 0) {
        const issueUrl = await this.github.getIssueUrl(issue.number);
        const commentUrl = await this.postAfkErrorComment(issue, unresolvedBlockers);
        this.logger.log(
          `krutrimbox: stopped PRD #${prd.number}; AFK Issue #${issue.number} has unresolved blockers. See ${commentUrl} (issue: ${issueUrl}).`
        );
        return "error";
      }

      await this.sandbox.ensureSandbox({ sandboxName: this.sandboxName });
      await this.sandbox.checkoutBranch({ sandboxName: this.sandboxName, branchName: this.branchName });
      await this.sandbox.runAfkIssue({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        prompt: await this.buildAfkPrompt(issue, priorIssues, laterIssues),
        output: this.output
      });
      await this.sandbox.commitAndPush({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        issueNumber: issue.number
      });

      const doneAfterCurrent = new Set(this.doneSet);
      doneAfterCurrent.add(issue.number);
      await this.prdPullRequest.ensureReflectsSequence(sequence, doneAfterCurrent);
      this.logger.log(`krutrimbox: completed AFK Issue #${issue.number}.`);

      return "completed";
    } catch (error) {
      const issueUrl = await this.github.getIssueUrl(issue.number);
      const commentUrl = await this.postAfkErrorComment(issue, [formatError(error)]);
      this.logger.log(
        `krutrimbox: stopped PRD #${prd.number}; AFK Issue #${issue.number} failed. See ${commentUrl} (issue: ${issueUrl}).`
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
    return this.templates.render("prompts/afk-issue.md", {
      prd_branch: this.branchName,
      prd_body: this.prd.body,
      issue_body: issue.body,
      earlier_issues: formatEarlierIssues(priorIssues),
      later_issues: formatLaterIssues(laterIssues)
    });
  }

  private async pauseAtHitl(issue: ImplementationIssue): Promise<void> {
    const body = await this.templates.render("templates/hitlpause-comment.md", {
      prd_number: this.prd.number,
      prd_author: this.prd.author.login,
      issue_number: issue.number,
      issue_title: issue.title,
      prd_branch: this.branchName,
      prd_sandbox: this.sandboxName
    });

    await this.upsertComment(this.prd.number, hitlMarker(this.prd.number, issue.number), body);
  }

  private async postAfkErrorComment(issue: ImplementationIssue, errors: string[]): Promise<string> {
    const body = await this.templates.render("templates/afk-error-comment.md", {
      prd_number: this.prd.number,
      issue_number: issue.number,
      error_summary: errors.join("\n"),
      prd_branch: this.branchName,
      prd_sandbox: this.sandboxName
    });

    const comment = await this.upsertComment(issue.number, afkErrorMarker(issue.number), body);
    return comment.url;
  }

  private async routeFinalReview(sequence: ImplementationSequence): Promise<void> {
    const { prd } = this;
    const pr = await this.prdPullRequest.find();

    if (!pr) {
      this.logger.log(
        `krutrimbox: no PRD Pull Request found for PRD #${prd.number}; skipping final review.`
      );
      return;
    }

    this.logger.log(`krutrimbox: running final review for PRD #${prd.number}.`);

    const diff = await this.prdPullRequest.diff(pr.number);
    const prompt = await this.buildFinalReviewPrompt(sequence, diff);

    await this.sandbox.ensureSandbox({ sandboxName: this.sandboxName });
    const reviewBody = await this.sandbox.runFinalReview({
      sandboxName: this.sandboxName,
      prompt,
      output: this.output
    });

    const commentBody = await this.templates.render("templates/final-review-comment.md", {
      prd_number: prd.number,
      review_body: reviewBody
    });

    await this.upsertComment(pr.number, finalReviewMarker(prd.number), commentBody);
    await this.prdPullRequest.routeForReview(pr.number, prd.author.login);

    await this.sandbox.removeSandbox({ sandboxName: this.sandboxName });
    this.logger.log(`krutrimbox: removed PRD Sandbox ${this.sandboxName}.`);
  }

  private async buildFinalReviewPrompt(
    sequence: ImplementationSequence,
    diff: string
  ): Promise<string> {
    return this.templates.render("prompts/final-review.md", {
      prd_body: this.prd.body,
      implementation_issues: formatEarlierIssues(sequence.resolvedIssues),
      pr_diff: diff
    });
  }

  private async upsertComment(issueNumber: number, marker: string, body: string) {
    const comments = await this.github.listIssueComments(issueNumber);
    const existing = comments.find((comment) => comment.body.includes(marker));

    if (existing) {
      return this.github.updateIssueComment(existing.id, body);
    }

    return this.github.createIssueComment(issueNumber, body);
  }
}

function hitlMarker(prdNumber: number, issueNumber: number): string {
  return `<!-- krutrimbox:hitl-prd-${prdNumber}-issue-${issueNumber} -->`;
}

function afkErrorMarker(issueNumber: number): string {
  return `<!-- krutrimbox:afk-error-issue-${issueNumber} -->`;
}

function finalReviewMarker(prdNumber: number): string {
  return `<!-- krutrimbox:final-review-prd-${prdNumber} -->`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
