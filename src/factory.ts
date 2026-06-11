import { GitHubCliClient, type GitHubClient, type GitHubIssue } from "./github.js";

export const FACTORY_OWNER = "jd-solanki";
export const IMPLEMENTATION_LABEL = "PRD-sub-issue";
export const AFK_LABEL = "ready-for-agent";
export const HITL_LABEL = "ready-for-human";

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

export function createCodeFactory(github: GitHubClient = new GitHubCliClient()): CodeFactoryRunner {
  return {
    async runExplicit(prdNumber: number): Promise<void> {
      await github.ensureRequiredLabels();

      const prd = await github.getIssue(prdNumber);

      if (!isFactoryOwnedPrd(prd)) {
        console.log(
          `Code Factory: skipping PRD #${prd.number}; author ${prd.author.login} is not ${FACTORY_OWNER}.`
        );
        return;
      }

      console.log(`Code Factory: starting Explicit Run for PRD #${prd.number}.`);
      console.log(`Code Factory: processing only Factory-Owned PRDs by ${FACTORY_OWNER}.`);
      await processPrd(github, prd);
    },

    async runBatch(): Promise<void> {
      console.log("Code Factory: starting Batch Run for ready PRDs.");
      await github.ensureRequiredLabels();
      console.log(`Code Factory: discovering Factory-Owned PRDs by ${FACTORY_OWNER}.`);

      const prds = await github.listReadyPrds(FACTORY_OWNER);

      for (const prd of prds) {
        await processPrd(github, prd);
      }
    }
  };
}

export const runCodeFactory: CodeFactoryRunner = createCodeFactory();

export function buildImplementationSequence(
  prdNumber: number,
  attachedSubIssues: GitHubIssue[]
): ImplementationSequence {
  const openIssues: ImplementationIssue[] = [];
  const resolvedIssues: ResolvedIssue[] = [];

  for (const issue of attachedSubIssues) {
    const labels = labelNames(issue);

    if (!labels.includes(IMPLEMENTATION_LABEL) || !hasMatchingParentSection(issue.body, prdNumber)) {
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

async function processPrd(github: GitHubClient, prd: GitHubIssue): Promise<void> {
  if (prd.state !== "OPEN") {
    console.log(`Code Factory: skipping PRD #${prd.number}; PRD is ${prd.state}.`);
    return;
  }

  console.log(`Code Factory: building Implementation Sequence for PRD #${prd.number}.`);

  const subIssues = await github.getAttachedSubIssues(prd.number);
  const sequence = buildImplementationSequence(prd.number, subIssues);

  for (const issue of sequence.resolvedIssues) {
    console.log(`Code Factory: skipping Resolved Issue #${issue.number}.`);
  }

  if (sequence.openIssues.length === 0) {
    console.log(`Code Factory: PRD #${prd.number} has no open Implementation Issues.`);
    return;
  }

  const orderedIssues = sequence.openIssues
    .map((issue) => `#${issue.number} (${issue.kind})`)
    .join(", ");
  console.log(`Code Factory: Implementation Sequence for PRD #${prd.number}: ${orderedIssues}.`);
}

function isFactoryOwnedPrd(prd: GitHubIssue): boolean {
  return prd.author.login === FACTORY_OWNER;
}

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels.map((label) => label.name);
}

function hasMatchingParentSection(body: string, prdNumber: number): boolean {
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === "## Parent");

  if (startIndex === -1) {
    return false;
  }

  const sectionLines: string[] = [];

  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("## ")) {
      break;
    }

    sectionLines.push(line);
  }

  return new RegExp(String.raw`Parent PRD:\s*#${prdNumber}\b`).test(sectionLines.join("\n"));
}
