import path from "node:path";
import {
  createExecFileCommandRunner,
  createGitHubCliClient,
  type CommandRunner,
  type GitHubClient,
  type GitHubIssue
} from "../github";
import { resolveCodingAgent, type AgentName, type CodingAgent } from "./coding-agent";
import { FACTORY_OWNER } from "./constants";
import {
  FactoryRun,
  type FactoryRunDependencies,
  type FactoryRunOutcome
} from "./factory-run";
import { FileTargetIssueLockStore, type TargetIssueLockStore } from "./lock-store";
import { createFileRunLogFactory, type RunLogFactory } from "./run-log";
import { CommandSandboxRunner, type SandboxRunner } from "./sandbox-runner";
import { BundledTemplateRenderer, type TemplateRenderer } from "./template-renderer";

export interface KrutrimboxDependencies {
  github?: GitHubClient;
  // A pre-built SandboxRunner. When provided (e.g. a test fake) it is used for
  // every run regardless of agent; otherwise a per-agent CommandSandboxRunner is
  // built at dispatch time, once the run's Agent Backend is known.
  sandbox?: SandboxRunner;
  lockStore?: TargetIssueLockStore;
  templates?: TemplateRenderer;
  logger?: Pick<Console, "log">;
  openRunLog?: RunLogFactory;
  cwd?: string;
  sandboxTemplate?: string;
}

// What dispatching one Target Issue produces: a Factory Run outcome, or `skipped`
// when the issue is not open or is already locked and no run took place.
type DispatchOutcome = FactoryRunOutcome | "skipped";

// The top-level orchestrator: discovers Factory-Owned Target Issues and
// dispatches each one. Dependencies are injected for tests; in production the
// constructor wires the file/command-backed implementations from `cwd`.
export class Krutrimbox {
  private readonly github: GitHubClient;
  private readonly lockStore: TargetIssueLockStore;
  private readonly logger: Pick<Console, "log">;
  private readonly openRunLog: RunLogFactory;
  private readonly templates: TemplateRenderer;
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
    this.templates = dependencies.templates ?? new BundledTemplateRenderer();
    this.cwd = cwd;
    this.commandRunner = createExecFileCommandRunner();
    this.injectedSandbox = dependencies.sandbox;
    this.sandboxTemplateOverride = dependencies.sandboxTemplate;
  }

  public async runExplicit(issueNumber: number, agentName: AgentName): Promise<void> {
    const agent = resolveCodingAgent(agentName);
    await this.github.ensureRequiredLabels();

    const targetIssue = await this.github.getIssue(issueNumber);

    if (!isFactoryOwnedTargetIssue(targetIssue)) {
      this.logger.log(
        `krutrimbox: skipping Target Issue #${targetIssue.number}; author ${targetIssue.author.login} is not ${FACTORY_OWNER}.`
      );
      return;
    }

    this.logger.log(
      `krutrimbox: starting Explicit Run for Target Issue #${targetIssue.number} with the ${agent.name} Agent Backend.`
    );
    this.logger.log(`krutrimbox: processing only Factory-Owned Target Issues by ${FACTORY_OWNER}.`);
    await this.dispatch(targetIssue, agent);
  }

  public async runBatch(agentName: AgentName): Promise<void> {
    const agent = resolveCodingAgent(agentName);
    this.logger.log(
      `krutrimbox: starting Batch Run for ready Target Issues with the ${agent.name} Agent Backend.`
    );
    await this.github.ensureRequiredLabels();
    this.logger.log(`krutrimbox: discovering Factory-Owned Target Issues by ${FACTORY_OWNER}.`);

    const targetIssues = [...await this.github.listReadyTargetIssues(FACTORY_OWNER)]
      .sort((left, right) => left.number - right.number);
    const outcomes: DispatchOutcome[] = [];

    for (const targetIssue of targetIssues) {
      outcomes.push(await this.dispatch(targetIssue, agent));
    }

    this.logBatchSummary(outcomes);
  }

  // The dispatch seam: discovery hands a Target Issue here, and dispatch guards
  // it (open state + lock) before a Factory Run ever exists. Holding the lock
  // across `process()` keeps the run's invariant intact: a FactoryRun owns its
  // deterministic branch and sandbox.
  private async dispatch(targetIssue: GitHubIssue, agent: CodingAgent): Promise<DispatchOutcome> {
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
      sandbox: this.buildSandbox(agent),
      agent,
      templates: this.templates,
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

function isFactoryOwnedTargetIssue(targetIssue: GitHubIssue): boolean {
  return targetIssue.author.login === FACTORY_OWNER;
}

function isGitHubClient(value: GitHubClient | KrutrimboxDependencies): value is GitHubClient {
  return "ensureRequiredLabels" in value && "getIssue" in value;
}

export const runKrutrimbox = new Krutrimbox();
