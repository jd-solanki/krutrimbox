import { spawn } from "node:child_process";
import { diagnostics } from "./diagnostics";

export const REQUIRED_LABELS = [
  {
    name: "krutrimbox",
    color: "5319E7",
    description: "Pull requests authored by krutrimbox"
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
  // The issue's GitHub assignees. krutrimbox routes work by assignee — an issue is
  // the Operator's to implement only when this list holds exactly the Operator
  // (ADR-0017, ADR-0018). Empty when nobody is assigned.
  assignees: Array<{
    login: string;
  }>;
  // The Target Issue this issue is attached to through GitHub's native sub-issue link
  // (REST `parent_issue_url` / GraphQL `parent`). Null for top-level issues such
  // as Target Issues, or when the issue was not fetched through the sub-issue relationship.
  parentNumber: number | null;
}

export interface GitHubClient {
  ensureRequiredLabels(): Promise<void>;
  // The current repository's canonical `owner/name` (e.g. `octocat/hello-world`).
  // Callers needing a repository-scoped key, such as the Target Issue Sandbox
  // name, build on this (ADR-0007).
  getRepositorySlug(): Promise<string>;
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  getIssueUrl(issueNumber: number): Promise<string>;
  // Open Target Issues (labeled `ready-for-agent`, no parent) assigned to the
  // Operator, via GitHub's `assignee:@me`. The default Batch Run discovery.
  listReadyTargetIssues(): Promise<GitHubIssue[]>;
  // Open Target Issues (labeled `ready-for-agent`, no parent) regardless of
  // assignee. Backs Batch Run discovery under the Implement-Unassigned Override,
  // where the caller keeps only the Operator's own and unassigned issues.
  listAllReadyTargetIssues(): Promise<GitHubIssue[]>;
  getAttachedSubIssues(targetIssueNumber: number): Promise<GitHubIssue[]>;
  listIssueComments(issueNumber: number): Promise<GitHubComment[]>;
  createIssueComment(issueNumber: number, body: string): Promise<GitHubComment>;
  updateIssueComment(commentId: string, body: string): Promise<GitHubComment>;
  getDefaultBranch(): Promise<string>;
  findPullRequestByHead(branchName: string): Promise<GitHubPullRequest | null>;
  listBranchCommitMessages(branchName: string): Promise<string[]>;
  createDraftPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest>;
  updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void>;
  setPullRequestLabels(pullRequestNumber: number, labels: string[]): Promise<void>;
  getAuthenticatedUser(): Promise<string>;
  markPullRequestReadyForReview(pullRequestNumber: number): Promise<void>;
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
  isDraft: boolean;
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

  // Every host GitHub call funnels through here, so it is the one place to turn a
  // raw `gh` child-process failure into a coded, operator-facing diagnostic. Left
  // unwrapped, a non-zero `gh` exit is an uncoded Error that the Expected/Unexpected
  // split reports as a likely krutrimbox bug (see lib/factory/failure.ts) and, for
  // pre-flight calls that run outside a Factory Run's diagnosed path, crashes with a
  // raw Node stack. gh runs on the host with the operator's own credentials, so the
  // cause is almost always their gh setup, not krutrimbox.
  function runGh(args: string[]): Promise<string> {
    return runner("gh", args).catch((error: unknown) => {
      throw diagnostics.KB_R0011({
        detail: commandFailureDetail("gh", args, error),
        guidance: ghFailureGuidance(error),
        cause: error
      });
    });
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
        "number,isDraft,labels"
      ])
    );

    const pullRequest = pullRequests[0];
    return pullRequest ? parsePullRequest(pullRequest) : null;
  }

  // Discovers open Target Issues for one assignee scope. `assigneeFilters` narrows
  // the GitHub issue search — `["assignee:@me"]` for the Operator's own issues, or
  // `[]` to include every assignee for the Implement-Unassigned Override. The
  // no-parent requirement is applied after the search, since GitHub issue search
  // cannot express the native sub-issue link (ADR-0014).
  async function searchReadyTargetIssues(assigneeFilters: string[]): Promise<GitHubIssue[]> {
    const repo = await getRepository();
    const filters = ["is:issue", "is:open", ...assigneeFilters, `label:${AFK_LABEL_NAME}`];
    const searchQuery = `repo:${formatRepository(repo)} ${filters.join(" ")}`;
    const response = parseJson<TargetIssuesGraphqlResponse>(
      await runGh(["api", "graphql", "-f", `query=${TARGET_ISSUES_QUERY}`, "-F", `queryString=${searchQuery}`])
    );

    return response.data.search.nodes
      .map(parseSearchIssue)
      .filter((issue) => issue.parentNumber === null)
      .sort((left, right) => left.number - right.number);
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

    async getRepositorySlug(): Promise<string> {
      return formatRepository(await getRepository());
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
            "number,title,body,state,author,labels,assignees"
          ])
        )
      );
    },

    async getIssueUrl(issueNumber: number): Promise<string> {
      const repo = await getRepository();
      return `https://github.com/${formatRepository(repo)}/issues/${issueNumber}`;
    },

    async listReadyTargetIssues(): Promise<GitHubIssue[]> {
      return searchReadyTargetIssues(["assignee:@me"]);
    },

    async listAllReadyTargetIssues(): Promise<GitHubIssue[]> {
      return searchReadyTargetIssues([]);
    },

    async getAttachedSubIssues(targetIssueNumber: number): Promise<GitHubIssue[]> {
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
          `number=${targetIssueNumber}`
        ])
      );

      return response.data.repository.issue.subIssues.nodes.map(parseGraphqlIssue);
    },

    async listIssueComments(issueNumber: number): Promise<GitHubComment[]> {
      const repo = await getRepository();
      const comments = parseJson<RawComment[]>(
        await runGh(["api", issueCommentsPath(repo, issueNumber)])
      );

      return comments.map((comment) => parseComment(comment, issueUrl(repo, issueNumber)));
    },

    async createIssueComment(issueNumber: number, body: string): Promise<GitHubComment> {
      const repo = await getRepository();

      const comment = parseJson<RawComment>(
        await runGh(["api", issueCommentsPath(repo, issueNumber), "-f", `body=${body}`])
      );

      return parseComment(comment, issueUrl(repo, issueNumber));
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

      return parseComment(comment, issueCommentUrl(repo, commentId));
    },

    async getDefaultBranch(): Promise<string> {
      const response = parseJson<{ defaultBranchRef: { name: string } }>(
        await runGh(["repo", "view", "--json", "defaultBranchRef"])
      );

      return response.defaultBranchRef.name;
    },

    findPullRequestByHead,

    async listBranchCommitMessages(branchName: string): Promise<string[]> {
      const repo = await getRepository();

      try {
        const commits = parseJson<RawCommit[]>(
          await runGh([
            "api",
            `repos/${repo.owner.login}/${repo.name}/commits`,
            "--method",
            "GET",
            "--paginate",
            "-f",
            `sha=${branchName}`
          ])
        );

        return commits.map((commit) => commit.commit.message ?? "");
      } catch (error) {
        if (isMissingBranchError(error)) {
          return [];
        }

        throw error;
      }
    },

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
        throw diagnostics.KB_R0004({ head: input.head });
      }

      return pullRequest;
    },

    async updatePullRequestBody(pullRequestNumber: number, body: string): Promise<void> {
      await runGh(["pr", "edit", String(pullRequestNumber), "--body", body]);
    },

    async setPullRequestLabels(pullRequestNumber: number, labels: string[]): Promise<void> {
      const current = parsePullRequest(
        parseJson<RawPullRequest>(
          await runGh(["pr", "view", String(pullRequestNumber), "--json", "number,isDraft,labels"])
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

    async markPullRequestReadyForReview(pullRequestNumber: number): Promise<void> {
      await runGh(["pr", "ready", String(pullRequestNumber)]);
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

        const commandText = formatCommandLine(command, args);
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        const error: CommandFailure = new Error(
          [`Command failed with ${reason}: ${commandText}`, stderrText].filter(Boolean).join("\n")
        );
        // Carry the child's captured streams on the error so a caller can classify
        // the failure by what the command actually printed. The message already
        // includes stderr; `stdout` is otherwise lost on a non-zero exit, yet it is
        // where an agent CLI streams its own notices (e.g. a transient provider
        // API error). See `commandFailureOutput` and KB_R0013.
        error.stdout = stdoutText;
        error.stderr = stderrText;
        reject(error);
      });
    });
}

