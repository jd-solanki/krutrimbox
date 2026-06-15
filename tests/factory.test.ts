import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildImplementationSequence,
  FilePrdLockStore,
  Krutrimbox,
  deterministicTargetIssueBranch,
  deterministicTargetIssueSandbox,
  FactoryRun,
  fetchDoneSet,
  parseDoneSetFromCommitMessages,
  parseBlockingIssueNumbers,
  PrdPullRequest,
  SANDBOX_CODEX_EXEC_FLAGS,
  type PrdLock,
  type PrdLockStore,
  type SandboxRunner,
  type TemplateRenderer
} from "../src/lib/factory/index";
import type {
  CreatePullRequestInput,
  GitHubClient,
  GitHubComment,
  GitHubIssue,
  GitHubPullRequest
} from "../src/lib/github";

// Replace the file-backed run log with a silent, in-memory sink so Krutrimbox
// tests never touch `.krutrimbox/logs`. `filePath: null` also suppresses the
// "writing logs to ..." line, keeping the console-log assertions unaffected.
vi.mock("../src/lib/factory/run-log", () => ({
  createFileRunLogFactory: () => () => ({
    stream: { write: () => true },
    filePath: null,
    log: () => undefined,
    close: () => Promise.resolve()
  })
}));

describe("buildImplementationSequence", () => {
  test("treats a standalone Target Issue as a sequence-of-one AFK Implementation Issue", () => {
    const targetIssue = prdIssue({
      number: 9,
      body: "Standalone body\n\n## Blocked by\n\n- #3"
    });

    const sequence = buildImplementationSequence(targetIssue, [], new Set());

    expect(sequence.resolvedIssues).toEqual([]);
    expect(sequence.openIssues).toEqual([
      {
        number: 9,
        title: "PRD: krutrimbox MVP",
        body: "Standalone body\n\n## Blocked by\n\n- #3",
        state: "OPEN",
        kind: "afk",
        labels: ["ready-for-agent"]
      }
    ]);
  });

  test("validates, orders, and skips Implementation Issues in the Done Set", () => {
    const sequence = buildImplementationSequence(prdIssue(), [
      implementationIssue({
        number: 5,
        title: "Human input",
        labels: ["ready-for-human"]
      }),
      implementationIssue({
        number: 3,
        title: "Bootstrap",
        labels: ["ready-for-agent"]
      }),
      implementationIssue({
        number: 4,
        title: "Discovery",
        labels: ["ready-for-agent"]
      }),
      implementationIssue({
        number: 6,
        title: "Wrong parent",
        parentNumber: 2,
        labels: ["ready-for-agent"]
      }),
      implementationIssue({
        number: 7,
        title: "No retired implementation label",
        labels: ["ready-for-agent"]
      })
    ], new Set([3]));

    expect(sequence.openIssues.map((issue) => [issue.number, issue.kind])).toEqual([
      [4, "afk"],
      [5, "hitl"],
      [7, "afk"]
    ]);
    expect(sequence.resolvedIssues.map((issue) => issue.number)).toEqual([3]);
  });

  test("rejects open Implementation Issues without exactly one state label", () => {
    expect(() =>
      buildImplementationSequence(prdIssue(), [
        implementationIssue({
          number: 7,
          labels: []
        })
      ], new Set())
    ).toThrow(
      "Implementation Issue #7 must have exactly one open state label: ready-for-agent or ready-for-human."
    );

    expect(() =>
      buildImplementationSequence(prdIssue(), [
        implementationIssue({
          number: 8,
          labels: ["ready-for-agent", "ready-for-human"]
        })
      ], new Set())
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

describe("Done Set ledger", () => {
  test("extracts issue numbers from Refs footers across multiple commit messages", () => {
    const doneSet = parseDoneSetFromCommitMessages([
      "chore: first slice\n\nRefs #14",
      "chore: second slice\n\nRefs #15\nRefs #16"
    ]);

    expect([...doneSet].sort((left, right) => left - right)).toEqual([14, 15, 16]);
  });

  test("uses set semantics for duplicate Refs footers", () => {
    const doneSet = parseDoneSetFromCommitMessages([
      "chore: first attempt\n\nRefs #14",
      "chore: follow-up\n\nRefs #14"
    ]);

    expect([...doneSet]).toEqual([14]);
  });

  test("ignores commits with no Refs footer", () => {
    const doneSet = parseDoneSetFromCommitMessages([
      "chore: unrelated commit",
      "docs: mention Refs #99 in prose, not as a footer"
    ]);

    expect([...doneSet]).toEqual([]);
  });

  test("fetches an empty Done Set for an absent or empty branch", async () => {
    const source = {
      listBranchCommitMessages: vi.fn(async () => [])
    };

    await expect(fetchDoneSet(source, "krutrimbox/issue-14")).resolves.toEqual(new Set());
    expect(source.listBranchCommitMessages).toHaveBeenCalledWith("krutrimbox/issue-14");
  });
});

describe("SANDBOX_CODEX_EXEC_FLAGS", () => {
  test("uses current non-interactive Codex exec options for isolated runners", () => {
    expect(SANDBOX_CODEX_EXEC_FLAGS).toContain("--ephemeral");
    expect(SANDBOX_CODEX_EXEC_FLAGS).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(SANDBOX_CODEX_EXEC_FLAGS).not.toContain("--ask-for-approval");
  });
});

describe("Krutrimbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("explicit runs skip Target Issues not authored by the factory owner", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ author: "someone-else" })]
    });
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await factory.runExplicit(1);

    expect(github.ensureRequiredLabels).toHaveBeenCalledOnce();
    expect(github.getIssue).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "krutrimbox: skipping Target Issue #1; author someone-else is not jd-solanki."
    );
  });

  test("skips an already locked PRD before reading sub-issues", async () => {
    const github = new FakeGitHubClient({ prds: [prdIssue()] });
    const lockStore = fakeLockStore({ locked: true });
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore,
      templates: fixtureTemplates
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
              body: "<!-- krutrimbox:hitl-prd-1-issue-4 -->\nold body",
              url: "https://github.com/jd-solanki/krutrimbox/issues/1#issuecomment-100"
            }
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    const updatedBody = github.updateIssueComment.mock.calls[0]?.[1] ?? "";
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("> [!IMPORTANT]")
    );
    expect(updatedBody).toContain("push a `Refs #4` commit");
    expect(updatedBody).toContain("empty commit is acceptable");
    expect(updatedBody).toContain("Target Issue Branch `krutrimbox/issue-1`");
    expect(updatedBody).toContain("kb run --issue 1");
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
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.createIssueComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("#3 - Discover PRDs (OPEN)")
    );
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("implements a standalone Target Issue through sandbox, commit, and PR without closing it", async () => {
    const github = new FakeGitHubClient({
      prds: [
        prdIssue({
          body: "Standalone target issue body\n\n## Blocked by\n\n- #3"
        })
      ],
      issues: [blockerIssue({ number: 3, title: "Prerequisite", state: "CLOSED" })]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(1);
    expect(github.getIssue).toHaveBeenCalledWith(3);
    expect(String(sandbox.runAfkIssue.mock.calls[0]?.[0].prompt)).toContain(
      "Standalone target issue body"
    );
    expect(sandbox.commitAndPush).toHaveBeenCalledWith({
      sandboxName: "krutrimbox-issue-1",
      branchName: "krutrimbox/issue-1",
      issueNumber: 1
    });
    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "krutrimbox #1: PRD: krutrimbox MVP",
      body: expect.stringContaining("- [x] #1 - PRD: krutrimbox MVP"),
      head: "krutrimbox/issue-1",
      base: "main",
      labels: ["krutrimbox"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #1");
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("runs AFK issues through sandbox, commit, and PR maintenance without closing issues", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ body: "Full parent PRD body" })],
      branchCommitMessages: ["Bootstrap\n\nRefs #3"],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 3,
              title: "Bootstrap",
              labels: ["PRD-sub-issue", "ready-for-agent"]
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
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
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
    expect(sandbox.calls[0].input).toEqual({ sandboxName: "krutrimbox-issue-1" });
    expect(sandbox.calls[1].input).toEqual({
      sandboxName: "krutrimbox-issue-1",
      branchName: "krutrimbox/issue-1"
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
      title: "krutrimbox #1: PRD: krutrimbox MVP",
      body: expect.stringContaining("- [x] #4 - Factory loop"),
      head: "krutrimbox/issue-1",
      base: "main",
      labels: ["krutrimbox"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #3 - Bootstrap");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #4 - Factory loop");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #5 - Final review");
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #1");
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #3");
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #4");
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #5");
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(10, ["krutrimbox"]);
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("resumes from the Done Set instead of GitHub issue closed state", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      branchCommitMessages: ["Completed first issue\n\nRefs #4"],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Already committed",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            }),
            implementationIssue({
              number: 5,
              title: "Closed but not committed",
              state: "CLOSED",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.listBranchCommitMessages).toHaveBeenCalledWith("krutrimbox/issue-1");
    expect(sandbox.commitAndPush.mock.calls.map(([input]) => input.issueNumber)).toEqual([5]);
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #4 - Already committed");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #5 - Closed but not committed");
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("resumes past a HITL Implementation Issue once its Refs footer is on the branch", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      branchCommitMessages: ["Human checkpoint complete\n\nRefs #4"],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Human checkpoint",
              labels: ["ready-for-human"]
            }),
            implementationIssue({
              number: 5,
              title: "Continue after HITL",
              labels: ["ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      1,
      expect.stringContaining("krutrimbox is paused")
    );
    expect(sandbox.runAfkIssue).toHaveBeenCalledOnce();
    expect(sandbox.commitAndPush).toHaveBeenCalledWith({
      sandboxName: "krutrimbox-issue-1",
      branchName: "krutrimbox/issue-1",
      issueNumber: 5
    });
  });

  test("re-pauses at the same HITL Implementation Issue until its Refs footer exists", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Human checkpoint",
              labels: ["ready-for-human"]
            }),
            implementationIssue({
              number: 5,
              title: "Dependent AFK work",
              labels: ["ready-for-agent"]
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
              body: "<!-- krutrimbox:hitl-prd-1-issue-4 -->\nold body",
              url: "https://github.com/jd-solanki/krutrimbox/issues/1#issuecomment-100"
            }
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("push a `Refs #4` commit")
    );
    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(sandbox.runAfkIssue).not.toHaveBeenCalled();
    expect(sandbox.commitAndPush).not.toHaveBeenCalled();
  });

  test("reuses an existing Target Issue Pull Request by deterministic branch", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 12, isDraft: true, labels: [{ name: "krutrimbox" }, { name: "extra" }] }],
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
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.createDraftPullRequest).not.toHaveBeenCalled();
    expect(github.updatePullRequestBody).toHaveBeenCalledWith(
      12,
      expect.stringContaining("Branch: `krutrimbox/issue-1`")
    );
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(12, ["krutrimbox"]);
  });

  test("runs final review when all Implementation Issues are already resolved at run start", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ body: "Full PRD body" })],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({ number: 3, title: "Bootstrap", labels: ["PRD-sub-issue", "ready-for-agent"] }),
            implementationIssue({ number: 4, title: "Factory loop", labels: ["PRD-sub-issue", "ready-for-agent"] })
          ]
        ]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3", "Factory loop\n\nRefs #4"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
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
    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: "krutrimbox-issue-1" });
  });

  test("skips final review when the Target Issue Pull Request is already ready for review", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, isDraft: false, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(sandbox.runFinalReview).not.toHaveBeenCalled();
    expect(github.getPullRequestDiff).not.toHaveBeenCalled();
    expect(github.markPullRequestReadyForReview).not.toHaveBeenCalled();
    expect(github.requestPullRequestReview).not.toHaveBeenCalled();
  });

  test("updates an existing final review comment idempotently", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, title: "Bootstrap", labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"],
      comments: new Map([
        [
          10,
          [
            {
              id: "200",
              body: "<!-- krutrimbox:final-review-prd-1 -->\nold review",
              url: "https://github.com/jd-solanki/krutrimbox/issues/10#issuecomment-200"
            }
          ]
        ]
      ])
    });
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "200",
      expect.stringContaining("<!-- krutrimbox:final-review-prd-1 -->")
    );
    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      10,
      expect.stringContaining("<!-- krutrimbox:final-review-prd-1 -->")
    );
  });

  test("requests review from PRD Author when they differ from PR Author", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ author: "jd-solanki" })],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    github.getAuthenticatedUser.mockResolvedValue("factory-bot");
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
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
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    github.getAuthenticatedUser.mockResolvedValue("jd-solanki");
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
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
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: "krutrimbox-issue-1" });
  });

  test("never merges the Target Issue Pull Request during final review routing", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1);

    expect(github.markPullRequestReadyForReview).toHaveBeenCalledOnce();
    expect("mergePullRequest" in github).toBe(false);
  });

  test("skips final review when no Target Issue Pull Request exists", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
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
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runBatch();

    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(2);
    expect(github.createIssueComment).toHaveBeenCalledWith(
      1,
      expect.stringContaining("krutrimbox is paused for Target Issue #1.")
    );
    expect(github.closeIssue).not.toHaveBeenCalled();
  });
});

