import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildImplementationSequence,
  createCodeFactory,
  deterministicPrdBranch,
  deterministicPrdSandbox,
  parseBlockingIssueNumbers,
  type PrdLock,
  type PrdLockStore,
  type SandboxRunner,
  type TemplateRenderer
} from "../src/factory.js";
import type {
  CreatePullRequestInput,
  GitHubClient,
  GitHubComment,
  GitHubIssue,
  GitHubPullRequest
} from "../src/github.js";

describe("buildImplementationSequence", () => {
  test("validates, orders, and skips resolved Implementation Issues", () => {
    const sequence = buildImplementationSequence(1, [
      implementationIssue({
        number: 5,
        title: "Human input",
        labels: ["PRD-sub-issue", "ready-for-human"]
      }),
      implementationIssue({
        number: 3,
        title: "Bootstrap",
        state: "CLOSED",
        labels: ["PRD-sub-issue"]
      }),
      implementationIssue({
        number: 4,
        title: "Discovery",
        labels: ["PRD-sub-issue", "ready-for-agent"]
      }),
      implementationIssue({
        number: 6,
        title: "Wrong parent",
        parentNumber: 2,
        labels: ["PRD-sub-issue", "ready-for-agent"]
      }),
      implementationIssue({
        number: 7,
        title: "Not an implementation issue",
        labels: ["ready-for-agent"]
      })
    ]);

    expect(sequence.openIssues.map((issue) => [issue.number, issue.kind])).toEqual([
      [4, "afk"],
      [5, "hitl"]
    ]);
    expect(sequence.resolvedIssues.map((issue) => issue.number)).toEqual([3]);
  });

  test("rejects open Implementation Issues without exactly one state label", () => {
    expect(() =>
      buildImplementationSequence(1, [
        implementationIssue({
          number: 8,
          labels: ["PRD-sub-issue", "ready-for-agent", "ready-for-human"]
        })
      ])
    ).toThrow(
      "Implementation Issue #8 must have exactly one open state label: ready-for-agent or ready-for-human."
    );
  });
});

describe("parseBlockingIssueNumbers", () => {
  test("extracts unique blocker numbers from the Blocked by section only", () => {
    expect(
      parseBlockingIssueNumbers(
        "See #99 elsewhere.\n\n## Blocked by\n\n- #3\n- #7 and #3\n\n## Notes\n\n#12"
      )
    ).toEqual([3, 7]);
  });
});