// A failed command's Error, augmented by the default runner with the child's
// captured output. The message already carries stderr; these expose both streams
// verbatim so a caller can classify the failure by what the command printed
// without re-running it (see `commandFailureOutput`).
export interface CommandFailure extends Error {
  stdout?: string;
  stderr?: string;
}

// The full text a failed command emitted, as one string to scan when classifying
// the failure: its message (which carries stderr) plus any captured stdout. A
// custom runner that attaches no output still contributes its message.
export function commandFailureOutput(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return [error.message, (error as CommandFailure).stdout].filter(Boolean).join("\n");
}

// The command line plus the failure's own message (which, from the default runner,
// already carries the child's stderr). Prefixes the command only when the message
// does not already include it, so a custom runner's error still names what failed.
// Shared by the `gh` (runGh) and host-`git` (hostGit) failure wraps.
export function commandFailureDetail(command: string, args: string[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const commandLine = formatCommandLine(command, args);
  return message.includes(commandLine) ? message : `${commandLine}\n${message}`;
}

// The longest a single argument may be before it is elided from an echoed command
// line. In practice the only argument that ever exceeds this is the multi-KB agent
// prompt passed to `claude -p`: echoed verbatim it buried the exit reason under the
// whole prompt in the run log's FAILURE block (and the issue comment's tail). The
// threshold is generous enough that every real flag and path survives untouched.
const MAX_ECHOED_ARG_LENGTH = 200;

// Renders a command and its arguments as a single line for a failure message,
// replacing any over-length argument with a short placeholder so the message stays
// readable. Kept the one place both the default runner's error and
// `commandFailureDetail`'s `includes` check derive their command line, so the two
// always agree on how a command is spelled.
function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args.map(elideLongArg)].join(" ");
}

