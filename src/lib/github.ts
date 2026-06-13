import { spawn } from "node:child_process";

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
  // The PRD this issue is attached to through GitHub's native sub-issue link
  // (REST `parent_issue_url` / GraphQL `parent`). Null for top-level issues such
  // as PRDs, or when the issue was not fetched through the sub-issue relationship.
  parentNumber: number | null;
}

export interface GitHubClient {
  ensureRequiredLabels(): Promise<void>;
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  getIssueUrl(issueNumber: number): Promise<string>;
  listReadyPrds(author: string): Promise<GitHubIssue[]>;
  getAttachedSubIssues(prdNumber: number): Promise<GitHubIssue[]>;
  listIssueComments(issueNumber: number): Promise<GitHubComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<GitHubComment>;
  updateIssueComment(commentId: string, body: string): Promise<GitHubComment>;
  closeIssue(issueNumber: number): Promise<void>;
  getDefaultBranch(): Promise<string>;
  findPullRequestByHead(branchName: string): Promise<GitHubPullRequest | null>;
  createDraftPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  setPullRequestLabels(pullRequestNumber: number, labels: string[]): Promise<void>;
  getAuthenticatedUser(): Promise<string>;
  getPullRequestDiff(pullRequestNumber: number): Promise<string>;
  markPullRequestReadyForReview(pullRequestNumber: number): Promise<void>;
  requestPullRequestReview(pullRequestNumber: number, reviewer: string): Promise<void>;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunOptions
) => Promise<string>;

export interface CommandRunOptions {
  // Destination for the child's stdout+stderr as it streams. When omitted the
  // output is still captured for the return value but forwarded nowhere.
  output?: NodeJS.WritableStream;
}

