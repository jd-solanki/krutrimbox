import path from "node:path";
import {
  createExecFileCommandRunner,
  createGitHubCliClient,
  type CommandRunner,
  type GitHubClient,
  type GitHubIssue
} from "../github";
import { resolveCodingAgent, type AgentName, type CodingAgent } from "./agents/coding-agent";
import { classifyOwnership, isImplementable } from "./issue/ownership";
import {
  FactoryRun,
  type FactoryRunDependencies,
  type FactoryRunOutcome
} from "./factory-run";
import { loadProjectConfig, type ResolvedHookAction } from "./config";
import { type KrutrimboxHookName } from "./hooks/names";
import { FileTargetIssueLockStore, type TargetIssueLockStore } from "./lock-store";
import { createFileRunLogFactory, type RunLogFactory } from "./run-log/run-log";
import { CommandSandboxRunner, type SandboxRunner } from "./sandbox-runner";
import { ProjectTemplateRenderer, type TemplateRenderer } from "./templates/template-renderer";

export interface KrutrimboxDependencies {
  github?: GitHubClient;
  // A pre-built SandboxRunner. When provided (e.g. a test fake) it is used for
  // every run regardless of agent; otherwise a per-agent CommandSandboxRunner is
  // built at dispatch time, once the run's Agent Backend is known.
  sandbox?: SandboxRunner;
  lockStore?: TargetIssueLockStore;
  templates?: TemplateRenderer;
  // The repository's resolved lifecycle hooks (ADR-0021). Injected in tests;
  // otherwise loaded from `.krutrimbox/config.json` alongside the templates.
  hooks?: Map<KrutrimboxHookName, ResolvedHookAction[]>;
  logger?: Pick<Console, "log">;
  openRunLog?: RunLogFactory;
  // Runs `gh` Command Steps on the host. Injected in tests so a Command Step
  // never spawns a real `gh`; in production the exec-file runner is used.
  commandRunner?: CommandRunner;
  cwd?: string;
  sandboxTemplate?: string;
}

// What dispatching one Target Issue produces: a Factory Run outcome, or `skipped`
// when the issue is not open or is already locked and no run took place.
type DispatchOutcome = FactoryRunOutcome | "skipped";

// Per-run flags shared by Explicit and Batch Runs.
export interface RunOptions {
  // Origin branch the Target Issue Branch is cut from and the PR targets; defaults
  // to the repository default branch.
  baseBranch?: string;
  // The Implement-Unassigned Override (`--implement-unassigned`): run zero-assignee
  // issues too. A solo-developer escape hatch (ADR-0018).
  implementUnassigned?: boolean;
}

// The resolved per-run context: everything a dispatch needs that does not vary
// per Target Issue. Resolved once at the top of a run so the Operator and base
// branch are read a single time, not per dispatched issue.
interface RunContext {
  agent: CodingAgent;
  baseBranch: string;
  operator: string;
  allowUnassigned: boolean;
}

// The top-level orchestrator: discovers the Operator's Target Issues and
// dispatches each one. Dependencies are injected for tests; in production the
// constructor wires the file/command-backed implementations from `cwd`.
export class Krutrimbox {
  private readonly github: GitHubClient;
  private readonly lockStore: TargetIssueLockStore;
  private readonly logger: Pick<Console, "log">;
  private readonly openRunLog: RunLogFactory;
  private readonly templates: TemplateRenderer;
  private readonly hooks: Map<KrutrimboxHookName, ResolvedHookAction[]>;
  // Held so a per-agent CommandSandboxRunner can be built at dispatch time, once
  // the run's Agent Backend is known.
  private readonly cwd: string;
  private readonly commandRunner: CommandRunner;
  private readonly injectedSandbox?: SandboxRunner;
  private readonly sandboxTemplateOverride?: string;

  public constructor(githubOrDependencies: GitHubClient | KrutrimboxDependencies = {}) {
    const dependencies = isGitHubClient(githubOrDependencies)
      ? { github: githubOrDependencies }
      : githubOrDependencies;
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());

