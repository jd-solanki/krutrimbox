import type {
  CreatePullRequestInput,
  GitHubClient,
  GitHubIssue,
  GitHubPullRequest
} from "../github";
import { PRD_LABEL } from "./constants";
import { formatImplementationChecklist } from "./format";
import type { ImplementationSequence } from "./sequence";
import type { TemplateRenderer } from "./template-renderer";

// The single pull request that accumulates a PRD's AFK Issue commits, identified
// by its PRD Branch. Owns find-or-create, the deterministic PRD Pull Request
// Body, the "exactly the PRD label" invariant, and Final Reviewer routing
// (ADR-0004). Review generation (a Sandbox concern) and the idempotent review
// comment (a Factory Comment Marker concern) stay with the Factory Run that
// drives it.
export class PrdPullRequest {
  public constructor(
    private readonly github: GitHubClient,
    private readonly templates: TemplateRenderer,
    private readonly logger: Pick<Console, "log">,
    private readonly prd: GitHubIssue,
    private readonly branchName: string,
    private readonly sandboxName: string
  ) {}

  public find(): Promise<GitHubPullRequest | null> {
    return this.github.findPullRequestByHead(this.branchName);
  }

  public diff(pullRequestNumber: number): Promise<string> {
    return this.github.getPullRequestDiff(pullRequestNumber);
  }

  public async ensureReflectsSequence(
    sequence: ImplementationSequence,
    closedIssueNumbers: Set<number>
  ): Promise<void> {
    const body = await this.renderBody(sequence, closedIssueNumbers);
    const existing = await this.github.findPullRequestByHead(this.branchName);

    if (existing) {
      await this.github.updatePullRequestBody(existing.number, body);
      await this.github.setPullRequestLabels(existing.number, [PRD_LABEL]);
      return;
    }

    const created = await this.github.createDraftPullRequest({
      title: `Code Factory PRD #${this.prd.number}: ${this.prd.title}`,
      body,
      head: this.branchName,
      base: await this.github.getDefaultBranch(),
      labels: [PRD_LABEL]
    } satisfies CreatePullRequestInput);
    await this.github.setPullRequestLabels(created.number, [PRD_LABEL]);
  }

  public async routeForReview(pullRequestNumber: number, prdAuthor: string): Promise<void> {
    await this.github.markPullRequestReadyForReview(pullRequestNumber);
    this.logger.log(
      `Code Factory: marked PRD Pull Request #${pullRequestNumber} ready for review.`
    );

    const prAuthor = await this.github.getAuthenticatedUser();

    if (prdAuthor !== prAuthor) {
      await this.github.requestPullRequestReview(pullRequestNumber, prdAuthor);
      this.logger.log(
        `Code Factory: requested review from ${prdAuthor} for PRD Pull Request #${pullRequestNumber}.`
      );
      return;
    }

    const tagBody = `@${prdAuthor} the Code Factory has completed all Implementation Issues for PRD #${this.prd.number}. Please review the PR.`;
    await this.github.createIssueComment(pullRequestNumber, tagBody);
    this.logger.log(
      `Code Factory: tagged ${prdAuthor} in PRD Pull Request #${pullRequestNumber} (self-review).`
    );
  }

  private async renderBody(
    sequence: ImplementationSequence,
    closedIssueNumbers: Set<number>
  ): Promise<string> {
    return this.templates.render("templates/pr-body.md", {
      prd_number: this.prd.number,
      prd_branch: this.branchName,
      prd_sandbox: this.sandboxName,
      implementation_issue_checklist: formatImplementationChecklist(sequence, closedIssueNumbers)
    });
  }
}
