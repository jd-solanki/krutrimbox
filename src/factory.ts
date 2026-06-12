import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  ExecFileCommandRunner,
  GitHubCliClient,
  type CommandRunner,
  type CreatePullRequestInput,
  type GitHubClient,
  type GitHubIssue
} from "./github.js";

export const FACTORY_OWNER = "jd-solanki";
export const IMPLEMENTATION_LABEL = "PRD-sub-issue";
export const AFK_LABEL = "ready-for-agent";
export const HITL_LABEL = "ready-for-human";
export const PRD_LABEL = "PRD";
export const PRD_BRANCH_PREFIX = "code-factory/prd-";
export const PRD_SANDBOX_PREFIX = "code-factory-prd-";
export const DEFAULT_SANDBOX_TEMPLATE = "docker.io/library/code-factory-codex:pnpm";
export const SANDBOX_CODEX_EXEC_FLAGS = [
  "--ephemeral",
  "--dangerously-bypass-approvals-and-sandbox"
] as const;

export interface CodeFactoryRunner {
  runExplicit(prdNumber: number): Promise<void>;
  runBatch(): Promise<void>;
}

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

export interface SandboxRunner {
  ensureSandbox(input: SandboxInput): Promise<void>;
  checkoutBranch(input: SandboxBranchInput): Promise<void>;
  runAfkIssue(input: SandboxAfkInput): Promise<void>;
  commitAndPush(input: SandboxCommitInput): Promise<void>;
  runFinalReview(input: SandboxFinalReviewInput): Promise<string>;
  removeSandbox(input: SandboxInput): Promise<void>;
}

export interface PrdLock {
  release(): Promise<void>;
}

export interface PrdLockStore {
  acquire(prdNumber: number): Promise<PrdLock | null>;
}

export interface TemplateRenderer {
  render(templatePath: string, values: Record<string, string | number>): Promise<string>;
}

export interface CodeFactoryDependencies {
  github?: GitHubClient;
  sandbox?: SandboxRunner;
  lockStore?: PrdLockStore;
  templates?: TemplateRenderer;
  logger?: Pick<Console, "log">;
  cwd?: string;
  sandboxTemplate?: string;
}

interface SandboxInput {
  sandboxName: string;
}

interface SandboxBranchInput extends SandboxInput {
  branchName: string;
}

interface SandboxAfkInput extends SandboxBranchInput {
  prompt: string;
}

interface SandboxCommitInput extends SandboxBranchInput {
  issueNumber: number;
}

interface SandboxFinalReviewInput extends SandboxInput {
  prompt: string;
}

// The terminal outcome of one Factory Run against a locked PRD. `skipped` is a
// dispatch concern (no run ever started), so it is not a Factory Run outcome.
export type FactoryRunOutcome = "completed" | "paused" | "issue-error";

// Per-Implementation-Issue outcome used to drive the sequence walk. Distinct
// from FactoryRunOutcome: an Implementation Issue completes or errors; the run
// as a whole completes, pauses, or stops on an issue error.
type IssueOutcome = "completed" | "error";

// What dispatching one PRD produces: a Factory Run outcome, or `skipped` when
// the PRD is not open or is already locked and no run took place.
type DispatchOutcome = FactoryRunOutcome | "skipped";

// The seams a Factory Run drives. The PRD Lock is deliberately absent: a
// FactoryRun exists only while the Code Factory holds its lock, so locking is a
// dispatch concern above the run, not a dependency of the run itself.
export interface FactoryRunDependencies {
  github: GitHubClient;
  sandbox: SandboxRunner;
  templates: TemplateRenderer;
  logger: Pick<Console, "log">;
}

