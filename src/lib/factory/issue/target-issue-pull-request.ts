import type {
  CreatePullRequestInput,
  GitHubClient,
  GitHubIssue,
  GitHubPullRequest
} from "../../github";
import { KRUTRIMBOX_LABEL } from "../constants";
import { formatClosingKeywords, formatImplementationChecklist } from "./format";
import type { ImplementationSequence } from "./sequence";
import type { TemplateRenderer } from "../templates/template-renderer";

// The single pull request that accumulates a Target Issue's AFK Issue commits,
// identified by its Target Issue Branch. Owns find-or-create, the deterministic
// Target Issue Pull Request Body, and the "exactly the krutrimbox label"
// invariant. Marking the pull request ready and running the Review Pipeline
// against it once the Target Issue finishes stay with the Factory Run (ADR-0021).
export class TargetIssuePullRequest {
  public constructor(
    private readonly github: GitHubClient,
    private readonly templates: TemplateRenderer,
    private readonly targetIssue: GitHubIssue,
    private readonly branchName: string,
    private readonly sandboxName: string,
    // The origin branch this PR targets. Resolved once per run (the `--base-branch`
    // flag or the repository default branch) and shared with the Target Issue
    // Branch cut, so the PR base always matches the branch's actual base.
    private readonly baseBranch: string
  ) {}

  public find(): Promise<GitHubPullRequest | null> {
    return this.github.findPullRequestByHead(this.branchName);
  }

  public async ensureReflectsSequence(
    sequence: ImplementationSequence,
    doneSet: Set<number>
  ): Promise<void> {
    const body = await this.renderBody(sequence, doneSet);
    const existing = await this.github.findPullRequestByHead(this.branchName);

    if (existing) {
      await this.github.updatePullRequestBody(existing.number, body);
      await this.github.setPullRequestLabels(existing.number, [KRUTRIMBOX_LABEL]);
      return;
    }

    const created = await this.github.createDraftPullRequest({
      title: this.targetIssue.title,
      body,
      head: this.branchName,
      base: this.baseBranch,
      labels: [KRUTRIMBOX_LABEL]
    } satisfies CreatePullRequestInput);
    await this.github.setPullRequestLabels(created.number, [KRUTRIMBOX_LABEL]);
  }

  private async renderBody(
    sequence: ImplementationSequence,
    doneSet: Set<number>
  ): Promise<string> {
    return this.templates.renderTemplate("pullRequestBody", {
      target_issue_number: this.targetIssue.number,
      target_issue_branch: this.branchName,
      target_issue_sandbox: this.sandboxName,
      closing_keywords: formatClosingKeywords(this.targetIssue.number, sequence),
      implementation_issue_checklist: formatImplementationChecklist(sequence, doneSet)
    });
  }
}