    this.github = dependencies.github ?? createGitHubCliClient();
    this.lockStore = dependencies.lockStore ?? new FileTargetIssueLockStore(cwd);
    this.logger = dependencies.logger ?? console;
    this.openRunLog = dependencies.openRunLog ?? createFileRunLogFactory(cwd, this.logger);
    // Load the committed config once and derive both the templates and the
    // lifecycle hooks from it, so an invalid config fails fast and is read a single
    // time. Injected templates mean the caller (a test) owns configuration, so the
    // file is not read at all; injected hooks can still override it.
    const projectConfig = dependencies.templates ? undefined : loadProjectConfig(cwd);
    this.templates = dependencies.templates ?? new ProjectTemplateRenderer(projectConfig);
    this.hooks = dependencies.hooks ?? projectConfig?.hooks ?? new Map();
    this.cwd = cwd;
    this.commandRunner = dependencies.commandRunner ?? createExecFileCommandRunner();
    this.injectedSandbox = dependencies.sandbox;
    this.sandboxTemplateOverride = dependencies.sandboxTemplate;
  }

  public async runExplicit(
    issueNumber: number,
    agentName: AgentName,
    options: RunOptions = {}
  ): Promise<void> {
    const agent = resolveCodingAgent(agentName);
    await this.github.ensureRequiredLabels();
    const context = await this.buildRunContext(agent, options);

    this.logger.log(
      `krutrimbox: starting Explicit Run for Target Issue #${issueNumber} with the ${agent.name} Agent Backend.`
    );

    const targetIssue = await this.github.getIssue(issueNumber);
    await this.dispatch(targetIssue, context);
  }

  public async runBatch(agentName: AgentName, options: RunOptions = {}): Promise<void> {
    const agent = resolveCodingAgent(agentName);
    this.logger.log(
      `krutrimbox: starting Batch Run for ready Target Issues with the ${agent.name} Agent Backend.`
    );
    await this.github.ensureRequiredLabels();
    const context = await this.buildRunContext(agent, options);
    this.logger.log(`krutrimbox: discovering Target Issues assigned to ${context.operator}.`);

    const targetIssues = await this.discoverBatchTargetIssues(context);
    const outcomes: DispatchOutcome[] = [];

    for (const targetIssue of targetIssues) {
      outcomes.push(await this.dispatch(targetIssue, context));
    }

    this.logBatchSummary(outcomes);
  }

  // Resolves the once-per-run context: the Operator (the authenticated GitHub
  // user this run implements work for) and the base branch. The base defaults to
  // the repository's default branch — kept dynamic rather than a hard-coded `main`
  // so repositories whose default is `dev`, `trunk`, etc. work without the flag.
  private async buildRunContext(agent: CodingAgent, options: RunOptions): Promise<RunContext> {
    return {
      agent,
      baseBranch: options.baseBranch ?? (await this.github.getDefaultBranch()),
      operator: await this.github.getAuthenticatedUser(),
      allowUnassigned: options.implementUnassigned ?? false
    };
  }

  // Discovers the Batch Run's Target Issues: those assigned to the Operator, plus
  // unassigned ones under the Implement-Unassigned Override. Issues assigned to
  // others or to several people are dropped with a warning so a Batch Run never
  // claims work it cannot cleanly route (ADR-0018, ADR-0019).
  private async discoverBatchTargetIssues(context: RunContext): Promise<GitHubIssue[]> {
    const discovered = context.allowUnassigned
      ? await this.github.listAllReadyTargetIssues()
      : await this.github.listReadyTargetIssues();

    return [...discovered]
      .filter((targetIssue) => this.isDiscoverableByOperator(targetIssue, context))
      .sort((left, right) => left.number - right.number);
  }

  private isDiscoverableByOperator(targetIssue: GitHubIssue, context: RunContext): boolean {
    const ownership = classifyOwnership(targetIssue, context.operator);

    if (isImplementable(ownership, { allowUnassigned: context.allowUnassigned })) {
      return true;
    }

    this.logger.log(
      `krutrimbox: skipping Target Issue #${targetIssue.number}; it is not assigned to you alone (${ownership}).`
    );
    return false;
  }

  // The dispatch seam: discovery hands a Target Issue here, and dispatch guards
  // it (open state + lock) before a Factory Run ever exists. Holding the lock
  // across `process()` keeps the run's invariant intact: a FactoryRun owns its
  // deterministic branch and sandbox.
  private async dispatch(
    targetIssue: GitHubIssue,
    context: RunContext
  ): Promise<DispatchOutcome> {
    if (targetIssue.state !== "OPEN") {
      this.logger.log(
        `krutrimbox: skipping Target Issue #${targetIssue.number}; issue is ${targetIssue.state}.`
      );
      return "skipped";
    }

    const lock = await this.lockStore.acquire(targetIssue.number);

    if (!lock) {
      this.logger.log(`krutrimbox: skipping Target Issue #${targetIssue.number}; issue is already locked.`);
      return "skipped";
    }

    const runLog = this.openRunLog(targetIssue.number);
    if (runLog.filePath) {
      this.logger.log(`krutrimbox: writing Target Issue #${targetIssue.number} logs to ${runLog.filePath}.`);
    }

    const runDependencies: FactoryRunDependencies = {
      github: this.github,
      sandbox: this.buildSandbox(context.agent),
      agent: context.agent,
      repositorySlug: await this.github.getRepositorySlug(),
      baseBranch: context.baseBranch,
      operator: context.operator,
      allowUnassigned: context.allowUnassigned,
      templates: this.templates,
      hooks: this.hooks,
      hostCommandRunner: this.commandRunner,
      logger: runLog,
      output: runLog.stream
    };

    try {
      return await new FactoryRun(runDependencies, targetIssue).process();
    } finally {
      await runLog.close();
      await lock.release();
    }
  }

  // Builds the SandboxRunner for one run's Agent Backend. An injected sandbox
  // (test fake) wins; otherwise the template resolves as explicit override ??
  // env override ?? the agent's default template (ADR-0012).
  private buildSandbox(agent: CodingAgent): SandboxRunner {
    if (this.injectedSandbox) {
      return this.injectedSandbox;
    }

    const templateImage =
      this.sandboxTemplateOverride
      ?? process.env.KRUTRIMBOX_SANDBOX_TEMPLATE
      ?? agent.defaultTemplate;

    return new CommandSandboxRunner(this.commandRunner, this.cwd, agent, templateImage);
  }

  private logBatchSummary(outcomes: DispatchOutcome[]): void {
    const tally = { completed: 0, paused: 0, "issue-error": 0, skipped: 0 };

    for (const outcome of outcomes) {
      tally[outcome] += 1;
    }

    this.logger.log(
      `krutrimbox: Batch Run finished; processed ${outcomes.length} Target Issue(s): `
      + `${tally.completed} completed, ${tally.paused} paused, `
      + `${tally["issue-error"]} errored, ${tally.skipped} skipped.`
    );
  }
}

function isGitHubClient(value: GitHubClient | KrutrimboxDependencies): value is GitHubClient {
  return "ensureRequiredLabels" in value && "getIssue" in value;
}

export const runKrutrimbox = new Krutrimbox();