function elideLongArg(arg: string): string {
  return arg.length > MAX_ECHOED_ARG_LENGTH ? `<${arg.length}-char argument elided>` : arg;
}

// Turns a `gh` failure into a remedy aimed at the most likely cause. The signals
// are read from gh's stderr text, most-specific first:
// - GitHub masks "you can see this repo but cannot write to it" as 404 (and denies
//   other writes with 403). With multiple `gh` accounts this usually means the
//   wrong account is active for the repository's owner — the common real case.
// - a connectivity failure, or missing host authentication entirely.
// Anything unrecognized falls back to "run the command yourself and check auth".
function ghFailureGuidance(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (/http 40[34]|not found|forbidden|resource not accessible|must have admin/.test(text)) {
    return "The active `gh` account likely lacks write access to this repository — GitHub reports that as HTTP 404/403. Run `gh auth status` to see which account is active, switch with `gh auth switch` if it is the wrong one, and confirm that account can write to the repo. krutrimbox performs every GitHub write on the host with your `gh` credentials.";
  }

  if (/could not resolve host|network is unreachable|timeout|dial tcp|connection refused|no such host/.test(text)) {
    return "Check your network connection and that api.github.com is reachable, then re-run.";
  }

  if (/gh auth login|not logged in|bad credentials|http 401/.test(text)) {
    return "Authenticate the GitHub CLI on the host with `gh auth login` using a write-capable account, then re-run.";
  }

  return "Run the failed `gh` command yourself to see the underlying error, then check `gh auth status` — the active account needs write access to this repository — and your network. krutrimbox performs every GitHub write on the host with your `gh` credentials.";
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
  assignees?: Array<{
    login: string;
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
  isDraft?: boolean;
  labels: Array<{
    name: string;
  }>;
}

interface RawCommit {
  commit: {
    message?: string;
  };
}

interface TargetIssuesGraphqlResponse {
  data: {
    search: {
      nodes: RawGraphqlSearchNode[];
    };
  };
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
  assignees: {
    nodes: Array<{
      login: string;
    }>;
  };
  parent: {
    number: number;
  } | null;
}

type RawGraphqlSearchNode = RawGraphqlIssue & {
  __typename: string;
};

const AFK_LABEL_NAME = "ready-for-agent";

const TARGET_ISSUES_QUERY = `
query($queryString: String!) {
  search(type: ISSUE, query: $queryString, first: 100) {
    nodes {
      ... on Issue {
        __typename
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
        assignees(first: 10) {
          nodes {
            login
          }
        }
        parent {
          number
        }
      }
    }
  }
}`;

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
    assignees: (issue.assignees ?? []).map((assignee) => ({ login: assignee.login })),
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
    assignees: issue.assignees.nodes.map((assignee) => ({ login: assignee.login })),
    parentNumber: issue.parent?.number ?? null
  };
}

function parseSearchIssue(issue: RawGraphqlSearchNode): GitHubIssue {
  if (issue.__typename !== "Issue") {
    throw diagnostics.KB_R0005({ typename: issue.__typename });
  }

  return parseGraphqlIssue(issue);
}

function parsePullRequest(pullRequest: RawPullRequest): GitHubPullRequest {
  return {
    number: pullRequest.number,
    isDraft: pullRequest.isDraft ?? false,
    labels: pullRequest.labels.map((label) => ({ name: label.name }))
  };
}

function parseComment(comment: RawComment, fallbackUrl: string): GitHubComment {
  return {
    id: String(comment.id),
    body: comment.body ?? "",
    url: comment.html_url ?? fallbackUrl
  };
}

function issueCommentsPath(repo: RepositoryInfo, issueNumber: number): string {
  return `repos/${repo.owner.login}/${repo.name}/issues/${issueNumber}/comments`;
}

function issueUrl(repo: RepositoryInfo, issueNumber: number): string {
  return `https://github.com/${formatRepository(repo)}/issues/${issueNumber}`;
}

function issueCommentUrl(repo: RepositoryInfo, commentId: string): string {
  return `https://github.com/${formatRepository(repo)}/issues/comments/${commentId}`;
}

function formatRepository(repo: RepositoryInfo): string {
  return `${repo.owner.login}/${repo.name}`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isMissingBranchError(error: unknown): boolean {
  return error instanceof Error && /No commit found for SHA|Not Found|404/.test(error.message);
}