export interface GitHubComment {
  id: string;
  body: string;
  url: string;
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

export function createGitHubCliClient(
  runner: CommandRunner = createExecFileCommandRunner()
): GitHubClient {
  let repository: RepositoryInfo | null = null;

  function runGh(args: string[]): Promise<string> {
    return runner("gh", args);
  }

  async function getRepository(): Promise<RepositoryInfo> {
    // Resolve once and pass `--repo` explicitly on issue commands: after a repo
    // rename, gh's implicit issue context can follow stale git remote metadata
    // even when `gh repo view` resolves the canonical repository.
    repository ??= parseJson<RepositoryInfo>(
      await runGh(["repo", "view", "--json", "owner,name"])
    );

    return repository;
  }

  async function findPullRequestByHead(branchName: string): Promise<GitHubPullRequest | null> {
    const pullRequests = parseJson<RawPullRequest[]>(
      await runGh([
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

  return {
    async ensureRequiredLabels(): Promise<void> {
      const existingLabels = parseJson<Array<{ name: string }>>(
        await runGh(["label", "list", "--limit", "200", "--json", "name"])
      );
      const existingNames = new Set(existingLabels.map((label) => label.name));

      for (const label of REQUIRED_LABELS) {
        if (existingNames.has(label.name)) {
          continue;
        }

        await runGh([
          "label",
          "create",
          label.name,
          "--color",
          label.color,
          "--description",
          label.description
        ]);
      }
    },

    async getIssue(issueNumber: number): Promise<GitHubIssue> {
      const repo = await getRepository();

      return parseIssue(
        parseJson<RawGhIssue>(
          await runGh([
            "issue",
            "view",
            String(issueNumber),
            "--repo",
            formatRepository(repo),
            "--json",
            "number,title,body,state,author,labels"
          ])
        )
      );
    },

    async getIssueUrl(issueNumber: number): Promise<string> {
      const repo = await getRepository();
      return `https://github.com/${formatRepository(repo)}/issues/${issueNumber}`;
    },

    async listReadyPrds(author: string): Promise<GitHubIssue[]> {
      const repo = await getRepository();
      const issues = parseJson<RawGhIssue[]>(
        await runGh([
          "issue",
          "list",
          "--repo",
          formatRepository(repo),
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

      return issues
        .map(parseIssue)
        .sort((left, right) => left.number - right.number);
    },

    async getAttachedSubIssues(prdNumber: number): Promise<GitHubIssue[]> {
      const repo = await getRepository();
      const response = parseJson<SubIssuesGraphqlResponse>(
        await runGh([
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
    },

    async listIssueComments(issueNumber: number): Promise<GitHubComment[]> {
      const repo = await getRepository();
      const comments = parseJson<RawComment[]>(
        await runGh([
          "api",
          `repos/${repo.owner.login}/${repo.name}/issues/${issueNumber}/comments`
        ])
      );

      return comments.map((comment) => ({
        id: String(comment.id),
        body: comment.body ?? "",
        url: comment.html_url ?? `https://github.com/${formatRepository(repo)}/issues/${issueNumber}`
      }));
    },

    async createIssueComment(issueNumber: number, body: string): Promise<GitHubComment> {
      const repo = await getRepository();

      const comment = parseJson<RawComment>(
        await runGh([
          "api",
          `repos/${repo.owner.login}/${repo.name}/issues/${issueNumber}/comments`,
          "-f",
          `body=${body}`
        ])
      );

      return {
        id: String(comment.id),
        body: comment.body ?? "",
        url: comment.html_url ?? `https://github.com/${formatRepository(repo)}/issues/${issueNumber}`
      };
    },

    async updateIssueComment(commentId: string, body: string): Promise<GitHubComment> {
      const repo = await getRepository();

      const comment = parseJson<RawComment>(
        await runGh([
          "api",
          `repos/${repo.owner.login}/${repo.name}/issues/comments/${commentId}`,
          "-X",
          "PATCH",
          "-f",
          `body=${body}`
        ])
      );

      return {
        id: String(comment.id),
        body: comment.body ?? "",
        url: comment.html_url ?? `https://github.com/${formatRepository(repo)}/issues/comments/${commentId}`
      };
    },

    async closeIssue(issueNumber: number): Promise<void> {
      await runGh(["issue", "close", String(issueNumber)]);
    },

    async getDefaultBranch(): Promise<string> {
      const response = parseJson<{ defaultBranchRef: { name: string } }>(
        await runGh(["repo", "view", "--json", "defaultBranchRef"])
      );

      return response.defaultBranchRef.name;
    },

    findPullRequestByHead,

    async createDraftPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
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

      await runGh(args);

      const pullRequest = await findPullRequestByHead(input.head);

      if (!pullRequest) {
        throw new Error(`Created Pull Request for ${input.head}, but could not find it by head.`);
      }

      return pullRequest;
    },

    async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
      await runGh(["pr", "edit", String(pullRequestNumber), "--body", body]);
    },

    async setPullRequestLabels(pullRequestNumber: number, labels: string[]): Promise<void> {
      const current = parsePullRequest(
        parseJson<RawPullRequest>(
          await runGh(["pr", "view", String(pullRequestNumber), "--json", "number,labels"])
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

      await runGh(args);
    },

    async getAuthenticatedUser(): Promise<string> {
      const response = parseJson<{ login: string }>(await runGh(["api", "/user"]));
      return response.login;
    },

    async getPullRequestDiff(pullRequestNumber: number): Promise<string> {
      return runGh(["pr", "diff", String(pullRequestNumber)]);
    },

    async markPullRequestReadyForReview(pullRequestNumber: number): Promise<void> {
      await runGh(["pr", "ready", String(pullRequestNumber)]);
    },

    async requestPullRequestReview(pullRequestNumber: number, reviewer: string): Promise<void> {
      await runGh(["pr", "edit", String(pullRequestNumber), "--add-reviewer", reviewer]);
    }
  };
}

export function createExecFileCommandRunner(): CommandRunner {
  return (command, args, options = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.output?.write(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.output?.write(chunk);
      });

      child.on("error", reject);
      child.on("close", (code, signal) => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");

        if (code === 0) {
          resolve(stdoutText);
          return;
        }

        const commandText = [command, ...args].join(" ");
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        const error = new Error(
          [`Command failed with ${reason}: ${commandText}`, stderrText].filter(Boolean).join("\n")
        );
        reject(error);
      });
    });
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
  html_url?: string;
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
  parent: {
    number: number;
  } | null;
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
          parent {
            number
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
    labels: issue.labels.map((label) => ({ name: label.name })),
    // `gh issue view`/`issue list` do not return the sub-issue parent link; the
    // parent is read natively when an issue is fetched via getAttachedSubIssues.
    parentNumber: null
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
    labels: issue.labels.nodes.map((label) => ({ name: label.name })),
    parentNumber: issue.parent?.number ?? null
  };
}

function parsePullRequest(pullRequest: RawPullRequest): GitHubPullRequest {
  return {
    number: pullRequest.number,
    labels: pullRequest.labels.map((label) => ({ name: label.name }))
  };
}

function formatRepository(repo: RepositoryInfo): string {
  return `${repo.owner.login}/${repo.name}`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
