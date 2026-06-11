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
  listIssueComments(issueNumber: number): Promise<GitHubComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<void>;
  updateIssueComment(commentId: string, body: string): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  getDefaultBranch(): Promise<string>;
  findPullRequestByHead(branchName: string): Promise<GitHubPullRequest | null>;
  createDraftPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  setPullRequestLabels(pullRequestNumber: number, labels: string[]): Promise<void>;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<string>;
}

export interface GitHubComment {
  id: string;
  body: string;
}

export interface GitHubPullRequest {
  number: number;
  labels: Array<{
    name: string;
  }>;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  head: string;
  base: string;
  labels: string[];
}

export class GitHubCliClient implements GitHubClient {
  private repository: RepositoryInfo | null = null;

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
    const repo = await this.getRepository();
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

  public async listIssueComments(issueNumber: number): Promise<GitHubComment[]> {
    const repo = await this.getRepository();
    const comments = parseJson<RawComment[]>(
      await this.runGh([
        "api",
        `repos/${repo.owner.login}/${repo.name}/issues/${issueNumber}/comments`
      ])
    );

    return comments.map((comment) => ({
      id: String(comment.id),
      body: comment.body ?? ""
    }));
  }

  public async createIssueComment(issueNumber: number, body: string): Promise<void> {
    const repo = await this.getRepository();

    await this.runGh([
      "api",
      `repos/${repo.owner.login}/${repo.name}/issues/${issueNumber}/comments`,
      "-f",
      `body=${body}`
    ]);
  }

  public async updateIssueComment(commentId: string, body: string): Promise<void> {
    const repo = await this.getRepository();

    await this.runGh([
      "api",
      `repos/${repo.owner.login}/${repo.name}/issues/comments/${commentId}`,
      "-X",
      "PATCH",
      "-f",
      `body=${body}`
    ]);
  }

  public async closeIssue(issueNumber: number): Promise<void> {
    await this.runGh(["issue", "close", String(issueNumber)]);
  }

  public async getDefaultBranch(): Promise<string> {
    const response = parseJson<{ defaultBranchRef: { name: string } }>(
      await this.runGh(["repo", "view", "--json", "defaultBranchRef"])
    );

    return response.defaultBranchRef.name;
  }

  public async findPullRequestByHead(branchName: string): Promise<GitHubPullRequest | null> {
    const pullRequests = parseJson<RawPullRequest[]>(
      await this.runGh([
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        branchName,
        "--limit",
        "10",
        "--json",
        "number,labels"
      ])
    );

    const pullRequest = pullRequests[0];
    return pullRequest ? parsePullRequest(pullRequest) : null;
  }

  public async createDraftPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    const args = [
      "pr",
      "create",
      "--draft",
      "--title",
      input.title,
      "--body",
      input.body,
      "--base",
      input.base,
      "--head",
      input.head
    ];

    for (const label of input.labels) {
      args.push("--label", label);
    }

    await this.runGh(args);

    const pullRequest = await this.findPullRequestByHead(input.head);

    if (!pullRequest) {
      throw new Error(`Created Pull Request for ${input.head}, but could not find it by head.`);
    }

    return pullRequest;
  }

  public async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
    await this.runGh(["pr", "edit", String(pullRequestNumber), "--body", body]);
  }

  public async setPullRequestLabels(pullRequestNumber: number, labels: string[]): Promise<void> {
    const current = parsePullRequest(
      parseJson<RawPullRequest>(
        await this.runGh(["pr", "view", String(pullRequestNumber), "--json", "number,labels"])
      )
    );
    const desired = new Set(labels);
    const args = ["pr", "edit", String(pullRequestNumber)];

    for (const label of labels) {
      args.push("--add-label", label);
    }

    for (const label of current.labels) {
      if (!desired.has(label.name)) {
        args.push("--remove-label", label.name);
      }
    }

    await this.runGh(args);
  }

  private async runGh(args: string[]): Promise<string> {
    return this.runner.run("gh", args);
  }

  private async getRepository(): Promise<RepositoryInfo> {
    this.repository ??= parseJson<RepositoryInfo>(
      await this.runGh(["repo", "view", "--json", "owner,name"])
    );

    return this.repository;
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

interface RepositoryInfo {
  owner: {
    login: string;
  };
  name: string;
}

interface RawComment {
  id: number | string;
  body?: string;
}

interface RawPullRequest {
  number: number;
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

function parsePullRequest(pullRequest: RawPullRequest): GitHubPullRequest {
  return {
    number: pullRequest.number,
    labels: pullRequest.labels.map((label) => ({ name: label.name }))
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
