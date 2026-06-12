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
  "--ask-for-approval",
  "never",
  "--sandbox",
  "danger-full-access"
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

type PrdProcessOutcome = "completed" | "issue-completed" | "paused" | "issue-error" | "skipped";

interface PrdContext {
  github: GitHubClient;
  sandbox: SandboxRunner;
  lockStore: PrdLockStore;
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
  const context: PrdContext = {
    github: dependencies.github ?? new GitHubCliClient(),
    sandbox: dependencies.sandbox
      ?? new CommandSandboxRunner(
        commandRunner,
        cwd,
        dependencies.sandboxTemplate ?? process.env.CODE_FACTORY_SANDBOX_TEMPLATE ?? DEFAULT_SANDBOX_TEMPLATE
      ),
    lockStore: dependencies.lockStore ?? new FilePrdLockStore(cwd),
    templates: dependencies.templates ?? new FileTemplateRenderer(cwd),
    logger: dependencies.logger ?? console
  };

  return {
    async runExplicit(prdNumber: number): Promise<void> {
      await context.github.ensureRequiredLabels();

      const prd = await context.github.getIssue(prdNumber);

      if (!isFactoryOwnedPrd(prd)) {
        context.logger.log(
          `Code Factory: skipping PRD #${prd.number}; author ${prd.author.login} is not ${FACTORY_OWNER}.`
        );
        return;
      }

      context.logger.log(`Code Factory: starting Explicit Run for PRD #${prd.number}.`);
      context.logger.log(`Code Factory: processing only Factory-Owned PRDs by ${FACTORY_OWNER}.`);
      await processPrd(context, prd);
    },

    async runBatch(): Promise<void> {
      context.logger.log("Code Factory: starting Batch Run for ready PRDs.");
      await context.github.ensureRequiredLabels();
      context.logger.log(`Code Factory: discovering Factory-Owned PRDs by ${FACTORY_OWNER}.`);

      const prds = await context.github.listReadyPrds(FACTORY_OWNER);

      for (const prd of prds) {
        await processPrd(context, prd);
      }
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

async function processPrd(context: PrdContext, prd: GitHubIssue): Promise<PrdProcessOutcome> {
  if (prd.state !== "OPEN") {
    context.logger.log(`Code Factory: skipping PRD #${prd.number}; PRD is ${prd.state}.`);
    return "skipped";
  }

  const lock = await context.lockStore.acquire(prd.number);

  if (!lock) {
    context.logger.log(`Code Factory: skipping PRD #${prd.number}; PRD is already locked.`);
    return "skipped";
  }

  try {
    return await processLockedPrd(context, prd);
  } finally {
    await lock.release();
  }
}

async function processLockedPrd(context: PrdContext, prd: GitHubIssue): Promise<PrdProcessOutcome> {
  const branchName = deterministicPrdBranch(prd.number);
  const sandboxName = deterministicPrdSandbox(prd.number);

  context.logger.log(`Code Factory: building Implementation Sequence for PRD #${prd.number}.`);

  const subIssues = await context.github.getAttachedSubIssues(prd.number);
  const sequence = buildImplementationSequence(prd.number, subIssues);
  const closedIssueNumbers = new Set(sequence.resolvedIssues.map((issue) => issue.number));

  for (const issue of sequence.resolvedIssues) {
    context.logger.log(`Code Factory: skipping Resolved Issue #${issue.number}.`);
  }

  if (sequence.openIssues.length === 0) {
    context.logger.log(`Code Factory: PRD #${prd.number} has no open Implementation Issues.`);

    if (sequence.resolvedIssues.length > 0) {
      await runFinalReviewPhase(context, prd, sequence, branchName, sandboxName);
    }

    return "completed";
  }

  const orderedIssues = sequence.openIssues
    .map((issue) => `#${issue.number} (${issue.kind})`)
    .join(", ");
  context.logger.log(`Code Factory: Implementation Sequence for PRD #${prd.number}: ${orderedIssues}.`);

  const processedIssues: ResolvedIssue[] = [];

  for (const issue of sequence.openIssues) {
    if (issue.kind === "hitl") {
      await postHitlPauseComment(context, prd, issue, branchName, sandboxName);
      context.logger.log(`Code Factory: paused PRD #${prd.number} at HITL Issue #${issue.number}.`);
      return "paused";
    }

    const priorIssues = [...sequence.resolvedIssues, ...processedIssues];
    const laterIssues = sequence.openIssues.filter((candidate) => candidate.number > issue.number);
    const outcome = await processAfkIssue(context, {
      prd,
      issue,
      sequence,
      priorIssues,
      laterIssues,
      branchName,
      sandboxName,
      closedIssueNumbers
    });

    if (outcome !== "issue-completed") {
      return outcome;
    }

    closedIssueNumbers.add(issue.number);
    processedIssues.push({
      number: issue.number,
      title: issue.title,
      state: "CLOSED",
      labels: issue.labels
    });
  }

  const allResolvedSequence: ImplementationSequence = {
    openIssues: [],
    resolvedIssues: [...sequence.resolvedIssues, ...processedIssues]
  };
  await runFinalReviewPhase(context, prd, allResolvedSequence, branchName, sandboxName);

  return "completed";
}

async function processAfkIssue(
  context: PrdContext,
  input: {
    prd: GitHubIssue;
    issue: ImplementationIssue;
    sequence: ImplementationSequence;
    priorIssues: ResolvedIssue[];
    laterIssues: ImplementationIssue[];
    branchName: string;
    sandboxName: string;
    closedIssueNumbers: Set<number>;
  }
): Promise<PrdProcessOutcome> {
  const { prd, issue, sequence, priorIssues, laterIssues, branchName, sandboxName } = input;

  try {
    const unresolvedBlockers = await findUnresolvedBlockers(context.github, issue);

    if (unresolvedBlockers.length > 0) {
      await postAfkErrorComment(context, prd, issue, branchName, sandboxName, unresolvedBlockers);
      context.logger.log(
        `Code Factory: stopped PRD #${prd.number}; AFK Issue #${issue.number} has unresolved blockers.`
      );
      return "issue-error";
    }

    await context.sandbox.ensureSandbox({ sandboxName });
    await context.sandbox.checkoutBranch({ sandboxName, branchName });
    await context.sandbox.runAfkIssue({
      sandboxName,
      branchName,
      prompt: await buildAfkPrompt(context, prd, issue, priorIssues, laterIssues, branchName)
    });
    await context.sandbox.commitAndPush({
      sandboxName,
      branchName,
      issueNumber: issue.number
    });

    const closedAfterCurrent = new Set(input.closedIssueNumbers);
    closedAfterCurrent.add(issue.number);
    await createOrUpdatePrdPullRequest(context, {
      prd,
      sequence,
      branchName,
      sandboxName,
      closedIssueNumbers: closedAfterCurrent
    });
    await context.github.closeIssue(issue.number);
    context.logger.log(`Code Factory: completed AFK Issue #${issue.number}.`);

    return "issue-completed";
  } catch (error) {
    await postAfkErrorComment(context, prd, issue, branchName, sandboxName, [
      formatError(error)
    ]);
    context.logger.log(`Code Factory: stopped PRD #${prd.number}; AFK Issue #${issue.number} failed.`);
    return "issue-error";
  }
}

async function findUnresolvedBlockers(
  github: GitHubClient,
  issue: ImplementationIssue
): Promise<string[]> {
  const blockerNumbers = parseBlockingIssueNumbers(issue.body);
  const unresolved: string[] = [];

  for (const blockerNumber of blockerNumbers) {
    const blocker = await github.getIssue(blockerNumber);

    if (blocker.state !== "CLOSED") {
      unresolved.push(`#${blocker.number} - ${blocker.title} (${blocker.state})`);
    }
  }

  return unresolved;
}

async function buildAfkPrompt(
  context: PrdContext,
  prd: GitHubIssue,
  issue: ImplementationIssue,
  priorIssues: ResolvedIssue[],
  laterIssues: ImplementationIssue[],
  branchName: string
): Promise<string> {
  return context.templates.render("prompts/afk-issue.md", {
    prd_branch: branchName,
    prd_body: prd.body,
    issue_body: issue.body,
    earlier_issues: formatEarlierIssues(priorIssues),
    later_issues: formatLaterIssues(laterIssues)
  });
}

async function postHitlPauseComment(
  context: PrdContext,
  prd: GitHubIssue,
  issue: ImplementationIssue,
  branchName: string,
  sandboxName: string
): Promise<void> {
  const body = await context.templates.render("templates/hitlpause-comment.md", {
    prd_number: prd.number,
    prd_author: prd.author.login,
    issue_number: issue.number,
    issue_title: issue.title,
    prd_branch: branchName,
    prd_sandbox: sandboxName
  });

  await upsertIssueComment(context.github, prd.number, hitlMarker(prd.number, issue.number), body);
}

async function postAfkErrorComment(
  context: PrdContext,
  prd: GitHubIssue,
  issue: ImplementationIssue,
  branchName: string,
  sandboxName: string,
  errors: string[]
): Promise<void> {
  const body = await context.templates.render("templates/afk-error-comment.md", {
    prd_number: prd.number,
    issue_number: issue.number,
    error_summary: errors.join("\n"),
    prd_branch: branchName,
    prd_sandbox: sandboxName
  });

  await upsertIssueComment(context.github, issue.number, afkErrorMarker(issue.number), body);
}

async function runFinalReviewPhase(
  context: PrdContext,
  prd: GitHubIssue,
  sequence: ImplementationSequence,
  branchName: string,
  sandboxName: string
): Promise<void> {
  const pullRequest = await context.github.findPullRequestByHead(branchName);

  if (!pullRequest) {
    context.logger.log(
      `Code Factory: no PRD Pull Request found for PRD #${prd.number}; skipping final review.`
    );
    return;
  }

  context.logger.log(`Code Factory: running final review for PRD #${prd.number}.`);

  const diff = await context.github.getPullRequestDiff(pullRequest.number);
  const prompt = await buildFinalReviewPrompt(context, prd, sequence, diff);

  await context.sandbox.ensureSandbox({ sandboxName });
  const reviewBody = await context.sandbox.runFinalReview({ sandboxName, prompt });

  const commentBody = await context.templates.render("templates/final-review-comment.md", {
    prd_number: prd.number,
    review_body: reviewBody
  });

  await upsertIssueComment(
    context.github,
    pullRequest.number,
    finalReviewMarker(prd.number),
    commentBody
  );

  await context.github.markPullRequestReadyForReview(pullRequest.number);
  context.logger.log(
    `Code Factory: marked PRD Pull Request #${pullRequest.number} ready for review.`
  );

  const prAuthor = await context.github.getAuthenticatedUser();
  const prdAuthor = prd.author.login;

  if (prdAuthor !== prAuthor) {
    await context.github.requestPullRequestReview(pullRequest.number, prdAuthor);
    context.logger.log(
      `Code Factory: requested review from ${prdAuthor} for PRD Pull Request #${pullRequest.number}.`
    );
  } else {
    const tagBody = `@${prdAuthor} the Code Factory has completed all Implementation Issues for PRD #${prd.number}. Please review the PR.`;
    await context.github.createIssueComment(pullRequest.number, tagBody);
    context.logger.log(
      `Code Factory: tagged ${prdAuthor} in PRD Pull Request #${pullRequest.number} (self-review).`
    );
  }

  await context.sandbox.removeSandbox({ sandboxName });
  context.logger.log(`Code Factory: removed PRD Sandbox ${sandboxName}.`);
}

async function buildFinalReviewPrompt(
  context: PrdContext,
  prd: GitHubIssue,
  sequence: ImplementationSequence,
  diff: string
): Promise<string> {
  return context.templates.render("prompts/final-review.md", {
    prd_body: prd.body,
    implementation_issues: formatEarlierIssues(sequence.resolvedIssues),
    pr_diff: diff
  });
}

async function createOrUpdatePrdPullRequest(
  context: PrdContext,
  input: {
    prd: GitHubIssue;
    sequence: ImplementationSequence;
    branchName: string;
    sandboxName: string;
    closedIssueNumbers: Set<number>;
  }
): Promise<void> {
  const body = await renderPrdPullRequestBody(context, input);
  const existingPullRequest = await context.github.findPullRequestByHead(input.branchName);

  if (existingPullRequest) {
    await context.github.updatePullRequestBody(existingPullRequest.number, body);
    await context.github.setPullRequestLabels(existingPullRequest.number, [PRD_LABEL]);
    return;
  }

  const pullRequest = await context.github.createDraftPullRequest({
    title: `Code Factory PRD #${input.prd.number}: ${input.prd.title}`,
    body,
    head: input.branchName,
    base: await context.github.getDefaultBranch(),
    labels: [PRD_LABEL]
  } satisfies CreatePullRequestInput);
  await context.github.setPullRequestLabels(pullRequest.number, [PRD_LABEL]);
}

async function renderPrdPullRequestBody(
  context: PrdContext,
  input: {
    prd: GitHubIssue;
    sequence: ImplementationSequence;
    branchName: string;
    sandboxName: string;
    closedIssueNumbers: Set<number>;
  }
): Promise<string> {
  return context.templates.render("templates/pr-body.md", {
    prd_number: input.prd.number,
    prd_branch: input.branchName,
    prd_sandbox: input.sandboxName,
    implementation_issue_checklist: formatImplementationChecklist(
      input.sequence,
      input.closedIssueNumbers
    )
  });
}

async function upsertIssueComment(
  github: GitHubClient,
  issueNumber: number,
  marker: string,
  body: string
): Promise<void> {
  const comments = await github.listIssueComments(issueNumber);
  const existing = comments.find((comment) => comment.body.includes(marker));

  if (existing) {
    await github.updateIssueComment(existing.id, body);
    return;
  }

  await github.createIssueComment(issueNumber, body);
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
    await this.exec(input.sandboxName, this.codexExecCommand(input.prompt));
  }

  public async runFinalReview(input: SandboxFinalReviewInput): Promise<string> {
    return this.exec(input.sandboxName, this.codexExecCommand(input.prompt));
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

  private async exec(sandboxName: string, command: string[]): Promise<string> {
    return this.runner.run("sbx", [
      "exec",
      "--workdir",
      this.workspacePath,
      sandboxName,
      "--",
      ...command
    ]);
  }

  private codexExecCommand(prompt: string): string[] {
    return ["codex", "exec", ...SANDBOX_CODEX_EXEC_FLAGS, prompt];
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export const runCodeFactory: CodeFactoryRunner = createCodeFactory();