describe("Krutrimbox MVP smoke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("explicit run completes ordered AFK issues through PR, final review, and cleanup seams", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue({ body: "Full parent PRD smoke fixture" })],
      branchCommitMessages: ["Bootstrap CLI\n\nRefs #2"],
      issues: [
        blockerIssue({ number: 2, title: "Bootstrap CLI", state: "CLOSED" }),
        blockerIssue({ number: 4, title: "Factory loop", state: "CLOSED" })
      ],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 6,
              title: "Final review",
              body: "## Parent\n\nParent PRD: #1\n\n## Blocked by\n\n- #4",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            }),
            implementationIssue({
              number: 4,
              title: "Factory loop",
              body: "## Parent\n\nParent PRD: #1\n\n## Blocked by\n\n- #2",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            }),
            implementationIssue({
              number: 2,
              title: "Bootstrap CLI",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ]),
      comments: new Map([
        [
          10,
          [
            {
              id: "existing-final-review",
              body: "<!-- krutrimbox:final-review-prd-1 -->\nold",
              url: "https://github.com/jd-solanki/krutrimbox/issues/10#issuecomment-existing-final-review"
            }
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const lockStore = recordingLockStore();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore,
      templates: fixtureTemplates,
      logger: { log: vi.fn() }
    });

    await factory.runExplicit(1);

    expect(lockStore.acquired).toEqual([1]);
    expect(lockStore.released).toEqual([1]);
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
    expect(sandbox.runAfkIssue).toHaveBeenCalledTimes(2);
    expect(sandbox.calls.filter((call) => call.name.toLowerCase().includes("resume"))).toEqual([]);
    expect(sandbox.runAfkIssue.mock.calls.map(([input]) => input.branchName)).toEqual([
      "krutrimbox/issue-1",
      "krutrimbox/issue-1"
    ]);
    expect(String(sandbox.runAfkIssue.mock.calls[0]?.[0].prompt)).toContain("Full parent PRD smoke fixture");
    expect(String(sandbox.runAfkIssue.mock.calls[0]?.[0].prompt)).toContain("- #6 - Final review (afk, blocked by #4)");
    expect(String(sandbox.runAfkIssue.mock.calls[1]?.[0].prompt)).toContain("- #4 - Factory loop (CLOSED)");
    expect(String(sandbox.runAfkIssue.mock.calls[1]?.[0].prompt)).not.toContain("Final review (afk");
    expect(sandbox.commitAndPush.mock.calls.map(([input]) => input.issueNumber)).toEqual([4, 6]);
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "krutrimbox #1: PRD: krutrimbox MVP",
      body: expect.stringContaining("Closes #1"),
      head: "krutrimbox/issue-1",
      base: "main",
      labels: ["krutrimbox"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #2 - Bootstrap CLI");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #4 - Factory loop");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #6 - Final review");
    expect(github.setPullRequestLabels).toHaveBeenLastCalledWith(10, ["krutrimbox"]);
    expect(String(sandbox.runFinalReview.mock.calls[0]?.[0].prompt)).toContain("--- a/foo");
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "existing-final-review",
      expect.stringContaining("## krutrimbox Review")
    );
    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    expect(github.requestPullRequestReview).toHaveBeenCalledWith(10, "jd-solanki");
    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: "krutrimbox-issue-1" });

    const reviewOrder = sandbox.runFinalReview.mock.invocationCallOrder[0];
    const readyOrder = github.markPullRequestReadyForReview.mock.invocationCallOrder[0];
    expect(reviewOrder).toBeLessThan(readyOrder);
  });

  test("batch run orders discovered Target Issues and continues after Target-Issue-local stops", async () => {
    const pausedPrd = prdIssue({ number: 3 });
    const completedPrd = prdIssue({ number: 5 });
    const lockedPrd = prdIssue({ number: 9 });
    const github = new FakeGitHubClient({
      prds: [lockedPrd, completedPrd, pausedPrd],
      subIssuesByPrd: new Map([
        [
          3,
          [
            implementationIssue({
              number: 30,
              parentNumber: 3,
              title: "Human checkpoint",
              labels: ["PRD-sub-issue", "ready-for-human"]
            })
          ]
        ],
        [
          5,
          [
            implementationIssue({
              number: 50,
              parentNumber: 5,
              title: "Batch AFK",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ],
        [
          9,
          [
            implementationIssue({
              number: 90,
              parentNumber: 9,
              title: "Should not run",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ]),
      comments: new Map([
        [
          3,
          [
            {
              id: "existing-hitl",
              body: "<!-- krutrimbox:hitl-prd-3-issue-30 -->\nold",
              url: "https://github.com/jd-solanki/krutrimbox/issues/3#issuecomment-existing-hitl"
            }
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const lockStore = recordingLockStore({ lockedPrds: new Set([9]) });
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore,
      templates: fixtureTemplates,
      logger: { log: vi.fn() }
    });

    await factory.runBatch();

    expect(github.listReadyTargetIssues).toHaveBeenCalledWith("jd-solanki");
    expect(lockStore.acquired).toEqual([3, 5, 9]);
    expect(lockStore.released).toEqual([3, 5]);
    expect(github.getAttachedSubIssues.mock.calls.map(([prdNumber]) => prdNumber)).toEqual([3, 5]);
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "existing-hitl",
      expect.stringContaining("krutrimbox is paused for Target Issue #3.")
    );
    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      3,
      expect.stringContaining("krutrimbox is paused for Target Issue #3.")
    );
    expect(sandbox.commitAndPush).toHaveBeenCalledWith({
      sandboxName: "krutrimbox-issue-5",
      branchName: "krutrimbox/issue-5",
      issueNumber: 50
    });
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(github.getAttachedSubIssues).not.toHaveBeenCalledWith(9);

    const pauseOrder = github.updateIssueComment.mock.invocationCallOrder[0];
    const batchAfkOrder = sandbox.runAfkIssue.mock.invocationCallOrder[0];
    expect(pauseOrder).toBeLessThan(batchAfkOrder);
  });
});

describe("FactoryRun", () => {
  function silentLogger() {
    return { log: vi.fn() };
  }

  function runDependencies(
    github: FakeGitHubClient,
    sandbox: FakeSandboxRunner,
    logger: Pick<Console, "log"> = silentLogger()
  ) {
    return { github, sandbox, templates: fixtureTemplates, logger };
  }

  test("process() returns \"paused\" at the first HITL Issue without touching the sandbox", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 4, labels: ["PRD-sub-issue", "ready-for-human"] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), prdIssue());

    await expect(run.process()).resolves.toBe("paused");
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("process() returns \"issue-error\" when an AFK Issue has an unresolved blocker", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      issues: [blockerIssue({ number: 3, title: "Discover PRDs", state: "OPEN" })],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              body: "## Blocked by\n\n- #3",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), prdIssue());

    await expect(run.process()).resolves.toBe("issue-error");
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("logs the AFK failure comment URL when an AFK Issue fails", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      subIssuesByPrd: new Map([
        [
          1,
          [implementationIssue({ number: 4, labels: ["PRD-sub-issue", "ready-for-agent"] })]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    sandbox.runAfkIssue.mockRejectedValueOnce(new Error("boom"));
    const logger = { log: vi.fn() };
    const run = new FactoryRun(runDependencies(github, sandbox, logger), prdIssue());

    await expect(run.process()).resolves.toBe("issue-error");
    expect(logger.log).toHaveBeenCalledWith(
      "krutrimbox: stopped PRD #1; AFK Issue #4 failed. See https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-1 (issue: https://github.com/jd-solanki/krutrimbox/issues/4)."
    );
  });

  test("process() returns \"completed\" when every Implementation Issue is already resolved", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByPrd: new Map([
        [1, [implementationIssue({ number: 3, labels: ["PRD-sub-issue", "ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), prdIssue());

    await expect(run.process()).resolves.toBe("completed");
    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: "krutrimbox-issue-1" });
  });

  test("exposes the deterministic Target Issue branch and sandbox as run invariants", () => {
    const github = new FakeGitHubClient({ prds: [prdIssue({ number: 7 })] });
    const run = new FactoryRun(
      runDependencies(github, new FakeSandboxRunner()),
      prdIssue({ number: 7 })
    );

    expect(run.branchName).toBe("krutrimbox/issue-7");
    expect(run.sandboxName).toBe("krutrimbox-issue-7");
  });
});

describe("PrdPullRequest", () => {
  const sequence = buildImplementationSequence(prdIssue(), [
    implementationIssue({ number: 3, title: "Bootstrap", labels: ["PRD-sub-issue", "ready-for-agent"] })
  ], new Set([3]));

  function prModule(github: FakeGitHubClient) {
    return new PrdPullRequest(
      github,
      fixtureTemplates,
      { log: vi.fn() },
      prdIssue(),
      "krutrimbox/issue-1",
      "krutrimbox-issue-1"
    );
  }

  test("ensureReflectsSequence creates a draft Target Issue Pull Request and applies only the krutrimbox label", async () => {
    const github = new FakeGitHubClient({ prds: [prdIssue()] });

    await prModule(github).ensureReflectsSequence(sequence, new Set([3]));

    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "krutrimbox #1: PRD: krutrimbox MVP",
      body: expect.stringContaining("- [x] #3 - Bootstrap"),
      head: "krutrimbox/issue-1",
      base: "main",
      labels: ["krutrimbox"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #1");
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #3");
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(10, ["krutrimbox"]);
  });

  test("ensureReflectsSequence updates an existing Target Issue Pull Request and re-applies only the krutrimbox label", async () => {
    const github = new FakeGitHubClient({
      prds: [prdIssue()],
      pullRequests: [{ number: 12, isDraft: true, labels: [{ name: "krutrimbox" }, { name: "extra" }] }]
    });

    await prModule(github).ensureReflectsSequence(sequence, new Set([3]));

    expect(github.createDraftPullRequest).not.toHaveBeenCalled();
    expect(github.updatePullRequestBody).toHaveBeenCalledWith(
      12,
      expect.stringContaining("- [x] #3 - Bootstrap")
    );
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(12, ["krutrimbox"]);
  });

  test("routeForReview requests review from the PRD Author when distinct from the PR Author", async () => {
    const github = new FakeGitHubClient({ prds: [prdIssue()] });
    github.getAuthenticatedUser.mockResolvedValue("factory-bot");

    await prModule(github).routeForReview(10, "jd-solanki");

    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    expect(github.requestPullRequestReview).toHaveBeenCalledWith(10, "jd-solanki");
    expect(github.createIssueComment).not.toHaveBeenCalled();
  });

  test("routeForReview tags the PRD Author for self-review when they are the PR Author", async () => {
    const github = new FakeGitHubClient({ prds: [prdIssue()] });
    github.getAuthenticatedUser.mockResolvedValue("jd-solanki");

    await prModule(github).routeForReview(10, "jd-solanki");

    expect(github.requestPullRequestReview).not.toHaveBeenCalled();
    expect(github.createIssueComment).toHaveBeenCalledWith(
      10,
      expect.stringContaining("@jd-solanki")
    );
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
  public readonly getIssueUrl = vi.fn(async (issueNumber: number) => {
    return `https://github.com/jd-solanki/krutrimbox/issues/${issueNumber}`;
  });
  public readonly listReadyTargetIssues = vi.fn(async () => this.prds);
  public readonly getAttachedSubIssues = vi.fn(async (prdNumber: number) => {
    return this.subIssuesByPrd.get(prdNumber) ?? [];
  });
  public readonly listIssueComments = vi.fn(async (issueNumber: number) => {
    return this.comments.get(issueNumber) ?? [];
  });
  public readonly createIssueComment = vi.fn(async (issueNumber: number, body: string) => {
    const comments = this.comments.get(issueNumber) ?? [];
    const comment = {
      id: String(comments.length + 1),
      body,
      url: `https://github.com/jd-solanki/krutrimbox/issues/${issueNumber}#issuecomment-${comments.length + 1}`
    };
    comments.push(comment);
    this.comments.set(issueNumber, comments);
    return comment;
  });
  public readonly updateIssueComment = vi.fn(async (commentId: string, body: string) => {
    for (const comments of this.comments.values()) {
      const comment = comments.find((candidate) => candidate.id === commentId);

      if (comment) {
        comment.body = body;
        return comment;
      }
    }

    throw new Error(`No comment fixture for ${commentId}`);
  });
  public readonly closeIssue = vi.fn(async (issueNumber: number) => {
    const issue = this.issues.get(issueNumber);

    if (issue) {
      issue.state = "CLOSED";
    }
  });
  public readonly getDefaultBranch = vi.fn(async () => "main");
  public readonly findPullRequestByHead = vi.fn(async () => this.pullRequests[0] ?? null);
  public readonly listBranchCommitMessages = vi.fn(async () => this.branchCommitMessages);
  public readonly createDraftPullRequest = vi.fn(async (input: CreatePullRequestInput) => {
    this.pullRequestBodies.push(input.body);
    const pullRequest = { number: 10, isDraft: true, labels: input.labels.map((name) => ({ name })) };
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
  public readonly branchCommitMessages: string[];
  public readonly pullRequestBodies: string[] = [];

  public constructor({
    prds,
    issues = [],
    subIssuesByPrd = new Map(),
    comments = new Map(),
    pullRequests = [],
    branchCommitMessages = []
  }: {
    prds: GitHubIssue[];
    issues?: GitHubIssue[];
    subIssuesByPrd?: Map<number, GitHubIssue[]>;
    comments?: Map<number, GitHubComment[]>;
    pullRequests?: GitHubPullRequest[];
    branchCommitMessages?: string[];
  }) {
    this.prds = prds;
    this.subIssuesByPrd = subIssuesByPrd;
    this.comments = comments;
    this.pullRequests = pullRequests;
    this.branchCommitMessages = branchCommitMessages;

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
    return "## krutrimbox Review\n\n### Findings\n\nNo findings.";
  });
  public readonly removeSandbox = vi.fn(async (input: { sandboxName: string }) => {
    this.calls.push({ name: "removeSandbox", input });
  });
}

function fakeLockStore({ locked = false }: { locked?: boolean } = {}): PrdLockStore {
  return {
    acquire: vi.fn(async () => {
      if (locked) {
        return null;
      }

      const lock: PrdLock = { release: vi.fn(async () => undefined) };
      return lock;
    })
  };
}

function recordingLockStore({ lockedPrds = new Set<number>() }: { lockedPrds?: Set<number> } = {}) {
  const store = {
    acquired: [] as number[],
    released: [] as number[],
    acquire: vi.fn(async (prdNumber: number) => {
      store.acquired.push(prdNumber);

      if (lockedPrds.has(prdNumber)) {
        return null;
      }

      const lock: PrdLock = {
        release: vi.fn(async () => {
          store.released.push(prdNumber);
        })
      };
      return lock;
    })
  };

  return store satisfies PrdLockStore & { acquired: number[]; released: number[] };
}

const fixtureTemplates: TemplateRenderer = {
  async render(templatePath, values) {
    const templates: Record<string, string> = {
      "templates/hitlpause-comment.md":
        "<!-- krutrimbox:hitl-prd-{{prd_number}}-issue-{{issue_number}} -->\n\n@{{prd_author}} krutrimbox is paused for Target Issue #{{prd_number}}.\n\nThe next required issue is HITL:\n\n- #{{issue_number}} - {{issue_title}}\n\n> [!IMPORTANT]\n> When the HITL work is finished, push a `Refs #{{issue_number}}` commit to the Target Issue Branch `{{prd_branch}}`.\n> An empty commit is acceptable for non-code work. Then rerun krutrimbox:\n\n```sh\nkb run --issue {{prd_number}}\n```\n\nSandbox: `{{prd_sandbox}}`",
      "templates/afk-error-comment.md":
        "<!-- krutrimbox:afk-error-issue-{{issue_number}} -->\n\n{{error_summary}}\n\nPRD: #{{prd_number}}\nBranch: `{{prd_branch}}`\nSandbox: `{{prd_sandbox}}`",
      "templates/pr-body.md":
        "## Parent PRD\n\n{{closing_keywords}}\n\n## Implementation Issues\n\n{{implementation_issue_checklist}}\n\n## krutrimbox\n\nBranch: `{{prd_branch}}`\nSandbox: `{{prd_sandbox}}`",
      "prompts/afk-issue.md":
        "Do not create commits or push branches.\nWork on `{{prd_branch}}`.\n\n## Parent PRD\n{{prd_body}}\n\n## Current AFK Issue\n{{issue_body}}\n\n## Earlier Implementation Issues\n{{earlier_issues}}\n\n## Later Implementation Issues\n{{later_issues}}",
      "templates/final-review-comment.md":
        "<!-- krutrimbox:final-review-prd-{{prd_number}} -->\n\n{{review_body}}",
      "prompts/final-review.md":
        "## Parent PRD\n{{prd_body}}\n\n## Implementation Issues\n{{implementation_issues}}\n\n## Pull Request Diff\n{{pr_diff}}"
    };
    const template = templates[templatePath];

    if (!template) {
      throw new Error(`No template fixture for ${templatePath}`);
    }

    return template.replace(/{{(\w+)}}/g, (_match, key: string) => String(values[key] ?? ""));
  }
};

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
    title: "PRD: krutrimbox MVP",
    body,
    state: "OPEN",
    author: { login: author },
    labels: [{ name: "ready-for-agent" }],
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

test("deterministic Target Issue branch and sandbox names stay stable", () => {
  expect(deterministicTargetIssueBranch(42)).toBe("krutrimbox/issue-42");
  expect(deterministicTargetIssueSandbox(42)).toBe("krutrimbox-issue-42");
});

test("file locks use the deterministic Target Issue slug", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "krutrimbox-locks-"));
  try {
    const store = new FilePrdLockStore(workdir);
    const lock = await store.acquire(42);

    await expect(readdir(join(workdir, ".krutrimbox", "locks"))).resolves.toEqual([
      "issue-42.lock"
    ]);

    await lock?.release();
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
});

// End-to-end check that a real Factory Run lands both its status lines and the
// streamed sandbox/agent bytes in a per-PRD log file, without needing gh/sbx/
// codex. Uses the real file-backed run log (via importActual, bypassing the
// module mock above) pointed at a temp directory.
describe("run logging end-to-end", () => {
  test("writes status lines and streamed sandbox output to a per-PRD log file", async () => {
    const { createFileRunLogFactory } =
      await vi.importActual<typeof import("../src/lib/factory/run-log")>("../src/lib/factory/run-log");

    const github = new FakeGitHubClient({
      prds: [prdIssue({ body: "Full parent PRD body" })],
      subIssuesByPrd: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Factory loop",
              body: "## Parent\n\nParent PRD: #1\n\nCurrent issue body",
              labels: ["PRD-sub-issue", "ready-for-agent"]
            })
          ]
        ]
      ])
    });

    // Sandbox stand-in: the real run streams Codex output here; we emit a marker
    // line so the assertion can prove raw bytes reach the file.
    const sandbox: SandboxRunner = {
      ensureSandbox: async () => undefined,
      checkoutBranch: async () => undefined,
      runAfkIssue: async (input) => {
        input.output?.write("[codex] implementing the issue\n");
      },
      commitAndPush: async () => undefined,
      runFinalReview: async (input) => {
        input.output?.write("[codex] running the final review\n");
        return "## krutrimbox Review\n\n### Findings\n\nNo findings.";
      },
      removeSandbox: async () => undefined
    };

    const workdir = await mkdtemp(join(tmpdir(), "krutrimbox-logs-"));
    try {
      const factory = new Krutrimbox({
        github,
        sandbox,
        lockStore: fakeLockStore(),
        templates: fixtureTemplates,
        // Silent terminal so the run is quiet; the file still receives everything.
        openRunLog: createFileRunLogFactory(workdir, { log: () => undefined })
      });

      await factory.runExplicit(1);

      const logsDir = join(workdir, ".krutrimbox", "logs");
      const files = await readdir(logsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^krutrimbox-issue-1--[\d_-]+\.log$/);

      const content = await readFile(join(logsDir, files[0]), "utf8");
      expect(content).toContain("[codex] implementing the issue");
      expect(content).toContain("[codex] running the final review");
      expect(content).toContain("krutrimbox: completed AFK Issue #4.");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
