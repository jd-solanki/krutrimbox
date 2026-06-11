import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REQUIRED_LABELS = [
  {
    name: "PRD",
    color: "FEF2C0",
    description: "This issue has a PRD attached"
  },
  {
    name: "ready-for-agent",
    color: "C2E0C6",
    description: "Fully specified, ready for an AFK agent"
  },
  {
    name: "ready-for-human",
    color: "1D76DB",
    description: "Requires human implementation"
  }
] as const;

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  author: {
    login: string;
  };
  labels: Array<{
    name: string;
  }>;
}

export interface GitHubClient {
  ensureRequiredLabels(): Promise<void>;
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  listReadyPrds(author: string): Promise<GitHubIssue[]>;
  getAttachedSubIssues(prdNumber: number): Promise<GitHubIssue[]>;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

export class GitHubCliClient implements GitHubClient {
  public constructor(private readonly runner: CommandRunner = new ExecFileCommandRunner()) {}

  public async ensureRequiredLabels(): Promise<void> {
    const existingLabels = parseJson<Array<{ name: string }>>(
      await this.runGh(["label", "list", "--limit", "200", "--json", "name"])
    );
    const existingNames = new Set(existingLabels.map((label) => label.name));

    for (const label of REQUIRED_LABELS) {
      if (existingNames.has(label.name)) {
        continue;
      }

      await this.runGh([
        "label",
        "create",
        label.name,
        "--color",
        label.color,
        "--description",
        label.description
      ]);
    }
  }

  public async getIssue(issueNumber: number): Promise<GitHubIssue> {
    return parseIssue(
      parseJson<RawGhIssue>(
        await this.runGh([
          "issue",
          "view",
          String(issueNumber),
          "--json",
          "number,title,body,state,author,labels"
        ])
      )
    );
  }

  public async listReadyPrds(author: string): Promise<GitHubIssue[]> {
    const issues = parseJson<RawGhIssue[]>(
      await this.runGh([
        "issue",
        "list",
        "--state",
        "open",
        "--author",
        author,
        "--label",
        "PRD",
        "--label",
        "ready-for-agent",
        "--limit",
        "100",
        "--json",
        "number,title,body,state,author,labels"
      ])
    );

    return issues.map(parseIssue).sort((left, right) => left.number - right.number);
  }

  public async getAttachedSubIssues(prdNumber: number): Promise<GitHubIssue[]> {
    const repo = parseJson<{ owner: { login: string }; name: string }>(
      await this.runGh(["repo", "view", "--json", "owner,name"])
    );
    const response = parseJson<SubIssuesGraphqlResponse>(
      await this.runGh([
        "api",
        "graphql",
        "-f",
        `query=${SUB_ISSUES_QUERY}`,
        "-F",
        `owner=${repo.owner.login}`,
        "-F",
        `repo=${repo.name}`,
        "-F",
        `number=${prdNumber}`
      ])
    );

    return response.data.repository.issue.subIssues.nodes.map(parseGraphqlIssue);
  }

  private async runGh(args: string[]): Promise<string> {
    return this.runner.run("gh", args);
  }
}

export class ExecFileCommandRunner implements CommandRunner {
  public async run(command: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024
    });

    return stdout;
  }
}

interface RawGhIssue {
  number: number;
  title: string;
  body?: string;
  state: "OPEN" | "CLOSED";
  author: {
    login: string;
  };
  labels: Array<{
    name: string;
  }>;
}

interface SubIssuesGraphqlResponse {
  data: {
    repository: {
      issue: {
        subIssues: {
          nodes: RawGraphqlIssue[];
        };
      };
    };
  };
}

interface RawGraphqlIssue {
  number: number;
  title: string;
  body?: string;
  state: "OPEN" | "CLOSED";
  author: {
    login: string;
  } | null;
  labels: {
    nodes: Array<{
      name: string;
    }>;
  };
}

const SUB_ISSUES_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      subIssues(first: 100) {
        nodes {
          number
          title
          body
          state
          author {
            login
          }
          labels(first: 100) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
}`;

function parseIssue(issue: RawGhIssue): GitHubIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    author: {
      login: issue.author.login
    },
    labels: issue.labels.map((label) => ({ name: label.name }))
  };
}

function parseGraphqlIssue(issue: RawGraphqlIssue): GitHubIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    author: {
      login: issue.author?.login ?? ""
    },
    labels: issue.labels.nodes.map((label) => ({ name: label.name }))
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