export function createCodeFactory(
  githubOrDependencies: GitHubClient | CodeFactoryDependencies = {}
): CodeFactoryRunner {
  const dependencies = isGitHubClient(githubOrDependencies)
    ? { github: githubOrDependencies }
    : githubOrDependencies;
  const cwd = path.resolve(dependencies.cwd ?? process.cwd());
  const commandRunner = new ExecFileCommandRunner();
  const github = dependencies.github ?? new GitHubCliClient();
  const sandbox =
    dependencies.sandbox
    ?? new CommandSandboxRunner(
      commandRunner,
      cwd,
      dependencies.sandboxTemplate ?? process.env.CODE_FACTORY_SANDBOX_TEMPLATE ?? DEFAULT_SANDBOX_TEMPLATE
    );
  const lockStore = dependencies.lockStore ?? new FilePrdLockStore(cwd);
  const templates = dependencies.templates ?? new FileTemplateRenderer(cwd);
  const logger = dependencies.logger ?? console;
  const runDependencies: FactoryRunDependencies = { github, sandbox, templates, logger };

  // The dispatch seam: discovery hands a PRD here, and dispatch guards it (open
  // state + PRD Lock) before a Factory Run ever exists. Holding the lock across
  // `process()` keeps the run's invariant intact: a FactoryRun ⇒ we own its
  // PRD Branch and PRD Sandbox.
  async function dispatch(prd: GitHubIssue): Promise<DispatchOutcome> {
    if (prd.state !== "OPEN") {
      logger.log(`Code Factory: skipping PRD #${prd.number}; PRD is ${prd.state}.`);
      return "skipped";
    }

    const lock = await lockStore.acquire(prd.number);

    if (!lock) {
      logger.log(`Code Factory: skipping PRD #${prd.number}; PRD is already locked.`);
      return "skipped";
    }

    try {
      return await new FactoryRun(runDependencies, prd).process();
    } finally {
      await lock.release();
    }
  }

  return {
    async runExplicit(prdNumber: number): Promise<void> {
      await github.ensureRequiredLabels();

      const prd = await github.getIssue(prdNumber);

      if (!isFactoryOwnedPrd(prd)) {
        logger.log(
          `Code Factory: skipping PRD #${prd.number}; author ${prd.author.login} is not ${FACTORY_OWNER}.`
        );
        return;
      }

      logger.log(`Code Factory: starting Explicit Run for PRD #${prd.number}.`);
      logger.log(`Code Factory: processing only Factory-Owned PRDs by ${FACTORY_OWNER}.`);
      await dispatch(prd);
    },

    async runBatch(): Promise<void> {
      logger.log("Code Factory: starting Batch Run for ready PRDs.");
      await github.ensureRequiredLabels();
      logger.log(`Code Factory: discovering Factory-Owned PRDs by ${FACTORY_OWNER}.`);

      const prds = await github.listReadyPrds(FACTORY_OWNER);
      const outcomes: DispatchOutcome[] = [];

      for (const prd of prds) {
        outcomes.push(await dispatch(prd));
      }

      logBatchSummary(logger, outcomes);
    }
  };
}