describe("createCodeFactory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("explicit runs skip PRDs not authored by the factory owner", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ author: "someone-else" })]
    });
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await factory.runExplicit(1);

    expect(github.ensureRequiredLabels).toHaveBeenCalledOnce();
    expect(github.getIssue).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "Code Factory: skipping PRD #1; author someone-else is not jd-solanki."
    );
  });

  test("skips an already locked PRD before reading sub-issues", async () => {
    const github = new FakeGitHubClient({ prds: [prdIssue()] });
    const lockStore = new FakeLockStore({ locked: true });
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore,
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(lockStore.acquire).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).not.toHaveBeenCalled();
  });

  test("updates an idempotent HITL pause comment and does not create a sandbox", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Human checkpoint",
              labels: ["PRD-sub-issue", "ready-for-human"]
            })
          ]
        ]
      ]),
      comments: new Map([
        [
          1,
          [
            {
              id: "100",
              body: "<!-- code-factory:hitl-prd-1-issue-4 -->\nold body"
            }
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = createCodeFactory({
      github,
      sandbox,
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("@jd-solanki Code Factory is paused for PRD #1.")
    );
    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("posts an AFK error comment when a blocking issue is unresolved", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      issues: [
        blockerIssue({
          number: 3,
          title: "Discover PRDs",
          state: "OPEN"
        })
      ],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              body: "## Parent\n\nParent PRD: #1\n\n## Blocked by\n\n- #3",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = createCodeFactory({
      github,
      sandbox,
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.createIssueComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("#3 - Discover PRDs (OPEN)")
    );
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("runs an AFK issue through sandbox, commit, PR maintenance, and issue closure", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ body: "Full parent PRD body" })],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 3,
              title: "Bootstrap",
              state: "CLOSED",
              labels: ["PRD-sub-issue"]
            }),
            implementationIssue({
              number: 4,
              title: "Factory loop",
              body: "## Parent\n\nParent PRD: #1\n\nCurrent issue body",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            }),
            implementationIssue({
              number: 5,
              title: "Final review",
              body: "## Parent\n\nParent PRD: #1\n\n## Blocked by\n\n- #4",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = createCodeFactory({
      github,
      sandbox,
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(sandbox.calls.map((call) => call.name)).toEqual([
      "ensureSandbox",
      "checkoutBranch",
      "runAfkIssue",
      "commitAndPush",
      "ensureSandbox",
      "checkoutBranch",
      "runAfkIssue",
      "commitAndPush",
      "ensureSandbox",
      "runFinalReview",
      "removeSandbox"
    ]);
    expect(sandbox.calls[0].input).toEqual({ sandboxName: "code-factory-prd-1" });
    expect(sandbox.calls[1].input).toEqual({
      sandboxName: "code-factory-prd-1",
      branchName: "code-factory/prd-1"
    });
    expect(String(sandbox.calls[2].input.prompt)).toContain("Full parent PRD body");
    expect(String(sandbox.calls[2].input.prompt)).toContain("Current issue body");
    expect(String(sandbox.calls[2].input.prompt)).toContain("- #3 - Bootstrap (CLOSED)");
    expect(String(sandbox.calls[2].input.prompt)).toContain(
      "- #5 - Final review (afk, blocked by #4)"
    );
    expect(String(sandbox.calls[2].input.prompt)).toContain(
      "Do not create commits or push branches."
    );
    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "Code Factory PRD #1: PRD: Code Factory MVP",
      body: expect.stringContaining("- [x] #4 - Factory loop"),
      head: "code-factory/prd-1",
      base: "main",
      labels: ["PRD"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #3 - Bootstrap");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #4 - Factory loop");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #5 - Final review");
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(10, ["PRD"]);
    expect(github.closeIssue).toHaveBeenCalledWith(4);
    expect(github.closeIssue).toHaveBeenCalledWith(5);
  });

  test("reuses an existing PRD Pull Request by deterministic branch", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 12, labels: [{ name: "PRD" }, { name: "extra" }] }],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.createDraftPullRequest).not.toHaveBeenCalled();
    expect(github.updatePullRequestBody).toHaveBeenCalledWith(
      12,
      expect.stringContaining("Branch: `code-factory/prd-1`")
    );
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(12, ["PRD"]);
  });

  test("runs final review when all Implementation Issues are already resolved at run start", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ body: "Full PRD body" })],
      pullRequests: [{ number: 10, labels: [{ name: "PRD" }] }],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({ number: 3, title: "Bootstrap", state: "CLOSED", labels: ["PRD-sub-issue"] }),
            implementationIssue({ number: 4, title: "Factory loop", state: "CLOSED", labels: ["PRD-sub-issue"] })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = createCodeFactory({
      github,
      sandbox,
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(sandbox.calls.map((call) => call.name)).toEqual([
      "ensureSandbox",
      "runFinalReview",
      "removeSandbox"
    ]);
    const reviewCall = sandbox.calls.find((call) => call.name === "runFinalReview");
    expect(String(reviewCall?.input.prompt)).toContain("Full PRD body");
    expect(String(reviewCall?.input.prompt)).toContain("- #3 - Bootstrap (CLOSED)");
    expect(String(reviewCall?.input.prompt)).toContain("- #4 - Factory loop (CLOSED)");
    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    expect(github.requestPullRequestReview).toHaveBeenCalledWith(10, "jd-solanki");
    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: "code-factory-prd-1" });
  });

  test("updates an existing final review comment idempotently", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, labels: [{ name: "PRD" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, title: "Bootstrap", state: "CLOSED", labels: ["PRD-sub-issue"] })]]
      ]),
      comments: new Map([
        [10, [{ id: "200", body: "<!-- code-factory:final-review-prd-1 -->\nold review" }]]
      ])
    });
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "200",
      expect.stringContaining("<!-- code-factory:final-review-prd-1 -->")
    );
    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      10,
      expect.stringContaining("<!-- code-factory:final-review-prd-1 -->")
    );
  });

  test("requests review from PRD Author when they differ from PR Author", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ author: "jd-solanki" })],
      pullRequests: [{ number: 10, labels: [{ name: "PRD" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, state: "CLOSED", labels: ["PRD-sub-issue"] })]]
      ])
    });
    github.getAuthenticatedUser.mockResolvedValue("factory-bot");
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.requestPullRequestReview).toHaveBeenCalledWith(10, "jd-solanki");
    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      10,
      expect.stringContaining("@jd-solanki")
    );
  });

  test("tags PRD Author in a comment instead of requesting self-review when authors match", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ author: "jd-solanki" })],
      pullRequests: [{ number: 10, labels: [{ name: "PRD" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, state: "CLOSED", labels: ["PRD-sub-issue"] })]]
      ])
    });
    github.getAuthenticatedUser.mockResolvedValue("jd-solanki");
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.requestPullRequestReview).not.toHaveBeenCalled();
    expect(github.createIssueComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("@jd-solanki")
    );
  });

  test("removes the PRD Sandbox after final review routing succeeds", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, labels: [{ name: "PRD" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, state: "CLOSED", labels: ["PRD-sub-issue"] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = createCodeFactory({
      github,
      sandbox,
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: "code-factory-prd-1" });
  });

  test("never merges the PRD Pull Request during final review routing", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, labels: [{ name: "PRD" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, state: "CLOSED", labels: ["PRD-sub-issue"] })]]
      ])
    });
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(github.markPullRequestReadyForReview).toHaveBeenCalledOnce();
    expect("mergePullRequest" in github).toBe(false);
  });

  test("skips final review when no PRD Pull Request exists", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, state: "CLOSED", labels: ["PRD-sub-issue"] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = createCodeFactory({
      github,
      sandbox,
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runExplicit(1);

    expect(sandbox.runFinalReview).not.toHaveBeenCalled();
    expect(github.markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  test("batch runs continue after a PRD-local HITL pause", async () => {
    const firstPrd = prdIssue({ number: 1 });
    const secondPrd = prdIssue({ number: 2 });
    const github = new FakeGitHubClient({
      prds: [firstPrd, secondPrd],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              labels: ["PRD-sub-issue", "ready-for-human"]
            })
          ]
        ],
        [
          2,
          [
            implementationIssue({
              number: 5,
              parentNumber: 2,
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const factory = createCodeFactory({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: new FakeLockStore(),
      templates: new FixtureTemplates()
    });

    await factory.runBatch();

    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(2);
    expect(github.createIssueComment).toHaveBeenCalledWith(
      1,
      expect.stringContaining("Code Factory is paused for PRD #1.")
    );
    expect(github.closeIssue).toHaveBeenCalledWith(5);
  });
});

class FakeGitHubClient implements GitHubClient {
  public readonly ensureRequiredLabels = vi.fn(async () => undefined);
  public readonly getIssue = vi.fn(async (issueNumber: number) => {
    const issue = this.issues.get(issueNumber);

    if (!issue) {
      throw new Error(`No issue fixture for #${issueNumber}`);
    }

    return issue;
  });
  public readonly listReadyPrds = vi.fn(async () => this.prds);
  public readonly getAttachedSubIssues = vi.fn(async (prdNumber: number) => {
    return this.subIssuesByPrd.get(prdNumber) ?? [];
  });
  public readonly listIssueComments = vi.fn(async (issueNumber: number) => {
    return this.comments.get(issueNumber) ?? [];
  });
  public readonly createIssueComment = vi.fn(async (issueNumber: number, body: string) => {
    const comments = this.comments.get(issueNumber) ?? [];
    comments.push({ id: String(comments.length + 1), body });
    this.comments.set(issueNumber, comments);
  });
  public readonly updateIssueComment = vi.fn(async (commentId: string, body: string) => {
    for (const comments of this.comments.values()) {
      const comment = comments.find((candidate) => candidate.id === commentId);

      if (comment) {
        comment.body = body;
        return;
      }
    }
  });
  public readonly closeIssue = vi.fn(async (issueNumber: number) => {
    const issue = this.issues.get(issueNumber);

    if (issue) {
      issue.state = "CLOSED";
    }
  });
  public readonly getDefaultBranch = vi.fn(async () => "main");
  public readonly findPullRequestByHead = vi.fn(async () => this.pullRequests[0] ?? null);
  public readonly createDraftPullRequest = vi.fn(async (input: CreatePullRequestInput) => {
    this.pullRequestBodies.push(input.body);
    const pullRequest = { number: 10, labels: input.labels.map((name) => ({ name })) };
    this.pullRequests.push(pullRequest);
    return pullRequest;
  });
  public readonly updatePullRequestBody = vi.fn(async (_pullRequestNumber: number, body: string) => {
    this.pullRequestBodies.push(body);
  });
  public readonly setPullRequestLabels = vi.fn(async () => undefined);
  public readonly getAuthenticatedUser = vi.fn(async () => "factory-bot");
  public readonly getPullRequestDiff = vi.fn(async () => "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new");
  public readonly markPullRequestReadyForReview = vi.fn(async () => undefined);
  public readonly requestPullRequestReview = vi.fn(async () => undefined);

  public readonly prds: GitHubIssue[];
  public readonly issues = new Map<number, GitHubIssue>();
  public readonly subIssuesByPrd: Map<number, GitHubIssue[]>;
  public readonly comments: Map<number, GitHubComment[]>;
  public readonly pullRequests: GitHubPullRequest[];
  public readonly pullRequestBodies: string[] = [];

  public constructor({
    prds,
    issues = [],
    subIssuesByPrd = new Map(),
    comments = new Map(),
    pullRequests = []
  }: {
    prds: GitHubIssue[];
    issues?: GitHubIssue[];
    subIssuesByPrd?: Map<number, GitHubIssue[]>;
    comments?: Map<number, GitHubComment[]>;
    pullRequests?: GitHubPullRequest[];
  }) {
    this.prds = prds;
    this.subIssuesByPrd = subIssuesByPrd;
    this.comments = comments;
    this.pullRequests = pullRequests;

    for (const prd of prds) {
      this.issues.set(prd.number, prd);
    }

    for (const issue of issues) {
      this.issues.set(issue.number, issue);
    }

    for (const subIssues of subIssuesByPrd.values()) {
      for (const issue of subIssues) {
        this.issues.set(issue.number, issue);
      }
    }
  }
}

class FakeSandboxRunner implements SandboxRunner {
  public readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  public readonly ensureSandbox = vi.fn(async (input: { sandboxName: string }) => {
    this.calls.push({ name: "ensureSandbox", input });
  });
  public readonly checkoutBranch = vi.fn(
    async (input: { sandboxName: string; branchName: string }) => {
      this.calls.push({ name: "checkoutBranch", input });
    }
  );
  public readonly runAfkIssue = vi.fn(
    async (input: { sandboxName: string; branchName: string; prompt: string }) => {
      this.calls.push({ name: "runAfkIssue", input });
    }
  );
  public readonly commitAndPush = vi.fn(
    async (input: { sandboxName: string; branchName: string; issueNumber: number }) => {
      this.calls.push({ name: "commitAndPush", input });
    }
  );
  public readonly runFinalReview = vi.fn(async (input: { sandboxName: string; prompt: string }) => {
    this.calls.push({ name: "runFinalReview", input });
    return "## Code Factory Review\n\n### Findings\n\nNo findings.";
  });
  public readonly removeSandbox = vi.fn(async (input: { sandboxName: string }) => {
    this.calls.push({ name: "removeSandbox", input });
  });
}

class FakeLockStore implements PrdLockStore {
  public readonly acquire = vi.fn(async (prdNumber: number) => {
    if (this.locked) {
      return null;
    }

    const lock: PrdLock = {
      release: vi.fn(async () => {
        this.releasedPrds.push(prdNumber);
      })
    };
    return lock;
  });
  public readonly releasedPrds: number[] = [];

  public constructor(private readonly options: { locked?: boolean } = {}) {}

  private get locked(): boolean {
    return this.options.locked ?? false;
  }
}

class FixtureTemplates implements TemplateRenderer {
  public async render(
    templatePath: string,
    values: Record<string, string | number>
  ): Promise<string> {
    const templates: Record<string, string> = {
      "templates/hitlpause-comment.md":
        "<!-- code-factory:hitl-prd-{{prd_number}}-issue-{{issue_number}} -->\n\n@{{prd_author}} Code Factory is paused for PRD #{{prd_number}}.\n\n- #{{issue_number}} - {{issue_title}}\n\nBranch: `{{prd_branch}}`\nSandbox: `{{prd_sandbox}}`",
      "templates/afk-error-comment.md":
        "<!-- code-factory:afk-error-issue-{{issue_number}} -->\n\n{{error_summary}}\n\nPRD: #{{prd_number}}\nBranch: `{{prd_branch}}`\nSandbox: `{{prd_sandbox}}`",
      "templates/pr-body.md":
        "## Parent PRD\n\nCloses #{{prd_number}}\n\n## Implementation Issues\n\n{{implementation_issue_checklist}}\n\n## Code Factory\n\nBranch: `{{prd_branch}}`\nSandbox: `{{prd_sandbox}}`",
      "prompts/afk-issue.md":
        "Do not create commits or push branches.\nWork on `{{prd_branch}}`.\n\n## Parent PRD\n{{prd_body}}\n\n## Current AFK Issue\n{{issue_body}}\n\n## Earlier Implementation Issues\n{{earlier_issues}}\n\n## Later Implementation Issues\n{{later_issues}}",
      "templates/final-review-comment.md":
        "<!-- code-factory:final-review-prd-{{prd_number}} -->\n\n{{review_body}}",
      "prompts/final-review.md":
        "## Parent PRD\n{{prd_body}}\n\n## Implementation Issues\n{{implementation_issues}}\n\n## Pull Request Diff\n{{pr_diff}}"
    };
    const template = templates[templatePath];

    if (!template) {
      throw new Error(`No template fixture for ${templatePath}`);
    }

    return template.replace(/{{(\w+)}}/g, (_match, key: string) => String(values[key] ?? ""));
  }
}

function prdIssue({
  number = 1,
  author = "jd-solanki",
  body = ""
}: {
  number?: number;
  author?: string;
  body?: string;
} = {}): GitHubIssue {
  return {
    number,
    title: "PRD: Code Factory MVP",
    body,
    state: "OPEN",
    author: { login: author },
    labels: [{ name: "PRD" }, { name: "ready-for-agent" }],
    parentNumber: null
  };
}

function blockerIssue({
  number,
  title,
  state
}: {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
}): GitHubIssue {
  return {
    number,
    title,
    body: "",
    state,
    author: { login: "jd-solanki" },
    labels: [],
    parentNumber: null
  };
}

function implementationIssue({
  number,
  title = "Implementation issue",
  body = "Implementation issue body",
  state = "OPEN",
  parentNumber = 1,
  labels
}: {
  number: number;
  title?: string;
  body?: string;
  state?: "OPEN" | "CLOSED";
  parentNumber?: number | null;
  labels: string[];
}): GitHubIssue {
  return {
    number,
    title,
    body,
    state,
    author: { login: "jd-solanki" },
    labels: labels.map((name) => ({ name })),
    parentNumber
  };
}

test("deterministic PRD branch and sandbox names stay stable", () => {
  expect(deterministicPrdBranch(42)).toBe("code-factory/prd-42");
  expect(deterministicPrdSandbox(42)).toBe("code-factory-prd-42");
});
