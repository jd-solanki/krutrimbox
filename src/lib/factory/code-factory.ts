import path from "node:path";
import {
  createExecFileCommandRunner,
  createGitHubCliClient,
  type GitHubClient,
  type GitHubIssue
} from "../github";
import { DEFAULT_SANDBOX_TEMPLATE, FACTORY_OWNER } from "./constants";
import {
  FactoryRun,
  type FactoryRunDependencies,
  type FactoryRunOutcome
} from "./factory-run";
import { FilePrdLockStore, type PrdLockStore } from "./lock-store";
import { createFileRunLogFactory, type RunLogFactory } from "./run-log";
import { CommandSandboxRunner, type SandboxRunner } from "./sandbox-runner";
import { BundledTemplateRenderer, type TemplateRenderer } from "./template-renderer";

export interface CodeFactoryDependencies {
  github?: GitHubClient;
  sandbox?: SandboxRunner;
  lockStore?: PrdLockStore;
  templates?: TemplateRenderer;
  logger?: Pick<Console, "log">;
  openRunLog?: RunLogFactory;
  cwd?: string;
  sandboxTemplate?: string;
}

// What dispatching one PRD produces: a Factory Run outcome, or `skipped` when
// the PRD is not open or is already locked and no run took place.
type DispatchOutcome = FactoryRunOutcome | "skipped";

// The top-level orchestrator: discovers Factory-Owned PRDs and dispatches each
// one. Dependencies are injected for tests; in production the constructor wires
// the file/command-backed implementations from `cwd`.
export class CodeFactory {
  private readonly github: GitHubClient;
  private readonly lockStore: PrdLockStore;
  private readonly logger: Pick<Console, "log">;
  private readonly openRunLog: RunLogFactory;
  private readonly runDependencies: FactoryRunDependencies;

  public constructor(githubOrDependencies: GitHubClient | CodeFactoryDependencies = {}) {
    const dependencies = isGitHubClient(githubOrDependencies)
      ? { github: githubOrDependencies }
      : githubOrDependencies;
    const cwd = path.resolve(dependencies.cwd ?? process.cwd());
    const commandRunner = createExecFileCommandRunner();

    this.github = dependencies.github ?? createGitHubCliClient();
    this.lockStore = dependencies.lockStore ?? new FilePrdLockStore(cwd);
    this.logger = dependencies.logger ?? console;
    this.openRunLog = dependencies.openRunLog ?? createFileRunLogFactory(cwd, this.logger);

    const sandbox =
      dependencies.sandbox
      ?? new CommandSandboxRunner(
        commandRunner,
        cwd,
        dependencies.sandboxTemplate ?? process.env.CODE_FACTORY_SANDBOX_TEMPLATE ?? DEFAULT_SANDBOX_TEMPLATE
      );
    const templates = dependencies.templates ?? new BundledTemplateRenderer();

    this.runDependencies = { github: this.github, sandbox, templates, logger: this.logger };
  }

  public async runExplicit(prdNumber: number): Promise<void> {
    await this.github.ensureRequiredLabels();

    const prd = await this.github.getIssue(prdNumber);

    if (!isFactoryOwnedPrd(prd)) {
      this.logger.log(
        `Code Factory: skipping PRD #${prd.number}; author ${prd.author.login} is not ${FACTORY_OWNER}.`
      );
      return;
    }

    this.logger.log(`Code Factory: starting Explicit Run for PRD #${prd.number}.`);
    this.logger.log(`Code Factory: processing only Factory-Owned PRDs by ${FACTORY_OWNER}.`);
    await this.dispatch(prd);
  }

  public async runBatch(): Promise<void> {
    this.logger.log("Code Factory: starting Batch Run for ready PRDs.");
    await this.github.ensureRequiredLabels();
    this.logger.log(`Code Factory: discovering Factory-Owned PRDs by ${FACTORY_OWNER}.`);

    const prds = [...await this.github.listReadyPrds(FACTORY_OWNER)]
      .sort((left, right) => left.number - right.number);
    const outcomes: DispatchOutcome[] = [];

    for (const prd of prds) {
      outcomes.push(await this.dispatch(prd));
    }

    this.logBatchSummary(outcomes);
  }

  // The dispatch seam: discovery hands a PRD here, and dispatch guards it (open
  // state + PRD Lock) before a Factory Run ever exists. Holding the lock across
  // `process()` keeps the run's invariant intact: a FactoryRun ⇒ we own its
  // PRD Branch and PRD Sandbox.
  private async dispatch(prd: GitHubIssue): Promise<DispatchOutcome> {
    if (prd.state !== "OPEN") {
      this.logger.log(`Code Factory: skipping PRD #${prd.number}; PRD is ${prd.state}.`);
      return "skipped";
    }

    const lock = await this.lockStore.acquire(prd.number);

    if (!lock) {
      this.logger.log(`Code Factory: skipping PRD #${prd.number}; PRD is already locked.`);
      return "skipped";
    }

    const runLog = this.openRunLog(prd.number);
    if (runLog.filePath) {
      this.logger.log(`Code Factory: writing PRD #${prd.number} logs to ${runLog.filePath}.`);
    }

    try {
      return await new FactoryRun(
        { ...this.runDependencies, logger: runLog, output: runLog.stream },
        prd
      ).process();
    } finally {
      await runLog.close();
      await lock.release();
    }
  }

  private logBatchSummary(outcomes: DispatchOutcome[]): void {
    const tally = { completed: 0, paused: 0, "issue-error": 0, skipped: 0 };

    for (const outcome of outcomes) {
      tally[outcome] += 1;
    }

    this.logger.log(
      `Code Factory: Batch Run finished; processed ${outcomes.length} PRD(s): `
      + `${tally.completed} completed, ${tally.paused} paused, `
      + `${tally["issue-error"]} errored, ${tally.skipped} skipped.`
    );
  }
}

function isFactoryOwnedPrd(prd: GitHubIssue): boolean {
  return prd.author.login === FACTORY_OWNER;
}

function isGitHubClient(value: GitHubClient | CodeFactoryDependencies): value is GitHubClient {
  return "ensureRequiredLabels" in value && "getIssue" in value;
}

export const runCodeFactory = new CodeFactory();