export function buildImplementationSequence(
  prdNumber: number,
  attachedSubIssues: GitHubIssue[]
): ImplementationSequence {
  const openIssues: ImplementationIssue[] = [];
  const resolvedIssues: ResolvedIssue[] = [];

  for (const issue of attachedSubIssues) {
    const labels = labelNames(issue);

    if (!labels.includes(IMPLEMENTATION_LABEL) || issue.parentNumber !== prdNumber) {
      continue;
    }

    if (issue.state === "CLOSED") {
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

export function deterministicPrdBranch(prdNumber: number): string {
  return `${PRD_BRANCH_PREFIX}${prdNumber}`;
}

export function deterministicPrdSandbox(prdNumber: number): string {
  return `${PRD_SANDBOX_PREFIX}${prdNumber}`;
}

export function parseBlockingIssueNumbers(body: string): number[] {
  const section = extractMarkdownSection(body, "Blocked by");
  const numbers = new Set<number>();

  for (const match of section.matchAll(/#(\d+)\b/g)) {
    numbers.add(Number(match[1]));
  }

  return [...numbers].sort((left, right) => left - right);
}

// One execution attempt by the Code Factory against a single locked PRD. The
// PRD Branch and PRD Sandbox names are derived once and held as invariants;
// `closedIssueNumbers` and `processedIssues` are intra-run bookkeeping rebuilt
// fresh every run (ADR-0002), never persisted. Single-use: call `process()`
// once.
export class FactoryRun {
  private readonly github: GitHubClient;
  private readonly sandbox: SandboxRunner;
  private readonly templates: TemplateRenderer;
  private readonly logger: Pick<Console, "log">;
  public readonly branchName: string;
  public readonly sandboxName: string;
  private readonly closedIssueNumbers = new Set<number>();
  private readonly processedIssues: ResolvedIssue[] = [];

  public constructor(
    dependencies: FactoryRunDependencies,
    private readonly prd: GitHubIssue
  ) {
    this.github = dependencies.github;
    this.sandbox = dependencies.sandbox;
    this.templates = dependencies.templates;
    this.logger = dependencies.logger;
    this.branchName = deterministicPrdBranch(prd.number);
    this.sandboxName = deterministicPrdSandbox(prd.number);
  }

  public async process(): Promise<FactoryRunOutcome> {
    const { prd } = this;
    this.logger.log(`Code Factory: building Implementation Sequence for PRD #${prd.number}.`);

    const subIssues = await this.github.getAttachedSubIssues(prd.number);
    const sequence = buildImplementationSequence(prd.number, subIssues);

    for (const issue of sequence.resolvedIssues) {
      this.closedIssueNumbers.add(issue.number);
      this.logger.log(`Code Factory: skipping Resolved Issue #${issue.number}.`);
    }

    if (sequence.openIssues.length === 0) {
      this.logger.log(`Code Factory: PRD #${prd.number} has no open Implementation Issues.`);

      if (sequence.resolvedIssues.length > 0) {
        await this.routeFinalReview(sequence);
      }

      return "completed";
    }

    const orderedIssues = sequence.openIssues
      .map((issue) => `#${issue.number} (${issue.kind})`)
      .join(", ");
    this.logger.log(`Code Factory: Implementation Sequence for PRD #${prd.number}: ${orderedIssues}.`);

    for (const issue of sequence.openIssues) {
      if (issue.kind === "hitl") {
        await this.pauseAtHitl(issue);
        this.logger.log(`Code Factory: paused PRD #${prd.number} at HITL Issue #${issue.number}.`);
        return "paused";
      }

      const priorIssues = [...sequence.resolvedIssues, ...this.processedIssues];
      const laterIssues = sequence.openIssues.filter((candidate) => candidate.number > issue.number);
      const outcome = await this.processAfkIssue(issue, sequence, priorIssues, laterIssues);

      if (outcome === "error") {
        return "issue-error";
      }

      this.closedIssueNumbers.add(issue.number);
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
        await this.postAfkErrorComment(issue, unresolvedBlockers);
        this.logger.log(
          `Code Factory: stopped PRD #${prd.number}; AFK Issue #${issue.number} has unresolved blockers.`
        );
        return "error";
      }

      await this.sandbox.ensureSandbox({ sandboxName: this.sandboxName });
      await this.sandbox.checkoutBranch({ sandboxName: this.sandboxName, branchName: this.branchName });
      await this.sandbox.runAfkIssue({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        prompt: await this.buildAfkPrompt(issue, priorIssues, laterIssues)
      });
      await this.sandbox.commitAndPush({
        sandboxName: this.sandboxName,
        branchName: this.branchName,
        issueNumber: issue.number
      });

      const closedAfterCurrent = new Set(this.closedIssueNumbers);
      closedAfterCurrent.add(issue.number);
      await this.createOrUpdatePrdPullRequest(sequence, closedAfterCurrent);
      await this.github.closeIssue(issue.number);
      this.logger.log(`Code Factory: completed AFK Issue #${issue.number}.`);

      return "completed";
    } catch (error) {
      await this.postAfkErrorComment(issue, [formatError(error)]);
      this.logger.log(`Code Factory: stopped PRD #${prd.number}; AFK Issue #${issue.number} failed.`);
      return "error";
    }
  }

  private async findUnresolvedBlockers(issue: ImplementationIssue): Promise<string[]> {
    const blockerNumbers = parseBlockingIssueNumbers(issue.body);
    const unresolved: string[] = [];

    for (const blockerNumber of blockerNumbers) {
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

  private async postAfkErrorComment(issue: ImplementationIssue, errors: string[]): Promise<void> {
    const body = await this.templates.render("templates/afk-error-comment.md", {
      prd_number: this.prd.number,
      issue_number: issue.number,
      error_summary: errors.join("\n"),
      prd_branch: this.branchName,
      prd_sandbox: this.sandboxName
    });

    await this.upsertComment(issue.number, afkErrorMarker(issue.number), body);
  }

  private async routeFinalReview(sequence: ImplementationSequence): Promise<void> {
    const { prd } = this;
    const pullRequest = await this.github.findPullRequestByHead(this.branchName);

    if (!pullRequest) {
      this.logger.log(
        `Code Factory: no PRD Pull Request found for PRD #${prd.number}; skipping final review.`
      );
      return;
    }

    this.logger.log(`Code Factory: running final review for PRD #${prd.number}.`);

    const diff = await this.github.getPullRequestDiff(pullRequest.number);
    const prompt = await this.buildFinalReviewPrompt(sequence, diff);

    await this.sandbox.ensureSandbox({ sandboxName: this.sandboxName });
    const reviewBody = await this.sandbox.runFinalReview({ sandboxName: this.sandboxName, prompt });

    const commentBody = await this.templates.render("templates/final-review-comment.md", {
      prd_number: prd.number,
      review_body: reviewBody
    });

    await this.upsertComment(pullRequest.number, finalReviewMarker(prd.number), commentBody);

    await this.github.markPullRequestReadyForReview(pullRequest.number);
    this.logger.log(
      `Code Factory: marked PRD Pull Request #${pullRequest.number} ready for review.`
    );

    const prAuthor = await this.github.getAuthenticatedUser();
    const prdAuthor = prd.author.login;

    if (prdAuthor !== prAuthor) {
      await this.github.requestPullRequestReview(pullRequest.number, prdAuthor);
      this.logger.log(
        `Code Factory: requested review from ${prdAuthor} for PRD Pull Request #${pullRequest.number}.`
      );
    } else {
      const tagBody = `@${prdAuthor} the Code Factory has completed all Implementation Issues for PRD #${prd.number}. Please review the PR.`;
      await this.github.createIssueComment(pullRequest.number, tagBody);
      this.logger.log(
        `Code Factory: tagged ${prdAuthor} in PRD Pull Request #${pullRequest.number} (self-review).`
      );
    }

    await this.sandbox.removeSandbox({ sandboxName: this.sandboxName });
    this.logger.log(`Code Factory: removed PRD Sandbox ${this.sandboxName}.`);
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

  private async createOrUpdatePrdPullRequest(
    sequence: ImplementationSequence,
    closedIssueNumbers: Set<number>
  ): Promise<void> {
    const body = await this.renderPrdPullRequestBody(sequence, closedIssueNumbers);
    const existingPullRequest = await this.github.findPullRequestByHead(this.branchName);

    if (existingPullRequest) {
      await this.github.updatePullRequestBody(existingPullRequest.number, body);
      await this.github.setPullRequestLabels(existingPullRequest.number, [PRD_LABEL]);
      return;
    }

    const pullRequest = await this.github.createDraftPullRequest({
      title: `Code Factory PRD #${this.prd.number}: ${this.prd.title}`,
      body,
      head: this.branchName,
      base: await this.github.getDefaultBranch(),
      labels: [PRD_LABEL]
    } satisfies CreatePullRequestInput);
    await this.github.setPullRequestLabels(pullRequest.number, [PRD_LABEL]);
  }

  private async renderPrdPullRequestBody(
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

  private async upsertComment(issueNumber: number, marker: string, body: string): Promise<void> {
    const comments = await this.github.listIssueComments(issueNumber);
    const existing = comments.find((comment) => comment.body.includes(marker));

    if (existing) {
      await this.github.updateIssueComment(existing.id, body);
      return;
    }

    await this.github.createIssueComment(issueNumber, body);
  }
}

function logBatchSummary(logger: Pick<Console, "log">, outcomes: DispatchOutcome[]): void {
  const tally = { completed: 0, paused: 0, "issue-error": 0, skipped: 0 };

  for (const outcome of outcomes) {
    tally[outcome] += 1;
  }

  logger.log(
    `Code Factory: Batch Run finished; processed ${outcomes.length} PRD(s): `
    + `${tally.completed} completed, ${tally.paused} paused, `
    + `${tally["issue-error"]} errored, ${tally.skipped} skipped.`
  );
}

function formatImplementationChecklist(
  sequence: ImplementationSequence,
  closedIssueNumbers: Set<number>
): string {
  const issues = [...sequence.resolvedIssues, ...sequence.openIssues].sort(
    (left, right) => left.number - right.number
  );

  if (issues.length === 0) {
    return "- No Implementation Issues found.";
  }

  return issues
    .map((issue) => `- [${closedIssueNumbers.has(issue.number) ? "x" : " "}] #${issue.number} - ${issue.title}`)
    .join("\n");
}

function formatEarlierIssues(issues: ResolvedIssue[]): string {
  if (issues.length === 0) {
    return "None.";
  }

  return issues.map((issue) => `- #${issue.number} - ${issue.title} (${issue.state})`).join("\n");
}

function formatLaterIssues(issues: ImplementationIssue[]): string {
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

function hitlMarker(prdNumber: number, issueNumber: number): string {
  return `<!-- code-factory:hitl-prd-${prdNumber}-issue-${issueNumber} -->`;
}

function afkErrorMarker(issueNumber: number): string {
  return `<!-- code-factory:afk-error-issue-${issueNumber} -->`;
}

function finalReviewMarker(prdNumber: number): string {
  return `<!-- code-factory:final-review-prd-${prdNumber} -->`;
}

function isFactoryOwnedPrd(prd: GitHubIssue): boolean {
  return prd.author.login === FACTORY_OWNER;
}

function isGitHubClient(value: GitHubClient | CodeFactoryDependencies): value is GitHubClient {
  return "ensureRequiredLabels" in value && "getIssue" in value;
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class FileTemplateRenderer implements TemplateRenderer {
  public constructor(private readonly cwd: string) {}

  public async render(
    templatePath: string,
    values: Record<string, string | number>
  ): Promise<string> {
    const template = await readFile(path.join(this.cwd, templatePath), "utf8");

    return template.replace(/{{(\w+)}}/g, (_match, key: string) => {
      const value = values[key];
      return typeof value === "undefined" ? "" : String(value);
    });
  }
}

class FilePrdLockStore implements PrdLockStore {
  public constructor(private readonly cwd: string) {}

  public async acquire(prdNumber: number): Promise<PrdLock | null> {
    const locksDir = path.join(this.cwd, ".code-factory", "locks");
    const lockDir = path.join(locksDir, `prd-${prdNumber}.lock`);

    await mkdir(locksDir, { recursive: true });

    try {
      await mkdir(lockDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return null;
      }

      throw error;
    }

    return {
      release: async () => {
        await rm(lockDir, { recursive: true, force: true });
      }
    };
  }
}

class CommandSandboxRunner implements SandboxRunner {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly workspacePath: string,
    private readonly templateImage: string
  ) {}

  public async ensureSandbox(input: SandboxInput): Promise<void> {
    const output = await this.runner.run("sbx", ["ls", "--json"]);
    const { sandboxes } = JSON.parse(output) as { sandboxes: Array<{ name: string }> };
    if (!sandboxes.some(s => s.name === input.sandboxName)) {
      await this.runner.run("sbx", [
        "create",
        "--clone",
        "--template",
        this.templateImage,
        "--name",
        input.sandboxName,
        "codex",
        this.workspacePath
      ]);
    }
  }

  public async checkoutBranch(input: SandboxBranchInput): Promise<void> {
    await this.exec(input.sandboxName, [
      "git",
      "checkout",
      "-B",
      input.branchName
    ]);
  }

  public async runAfkIssue(input: SandboxAfkInput): Promise<void> {
    await this.exec(input.sandboxName, this.codexExecCommand(input.prompt), { streamOutput: true });
  }

  public async runFinalReview(input: SandboxFinalReviewInput): Promise<string> {
    return this.exec(input.sandboxName, this.codexExecCommand(input.prompt), { streamOutput: true });
  }

  public async removeSandbox(input: SandboxInput): Promise<void> {
    await this.runner.run("sbx", ["rm", input.sandboxName]);
  }

  public async commitAndPush(input: SandboxCommitInput): Promise<void> {
    await this.exec(input.sandboxName, ["git", "add", "-A"]);
    await this.exec(input.sandboxName, [
      "git",
      "commit",
      "-m",
      "chore: code factory implementation",
      "-m",
      `Refs #${input.issueNumber}`
    ]);
    await this.exec(input.sandboxName, [
      "git",
      "push",
      "-u",
      "origin",
      input.branchName
    ]);
  }

  private async exec(
    sandboxName: string,
    command: string[],
    options: SandboxExecOptions = {}
  ): Promise<string> {
    const args = [
      "exec",
      "--workdir",
      this.workspacePath
    ];

    args.push(
      sandboxName,
      "--",
      ...command
    );

    return this.runner.run("sbx", args, { streamOutput: options.streamOutput });
  }

  private codexExecCommand(prompt: string): string[] {
    return ["codex", "exec", ...SANDBOX_CODEX_EXEC_FLAGS, prompt];
  }
}

interface SandboxExecOptions {
  streamOutput?: boolean;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export const runCodeFactory: CodeFactoryRunner = createCodeFactory();
