import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { diagnostics } from "../src/lib/diagnostics";
import {
  buildImplementationSequence,
  FileTargetIssueLockStore,
  Krutrimbox,
  deterministicTargetIssueBranch,
  deterministicTargetIssueSandbox,
  FactoryRun,
  fetchDoneSet,
  parseDoneSetFromCommitMessages,
  parseBlockingIssueNumbers,
  TargetIssuePullRequest,
  ProjectTemplateRenderer,
  resolveCodingAgent,
  type KrutrimboxHookName,
  type ResolvedHookAction,
  type TargetIssueLock,
  type TargetIssueLockStore,
  type SandboxRunner,
  type TemplateRenderer
} from "../src/lib/factory/index";
import type {
  CommandRunner,
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

// The repository FakeGitHubClient resolves to. Shared by the fake and by sandbox-
// name expectations so both speak of the same repository.
const FAKE_REPOSITORY_SLUG = "jd-solanki/krutrimbox";

// Builds a resolved hooks map with actions attached to the `pull-request:ready`
// hook — the only hook fixtures use, so most tests read as a flat action list.
function prReadyHook(
  actions: ResolvedHookAction[]
): Map<KrutrimboxHookName, ResolvedHookAction[]> {
  return new Map([["pull-request:ready", actions]]);
}

// The Operator most fixtures are owned by: the default `getAuthenticatedUser`
// login, so a Target Issue or sub-issue assigned to it is the Operator's to run.
const OPERATOR = "factory-bot";

// The codex sandbox name FakeGitHubClient's repository yields for an issue,
// expressed through the production helper so these expectations track the real
// naming scheme instead of a hand-copied fingerprint.
function fakeCodexSandbox(issueNumber: number): string {
  return deterministicTargetIssueSandbox(issueNumber, FAKE_REPOSITORY_SLUG, "codex");
}

describe("buildImplementationSequence", () => {
  test("treats a standalone Target Issue as a sequence-of-one AFK Implementation Issue", () => {
    const issue = targetIssue({
      number: 9,
      body: "Standalone body\n\n## Blocked by\n\n- #3"
    });

    const sequence = buildImplementationSequence(issue, [], new Set());

    expect(sequence.resolvedIssues).toEqual([]);
    expect(sequence.openIssues).toEqual([
      {
        number: 9,
        title: "Target Issue: krutrimbox MVP",
        body: "Standalone body\n\n## Blocked by\n\n- #3",
        state: "OPEN",
        kind: "afk",
        labels: ["ready-for-agent"],
        assignees: [{ login: OPERATOR }]
      }
    ]);
  });

  test("validates, orders, and skips Implementation Issues in the Done Set", () => {
    const sequence = buildImplementationSequence(targetIssue(), [
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
      buildImplementationSequence(targetIssue(), [
        implementationIssue({
          number: 7,
          labels: []
        })
      ], new Set())
    ).toThrow("Implementation Issue #7 must have exactly one open state label.");

    expect(() =>
      buildImplementationSequence(targetIssue(), [
        implementationIssue({
          number: 8,
          labels: ["ready-for-agent", "ready-for-human"]
        })
      ], new Set())
    ).toThrow("Implementation Issue #8 must have exactly one open state label.");
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

describe("Krutrimbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("explicit runs never touch the sandbox for a Target Issue assigned to someone else", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ assignees: ["someone-else"] })]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1, "codex");

    expect(github.ensureRequiredLabels).toHaveBeenCalledOnce();
    expect(github.getIssue).toHaveBeenCalledWith(1);
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(github.createDraftPullRequest).not.toHaveBeenCalled();
  });

  test("skips an already locked Target Issue before reading sub-issues", async () => {
    const github = new FakeGitHubClient({ targetIssues: [targetIssue()] });
    const lockStore = fakeLockStore({ locked: true });
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore,
      templates: fixtureTemplates
    });

    await factory.runExplicit(1, "codex");

    expect(lockStore.acquire).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).not.toHaveBeenCalled();
  });

  test("updates an idempotent HITL pause comment and does not create a sandbox", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Human checkpoint",
              labels: ["ready-for-human"]
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
              body: "<!-- krutrimbox:hitl-issue-1-implementation-4 -->\nold body",
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

    await factory.runExplicit(1, "codex");

    const updatedBody = github.updateIssueComment.mock.calls[0]?.[1] ?? "";
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "100",
      expect.stringContaining("> [!IMPORTANT]")
    );
    expect(updatedBody).toContain("push a `Refs #4` commit");
    expect(updatedBody).toContain("empty commit is acceptable");
    expect(updatedBody).toContain("Target Issue Branch `krutrimbox/issue-1`");
    expect(updatedBody).toContain("kb run --issue 1 --agent codex");
    expect(github.createIssueComment).not.toHaveBeenCalled();
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("posts an AFK error comment when a blocking issue is unresolved", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      issues: [
        blockerIssue({
          number: 3,
          title: "Discover target issues",
          state: "OPEN"
        })
      ],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              body: "## Parent\n\nParent Target Issue: #1\n\n## Blocked by\n\n- #3",
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

    await factory.runExplicit(1, "codex");

    expect(github.createIssueComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("#3 - Discover target issues (OPEN)")
    );
    expect(github.createIssueComment).toHaveBeenCalledWith(
      4,
      expect.stringContaining("kb run --issue 1 --agent codex")
    );
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("implements a standalone Target Issue through sandbox, commit, and PR without closing it", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [
        targetIssue({
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

    await factory.runExplicit(1, "codex");

    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(1);
    expect(github.getIssue).toHaveBeenCalledWith(3);
    expect(String(sandbox.runAfkIssue.mock.calls[0]?.[0].prompt)).toContain(
      "Standalone target issue body"
    );
    expect(sandbox.commitAndPush).toHaveBeenCalledWith({
      sandboxName: fakeCodexSandbox(1),
      branchName: "krutrimbox/issue-1",
      subject: "Target Issue: krutrimbox MVP",
      issueNumber: 1
    });
    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "Target Issue: krutrimbox MVP",
      body: expect.stringContaining("- [x] #1 - Target Issue: krutrimbox MVP"),
      head: "krutrimbox/issue-1",
      base: "main",
      labels: ["krutrimbox"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("Closes #1");
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("an explicit base branch drives both the branch cut and the Target Issue Pull Request base", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ body: "Standalone target issue body" })]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates
    });

    await factory.runExplicit(1, "codex", { baseBranch: "dev" });

    expect(sandbox.checkoutBranch).toHaveBeenCalledWith({
      sandboxName: fakeCodexSandbox(1),
      branchName: "krutrimbox/issue-1",
      baseBranch: "dev"
    });
    expect(github.createDraftPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ base: "dev" })
    );
    // The repository default branch is never consulted when a base is given.
    expect(github.getDefaultBranch).not.toHaveBeenCalled();
  });

  test("runs AFK issues through sandbox, commit, and PR maintenance without closing issues", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ body: "Full parent Target Issue body" })],
      branchCommitMessages: ["Bootstrap\n\nRefs #3"],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 3,
              title: "Bootstrap",
              labels: ["ready-for-agent"]
            }),
            implementationIssue({
              number: 4,
              title: "Factory loop",
              body: "## Parent\n\nParent Target Issue: #1\n\nCurrent issue body",
              labels: ["ready-for-agent"]
            }),
            implementationIssue({
              number: 5,
              title: "Final review",
              body: "## Parent\n\nParent Target Issue: #1\n\n## Blocked by\n\n- #4",
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

    await factory.runExplicit(1, "codex");

    expect(sandbox.calls.map((call) => call.name)).toEqual([
      "ensureSandbox",
      "checkoutBranch",
      "runAfkIssue",
      "commitAndPush",
      "ensureSandbox",
      "checkoutBranch",
      "runAfkIssue",
      "commitAndPush",
      "removeSandbox"
    ]);
    expect(sandbox.calls[0].input).toEqual({ sandboxName: fakeCodexSandbox(1) });
    expect(sandbox.calls[1].input).toEqual({
      sandboxName: fakeCodexSandbox(1),
      branchName: "krutrimbox/issue-1",
      baseBranch: "main"
    });
    expect(String(sandbox.calls[2].input.prompt)).toContain("Full parent Target Issue body");
    expect(String(sandbox.calls[2].input.prompt)).toContain("Current issue body");
    expect(String(sandbox.calls[2].input.prompt)).toContain("- #3 - Bootstrap (CLOSED)");
    expect(String(sandbox.calls[2].input.prompt)).toContain(
      "- #5 - Final review (afk, blocked by #4)"
    );
    expect(String(sandbox.calls[2].input.prompt)).toContain(
      "Do not create commits or push branches."
    );
    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "Target Issue: krutrimbox MVP",
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
      targetIssues: [targetIssue()],
      branchCommitMessages: ["Completed first issue\n\nRefs #4"],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Already committed",
              labels: ["ready-for-agent"]
            }),
            implementationIssue({
              number: 5,
              title: "Closed but not committed",
              state: "CLOSED",
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

    await factory.runExplicit(1, "codex");

    expect(github.listBranchCommitMessages).toHaveBeenCalledWith("krutrimbox/issue-1");
    expect(sandbox.commitAndPush.mock.calls.map(([input]) => input.issueNumber)).toEqual([5]);
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #4 - Already committed");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #5 - Closed but not committed");
    expect(github.closeIssue).not.toHaveBeenCalled();
  });

  test("resumes past a HITL Implementation Issue once its Refs footer is on the branch", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      branchCommitMessages: ["Human checkpoint complete\n\nRefs #4"],
      subIssuesByTargetIssue: new Map([
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

    await factory.runExplicit(1, "codex");

    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      1,
      expect.stringContaining("krutrimbox is paused")
    );
    expect(sandbox.runAfkIssue).toHaveBeenCalledOnce();
    expect(sandbox.commitAndPush).toHaveBeenCalledWith({
      sandboxName: fakeCodexSandbox(1),
      branchName: "krutrimbox/issue-1",
      subject: "Continue after HITL",
      issueNumber: 5
    });
  });

  test("re-pauses at the same HITL Implementation Issue until its Refs footer exists", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
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
              body: "<!-- krutrimbox:hitl-issue-1-implementation-4 -->\nold body",
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

    await factory.runExplicit(1, "codex");

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
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 12, isDraft: true, labels: [{ name: "krutrimbox" }, { name: "extra" }] }],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              labels: ["ready-for-agent"]
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

    await factory.runExplicit(1, "codex");

    expect(github.createDraftPullRequest).not.toHaveBeenCalled();
    expect(github.updatePullRequestBody).toHaveBeenCalledWith(
      12,
      expect.stringContaining("Branch: `krutrimbox/issue-1`")
    );
    expect(github.setPullRequestLabels).toHaveBeenCalledWith(12, ["krutrimbox"]);
  });

  test("marks the Target Issue Pull Request ready, and nothing else, when no hooks are configured", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, title: "Bootstrap", labels: ["ready-for-agent"] })]]
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

    await factory.runExplicit(1, "codex");

    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    expect(sandbox.runAgentSession).not.toHaveBeenCalled();
    expect(github.createIssueComment).not.toHaveBeenCalled();
  });

  test("runs an agent action and posts its output through a later comment action", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ body: "Full Target Issue body" })],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, title: "Bootstrap", labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([
        { kind: "agent", id: "review", prompt: "Review PR #{{pr_number}}." },
        { kind: "comment", body: "Review:\n\n{{steps.review.output}}" }
      ])
    });

    await factory.runExplicit(1, "codex");

    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    const reviewCall = sandbox.calls.find((call) => call.name === "runAgentSession");
    expect(String(reviewCall?.input.prompt)).toBe("Review PR #10.");
    expect(github.createIssueComment).toHaveBeenCalledWith(
      10,
      "Review:\n\n## krutrimbox Review\n\n### Findings\n\nNo findings."
    );
    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: fakeCodexSandbox(1) });
  });

  test("skips the pull-request:ready hook when the pull request is already ready", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: false, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([{ kind: "agent", id: "review", prompt: "Review the PR." }])
    });

    await factory.runExplicit(1, "codex");

    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(sandbox.runAgentSession).not.toHaveBeenCalled();
    expect(github.markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  test("commits an agent action's code changes from the host when the working tree changed", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    sandbox.hasWorkingTreeChanges.mockResolvedValueOnce(true);
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([{ kind: "agent", id: "simplify", prompt: "Simplify the code." }])
    });

    await factory.runExplicit(1, "codex");

    expect(sandbox.commitReviewChanges).toHaveBeenCalledWith({
      sandboxName: fakeCodexSandbox(1),
      branchName: "krutrimbox/issue-1",
      subject: 'chore: agent action "simplify" changes',
      body: "Simplify the code."
    });
  });

  test("does not commit when an agent action leaves the working tree clean", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([{ kind: "agent", id: "review", prompt: "Review only." }])
    });

    await factory.runExplicit(1, "codex");

    expect(sandbox.commitReviewChanges).not.toHaveBeenCalled();
  });

  test("aborts the run fail-fast when a hook action throws, naming the action", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    sandbox.runAgentSession.mockRejectedValueOnce(new Error("agent crashed"));
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([{ kind: "agent", id: "review", prompt: "Review the PR." }])
    });

    // The pull request is marked ready first, so a failed pipeline does not retry.
    await expect(factory.runExplicit(1, "codex")).rejects.toThrow(
      /pull-request:ready hook agent action "review" failed/
    );
    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
  });

  test("runs a gh command action on the host with interpolated arguments", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ author: "jd-solanki" })],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const commandRunner = vi.fn(async () => "");
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      commandRunner,
      hooks: prReadyHook([
        {
          kind: "command",
          run: ["gh", "pr", "edit", "{{pr_number}}", "--add-reviewer", "{{target_issue_author}}"]
        }
      ])
    });

    await factory.runExplicit(1, "codex");

    expect(commandRunner).toHaveBeenCalledWith("gh", [
      "pr",
      "edit",
      "10",
      "--add-reviewer",
      "jd-solanki"
    ]);
  });

  test("does not create a Target Issue Sandbox for a comment/command-only hook", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([{ kind: "comment", body: "@coderabbitai review" }])
    });

    await factory.runExplicit(1, "codex");

    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(sandbox.removeSandbox).not.toHaveBeenCalled();
    expect(github.createIssueComment).toHaveBeenCalledWith(10, "@coderabbitai review");
  });

  test("skips the hook entirely when no Target Issue Pull Request exists", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      hooks: prReadyHook([{ kind: "agent", id: "review", prompt: "Review the PR." }])
    });

    await factory.runExplicit(1, "codex");

    expect(sandbox.runAgentSession).not.toHaveBeenCalled();
    expect(github.markPullRequestReadyForReview).not.toHaveBeenCalled();
  });

  test("loads hooks from .krutrimbox/config.json and runs them end to end", async () => {
    const workdir = await mkdtemp(join(tmpdir(), "krutrimbox-hooks-"));
    try {
      await mkdir(join(workdir, ".krutrimbox", "prompts"), { recursive: true });
      await writeFile(
        join(workdir, ".krutrimbox", "prompts", "review.md"),
        "Review PR #{{pr_number}}.",
        "utf8"
      );
      await writeFile(
        join(workdir, ".krutrimbox", "config.json"),
        JSON.stringify({
          hooks: {
            "pull-request:ready": [
              { type: "agent", id: "review", prompt: "prompts/review.md" },
              { type: "comment", body: "{{steps.review.output}}" }
            ]
          }
        }),
        "utf8"
      );

      const github = new FakeGitHubClient({
        targetIssues: [targetIssue()],
        pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
        subIssuesByTargetIssue: new Map([
          [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
        ]),
        branchCommitMessages: ["Bootstrap\n\nRefs #3"]
      });
      const sandbox = new FakeSandboxRunner();
      const factory = new Krutrimbox({
        github,
        sandbox,
        lockStore: fakeLockStore(),
        cwd: workdir
      });

      await factory.runExplicit(1, "codex");

      const reviewCall = sandbox.calls.find((call) => call.name === "runAgentSession");
      expect(String(reviewCall?.input.prompt)).toBe("Review PR #10.");
      expect(github.createIssueComment).toHaveBeenCalledWith(
        10,
        "## krutrimbox Review\n\n### Findings\n\nNo findings."
      );
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  test("batch discovery skips a Target Issue assigned to someone else", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ number: 2 }), targetIssue({ number: 3, assignees: ["bob"] })],
      subIssuesByTargetIssue: new Map([
        [2, [implementationIssue({ number: 20, parentNumber: 2, labels: ["ready-for-agent"] })]]
      ])
    });
    const logger = { log: vi.fn() };
    const factory = new Krutrimbox({
      github,
      sandbox: new FakeSandboxRunner(),
      lockStore: fakeLockStore(),
      templates: fixtureTemplates,
      logger
    });

    await factory.runBatch("codex");

    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(2);
    expect(github.getAttachedSubIssues).not.toHaveBeenCalledWith(3);
    expect(logger.log).toHaveBeenCalledWith(
      "krutrimbox: skipping Target Issue #3; it is not assigned to you alone (assigned-to-others)."
    );
  });

  test("batch runs continue after a Target-Issue-local HITL pause", async () => {
    const firstTargetIssue = targetIssue({ number: 1 });
    const secondTargetIssue = targetIssue({ number: 2 });
    const github = new FakeGitHubClient({
      targetIssues: [firstTargetIssue, secondTargetIssue],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              labels: ["ready-for-human"]
            })
          ]
        ],
        [
          2,
          [
            implementationIssue({
              number: 5,
              parentNumber: 2,
              labels: ["ready-for-agent"]
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

    await factory.runBatch("codex");

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

  test("explicit run completes ordered AFK issues through PR, pull-request:ready hook, and cleanup seams", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ body: "Full parent Target Issue smoke fixture" })],
      branchCommitMessages: ["Bootstrap CLI\n\nRefs #2"],
      issues: [
        blockerIssue({ number: 2, title: "Bootstrap CLI", state: "CLOSED" }),
        blockerIssue({ number: 4, title: "Factory loop", state: "CLOSED" })
      ],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 6,
              title: "Final review",
              body: "## Parent\n\nParent Target Issue: #1\n\n## Blocked by\n\n- #4",
              labels: ["ready-for-agent"]
            }),
            implementationIssue({
              number: 4,
              title: "Factory loop",
              body: "## Parent\n\nParent Target Issue: #1\n\n## Blocked by\n\n- #2",
              labels: ["ready-for-agent"]
            }),
            implementationIssue({
              number: 2,
              title: "Bootstrap CLI",
              labels: ["ready-for-agent"]
            })
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
      hooks: prReadyHook([
        { kind: "agent", id: "review", prompt: "Review PR #{{pr_number}}." },
        { kind: "comment", body: "{{steps.review.output}}" }
      ]),
      logger: { log: vi.fn() }
    });

    await factory.runExplicit(1, "codex");

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
      "checkoutBranch",
      "runAgentSession",
      "hasWorkingTreeChanges",
      "removeSandbox"
    ]);
    expect(sandbox.runAfkIssue).toHaveBeenCalledTimes(2);
    expect(sandbox.calls.filter((call) => call.name.toLowerCase().includes("resume"))).toEqual([]);
    expect(sandbox.runAfkIssue.mock.calls.map(([input]) => input.branchName)).toEqual([
      "krutrimbox/issue-1",
      "krutrimbox/issue-1"
    ]);
    expect(String(sandbox.runAfkIssue.mock.calls[0]?.[0].prompt)).toContain("Full parent Target Issue smoke fixture");
    expect(String(sandbox.runAfkIssue.mock.calls[0]?.[0].prompt)).toContain("- #6 - Final review (afk, blocked by #4)");
    expect(String(sandbox.runAfkIssue.mock.calls[1]?.[0].prompt)).toContain("- #4 - Factory loop (CLOSED)");
    expect(String(sandbox.runAfkIssue.mock.calls[1]?.[0].prompt)).not.toContain("Final review (afk");
    expect(sandbox.commitAndPush.mock.calls.map(([input]) => input.issueNumber)).toEqual([4, 6]);
    expect(sandbox.commitAndPush.mock.calls.map(([input]) => input.subject)).toEqual([
      "Factory loop",
      "Final review"
    ]);
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "Target Issue: krutrimbox MVP",
      body: expect.stringContaining("Closes #1"),
      head: "krutrimbox/issue-1",
      base: "main",
      labels: ["krutrimbox"]
    });
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #2 - Bootstrap CLI");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #4 - Factory loop");
    expect(github.pullRequestBodies.at(-1)).toContain("- [x] #6 - Final review");
    expect(github.setPullRequestLabels).toHaveBeenLastCalledWith(10, ["krutrimbox"]);
    expect(String(sandbox.runAgentSession.mock.calls[0]?.[0].prompt)).toBe("Review PR #10.");
    expect(github.createIssueComment).toHaveBeenCalledWith(
      10,
      "## krutrimbox Review\n\n### Findings\n\nNo findings."
    );
    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    expect(sandbox.removeSandbox).toHaveBeenCalledWith({ sandboxName: fakeCodexSandbox(1) });

    // The pull request is marked ready first, then the pull-request:ready hook runs.
    const readyOrder = github.markPullRequestReadyForReview.mock.invocationCallOrder[0];
    const reviewOrder = sandbox.runAgentSession.mock.invocationCallOrder[0];
    expect(readyOrder).toBeLessThan(reviewOrder);
  });

  test("batch run orders discovered Target Issues and continues after Target-Issue-local stops", async () => {
    const pausedTargetIssue = targetIssue({ number: 3 });
    const completedTargetIssue = targetIssue({ number: 5 });
    const lockedTargetIssue = targetIssue({ number: 9 });
    const github = new FakeGitHubClient({
      targetIssues: [lockedTargetIssue, completedTargetIssue, pausedTargetIssue],
      subIssuesByTargetIssue: new Map([
        [
          3,
          [
            implementationIssue({
              number: 30,
              parentNumber: 3,
              title: "Human checkpoint",
              labels: ["ready-for-human"]
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
              labels: ["ready-for-agent"]
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
              labels: ["ready-for-agent"]
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
              body: "<!-- krutrimbox:hitl-issue-3-implementation-30 -->\nold",
              url: "https://github.com/jd-solanki/krutrimbox/issues/3#issuecomment-existing-hitl"
            }
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const lockStore = recordingLockStore({ lockedTargetIssues: new Set([9]) });
    const factory = new Krutrimbox({
      github,
      sandbox,
      lockStore,
      templates: fixtureTemplates,
      logger: { log: vi.fn() }
    });

    await factory.runBatch("codex");

    expect(github.listReadyTargetIssues).toHaveBeenCalled();
    expect(lockStore.acquired).toEqual([3, 5, 9]);
    expect(lockStore.released).toEqual([3, 5]);
    expect(github.getAttachedSubIssues.mock.calls.map(([targetIssueNumber]) => targetIssueNumber)).toEqual([3, 5]);
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "existing-hitl",
      expect.stringContaining("krutrimbox is paused for Target Issue #3.")
    );
    expect(github.createIssueComment).not.toHaveBeenCalledWith(
      3,
      expect.stringContaining("krutrimbox is paused for Target Issue #3.")
    );
    expect(sandbox.commitAndPush).toHaveBeenCalledWith({
      sandboxName: fakeCodexSandbox(5),
      branchName: "krutrimbox/issue-5",
      subject: "Batch AFK",
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
    logger: Pick<Console, "log"> = silentLogger(),
    options: {
      operator?: string;
      allowUnassigned?: boolean;
      hooks?: Map<KrutrimboxHookName, ResolvedHookAction[]>;
      hostCommandRunner?: CommandRunner;
    } = {}
  ) {
    return {
      github,
      sandbox,
      agent: resolveCodingAgent("codex"),
      repositorySlug: FAKE_REPOSITORY_SLUG,
      baseBranch: "main",
      operator: options.operator ?? OPERATOR,
      allowUnassigned: options.allowUnassigned ?? false,
      templates: fixtureTemplates,
      hooks: options.hooks ?? new Map(),
      hostCommandRunner: options.hostCommandRunner ?? vi.fn(async () => ""),
      logger
    };
  }

  test("process() returns \"paused\" at the first HITL Issue without touching the sandbox", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 4, labels: ["ready-for-human"] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), targetIssue());

    await expect(run.process()).resolves.toBe("paused");
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("process() returns \"issue-error\" when an AFK Issue has an unresolved blocker", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      issues: [blockerIssue({ number: 3, title: "Discover target issues", state: "OPEN" })],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              body: "## Blocked by\n\n- #3",
              labels: ["ready-for-agent"]
            })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), targetIssue());

    await expect(run.process()).resolves.toBe("issue-error");
    expect(github.closeIssue).not.toHaveBeenCalled();
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("logs the AFK failure comment URL when an AFK Issue fails", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [implementationIssue({ number: 4, labels: ["ready-for-agent"] })]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    sandbox.runAfkIssue.mockRejectedValueOnce(new Error("boom"));
    const logger = { log: vi.fn() };
    const run = new FactoryRun(runDependencies(github, sandbox, logger), targetIssue());

    await expect(run.process()).resolves.toBe("issue-error");
    expect(logger.log).toHaveBeenCalledWith(
      "krutrimbox: stopped Target Issue #1; AFK Issue #4 failed. See https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-1 (issue: https://github.com/jd-solanki/krutrimbox/issues/4)."
    );
  });

  test("an unexpected (uncoded) failure asks the operator to report a krutrimbox bug", async () => {
    const github = afkFailureGitHub();
    const sandbox = new FakeSandboxRunner();
    sandbox.runAfkIssue.mockRejectedValueOnce(new Error("Unexpected token 'S'"));
    const run = new FactoryRun(runDependencies(github, sandbox), targetIssue());

    await run.process();

    const body = lastCommentBody(github, 4);
    expect(body.toLowerCase()).toContain("likely a krutrimbox bug");
    expect(body).toContain("github.com/jd-solanki/krutrimbox/issues/new?");
  });

  test("an Expected agent failure shows the fix and sandbox guidance, not a bug report", async () => {
    const github = afkFailureGitHub();
    const sandbox = new FakeSandboxRunner();
    sandbox.runAfkIssue.mockRejectedValueOnce(diagnostics.KB_R0009({ detail: "exit code 1" }));
    const run = new FactoryRun(runDependencies(github, sandbox), targetIssue());

    await run.process();

    const body = lastCommentBody(github, 4);
    expect(body).not.toContain("issues/new?");
    expect(body).toContain("Review the agent's output");
    // The sandbox was created before the agent ran, so its inspection guidance shows.
    expect(body).toContain("sbx shell");
  });

  test("writes a structured FAILURE block to the run log for a failed AFK Issue", async () => {
    const github = afkFailureGitHub();
    const sandbox = new FakeSandboxRunner();
    sandbox.runAfkIssue.mockRejectedValueOnce(diagnostics.KB_R0009({ detail: "exit code 1" }));

    let logged = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        logged += chunk.toString();
        callback();
      }
    });
    const run = new FactoryRun(
      { ...runDependencies(github, sandbox), output, logFilePath: "/repo/.krutrimbox/logs/run.log" },
      targetIssue()
    );

    await run.process();

    expect(logged).toContain("--- FAILURE [phase: agent] ---");
    expect(logged).toContain("KB_R0009");
  });

  test("process() returns \"completed\" when every Implementation Issue is already resolved", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      pullRequests: [{ number: 10, isDraft: true, labels: [{ name: "krutrimbox" }] }],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 3, labels: ["ready-for-agent"] })]]
      ]),
      branchCommitMessages: ["Bootstrap\n\nRefs #3"]
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), targetIssue());

    await expect(run.process()).resolves.toBe("completed");
    // A resume with no implementation and no hooks marks the PR ready and
    // never creates a sandbox, so there is nothing to tear down.
    expect(github.markPullRequestReadyForReview).toHaveBeenCalledWith(10);
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
    expect(sandbox.removeSandbox).not.toHaveBeenCalled();
  });

  test("exposes the deterministic Target Issue branch and sandbox as run invariants", () => {
    const github = new FakeGitHubClient({ targetIssues: [targetIssue({ number: 7 })] });
    const run = new FactoryRun(
      runDependencies(github, new FakeSandboxRunner()),
      targetIssue({ number: 7 })
    );

    expect(run.branchName).toBe("krutrimbox/issue-7");
    expect(run.sandboxName).toBe(fakeCodexSandbox(7));
  });

  test("stops with an issue error when the immediate Due Issue is assigned to someone else", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 4, labels: ["ready-for-agent"], assignees: ["bob"] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const logger = { log: vi.fn() };
    const run = new FactoryRun(runDependencies(github, sandbox, logger), targetIssue());

    await expect(run.process()).resolves.toBe("issue-error");
    expect(logger.log).toHaveBeenCalledWith(
      "krutrimbox: stopped Target Issue #1; Due Issue #4 is assigned to @bob, not you."
    );
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("stops on a Due Issue assigned to multiple people, naming them", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 4, labels: ["ready-for-agent"], assignees: [OPERATOR, "bob"] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const logger = { log: vi.fn() };
    const run = new FactoryRun(runDependencies(github, sandbox, logger), targetIssue());

    await expect(run.process()).resolves.toBe("issue-error");
    expect(logger.log).toHaveBeenCalledWith(
      `krutrimbox: stopped Target Issue #1; Due Issue #4 has multiple assignees (@${OPERATOR}, @bob); krutrimbox can't decide who implements it.`
    );
  });

  test("implements the Operator's Due Issues, then pauses to hand off to a teammate's", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue()],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({ number: 4, title: "Mine", labels: ["ready-for-agent"] }),
            implementationIssue({ number: 5, title: "Bob's", labels: ["ready-for-agent"], assignees: ["bob"] })
          ]
        ]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const logger = { log: vi.fn() };
    const run = new FactoryRun(runDependencies(github, sandbox, logger), targetIssue());

    await expect(run.process()).resolves.toBe("paused");
    expect(sandbox.commitAndPush.mock.calls.map(([input]) => input.issueNumber)).toEqual([4]);
    expect(logger.log).toHaveBeenCalledWith(
      "krutrimbox: paused Target Issue #1; Due Issue #5 is assigned to @bob, not you. Handing off to its assignee."
    );
  });

  test("stops on an unassigned Due Issue without the Implement-Unassigned Override", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ assignees: [] })],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 4, labels: ["ready-for-agent"], assignees: [] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(runDependencies(github, sandbox), targetIssue({ assignees: [] }));

    await expect(run.process()).resolves.toBe("issue-error");
    expect(sandbox.ensureSandbox).not.toHaveBeenCalled();
  });

  test("implements an unassigned Due Issue under the Implement-Unassigned Override", async () => {
    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ assignees: [] })],
      subIssuesByTargetIssue: new Map([
        [1, [implementationIssue({ number: 4, labels: ["ready-for-agent"], assignees: [] })]]
      ])
    });
    const sandbox = new FakeSandboxRunner();
    const run = new FactoryRun(
      runDependencies(github, sandbox, silentLogger(), { allowUnassigned: true }),
      targetIssue({ assignees: [] })
    );

    await expect(run.process()).resolves.toBe("completed");
    expect(sandbox.commitAndPush).toHaveBeenCalledWith(expect.objectContaining({ issueNumber: 4 }));
  });
});

describe("TargetIssuePullRequest", () => {
  const sequence = buildImplementationSequence(targetIssue(), [
    implementationIssue({ number: 3, title: "Bootstrap", labels: ["ready-for-agent"] })
  ], new Set([3]));

  function prModule(github: FakeGitHubClient) {
    return new TargetIssuePullRequest(
      github,
      fixtureTemplates,
      targetIssue(),
      "krutrimbox/issue-1",
      fakeCodexSandbox(1),
      "main"
    );
  }

  test("ensureReflectsSequence creates a draft Target Issue Pull Request and applies only the krutrimbox label", async () => {
    const github = new FakeGitHubClient({ targetIssues: [targetIssue()] });

    await prModule(github).ensureReflectsSequence(sequence, new Set([3]));

    expect(github.createDraftPullRequest).toHaveBeenCalledWith({
      title: "Target Issue: krutrimbox MVP",
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
      targetIssues: [targetIssue()],
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
});

class FakeGitHubClient implements GitHubClient {
  public readonly ensureRequiredLabels = vi.fn(async () => undefined);
  public readonly getRepositorySlug = vi.fn(async () => FAKE_REPOSITORY_SLUG);
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
  public readonly listReadyTargetIssues = vi.fn(async () => this.targetIssues);
  public readonly listAllReadyTargetIssues = vi.fn(async () => this.targetIssues);
  public readonly getAttachedSubIssues = vi.fn(async (targetIssueNumber: number) => {
    return this.subIssuesByTargetIssue.get(targetIssueNumber) ?? [];
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
  public readonly markPullRequestReadyForReview = vi.fn(async () => undefined);

  public readonly targetIssues: GitHubIssue[];
  public readonly issues = new Map<number, GitHubIssue>();
  public readonly subIssuesByTargetIssue: Map<number, GitHubIssue[]>;
  public readonly comments: Map<number, GitHubComment[]>;
  public readonly pullRequests: GitHubPullRequest[];
  public readonly branchCommitMessages: string[];
  public readonly pullRequestBodies: string[] = [];

  public constructor({
    targetIssues,
    issues = [],
    subIssuesByTargetIssue = new Map(),
    comments = new Map(),
    pullRequests = [],
    branchCommitMessages = []
  }: {
    targetIssues: GitHubIssue[];
    issues?: GitHubIssue[];
    subIssuesByTargetIssue?: Map<number, GitHubIssue[]>;
    comments?: Map<number, GitHubComment[]>;
    pullRequests?: GitHubPullRequest[];
    branchCommitMessages?: string[];
  }) {
    this.targetIssues = targetIssues;
    this.subIssuesByTargetIssue = subIssuesByTargetIssue;
    this.comments = comments;
    this.pullRequests = pullRequests;
    this.branchCommitMessages = branchCommitMessages;

    for (const targetIssue of targetIssues) {
      this.issues.set(targetIssue.number, targetIssue);
    }

    for (const issue of issues) {
      this.issues.set(issue.number, issue);
    }

    for (const subIssues of subIssuesByTargetIssue.values()) {
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
    async (input: { sandboxName: string; branchName: string; baseBranch: string }) => {
      this.calls.push({ name: "checkoutBranch", input });
    }
  );
  public readonly runAfkIssue = vi.fn(
    async (input: { sandboxName: string; branchName: string; prompt: string }) => {
      this.calls.push({ name: "runAfkIssue", input });
    }
  );
  public readonly commitAndPush = vi.fn(
    async (input: {
      sandboxName: string;
      branchName: string;
      subject: string;
      issueNumber: number;
    }) => {
      this.calls.push({ name: "commitAndPush", input });
    }
  );
  public readonly runAgentSession = vi.fn(async (input: { sandboxName: string; prompt: string }) => {
    this.calls.push({ name: "runAgentSession", input });
    return "## krutrimbox Review\n\n### Findings\n\nNo findings.";
  });
  public readonly hasWorkingTreeChanges = vi.fn(async (input: { sandboxName: string }) => {
    this.calls.push({ name: "hasWorkingTreeChanges", input });
    return false;
  });
  public readonly commitReviewChanges = vi.fn(
    async (input: { sandboxName: string; branchName: string; subject: string; body: string }) => {
      this.calls.push({ name: "commitReviewChanges", input });
    }
  );
  public readonly removeSandbox = vi.fn(async (input: { sandboxName: string }) => {
    this.calls.push({ name: "removeSandbox", input });
  });
}

function fakeLockStore({ locked = false }: { locked?: boolean } = {}): TargetIssueLockStore {
  return {
    acquire: vi.fn(async () => {
      if (locked) {
        return null;
      }

      const lock: TargetIssueLock = { release: vi.fn(async () => undefined) };
      return lock;
    })
  };
}

function recordingLockStore({ lockedTargetIssues = new Set<number>() }: { lockedTargetIssues?: Set<number> } = {}) {
  const store = {
    acquired: [] as number[],
    released: [] as number[],
    acquire: vi.fn(async (targetIssueNumber: number) => {
      store.acquired.push(targetIssueNumber);

      if (lockedTargetIssues.has(targetIssueNumber)) {
        return null;
      }

      const lock: TargetIssueLock = {
        release: vi.fn(async () => {
          store.released.push(targetIssueNumber);
        })
      };
      return lock;
    })
  };

  return store satisfies TargetIssueLockStore & { acquired: number[]; released: number[] };
}

// The factory tests run through the real renderer with no Project Configuration,
// so they exercise built-in Markdown loading and Factory Comment Marker
// injection end to end rather than asserting against a hand-written fixture.
const fixtureTemplates: TemplateRenderer = new ProjectTemplateRenderer();

// The common AFK-failure fixture: a Target Issue #1 with one agent-ready
// Implementation Issue #4, so a run reaches the agent step and can fail there.
function afkFailureGitHub(): FakeGitHubClient {
  return new FakeGitHubClient({
    targetIssues: [targetIssue()],
    subIssuesByTargetIssue: new Map([[1, [implementationIssue({ number: 4, labels: ["ready-for-agent"] })]]])
  });
}

// The body of the most recent comment krutrimbox posted on an issue.
function lastCommentBody(github: FakeGitHubClient, issueNumber: number): string {
  const calls = github.createIssueComment.mock.calls.filter(([number]) => number === issueNumber);
  return String(calls.at(-1)?.[1] ?? "");
}

function targetIssue({
  number = 1,
  author = "jd-solanki",
  body = "",
  assignees = [OPERATOR]
}: {
  number?: number;
  author?: string;
  body?: string;
  assignees?: string[];
} = {}): GitHubIssue {
  return {
    number,
    title: "Target Issue: krutrimbox MVP",
    body,
    state: "OPEN",
    author: { login: author },
    labels: [{ name: "ready-for-agent" }],
    assignees: assignees.map((login) => ({ login })),
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
    assignees: [],
    parentNumber: null
  };
}

function implementationIssue({
  number,
  title = "Implementation issue",
  body = "Implementation issue body",
  state = "OPEN",
  parentNumber = 1,
  labels,
  assignees = [OPERATOR]
}: {
  number: number;
  title?: string;
  body?: string;
  state?: "OPEN" | "CLOSED";
  parentNumber?: number | null;
  labels: string[];
  assignees?: string[];
}): GitHubIssue {
  return {
    number,
    title,
    body,
    state,
    author: { login: "jd-solanki" },
    labels: labels.map((name) => ({ name })),
    assignees: assignees.map((login) => ({ login })),
    parentNumber
  };
}

test("the Target Issue branch is agent-blind while the sandbox is scoped per Repository and Agent Backend", () => {
  expect(deterministicTargetIssueBranch(42)).toBe("krutrimbox/issue-42");

  const codexSandbox = deterministicTargetIssueSandbox(42, "jd-solanki/krutrimbox", "codex");
  const claudeSandbox = deterministicTargetIssueSandbox(42, "jd-solanki/krutrimbox", "claude");

  // The readable issue, repository, and agent parts, joined by an 8-hex-digit
  // repository fingerprint that sits between the repository slug and the agent.
  expect(codexSandbox).toMatch(/^krutrimbox-issue-42-jd-solanki-krutrimbox-[0-9a-f]{8}-codex$/);
  expect(claudeSandbox).toMatch(/^krutrimbox-issue-42-jd-solanki-krutrimbox-[0-9a-f]{8}-claude$/);
  expect(codexSandbox).not.toBe(claudeSandbox);
});

test("the Target Issue sandbox name is deterministic and unique per repository", () => {
  expect(deterministicTargetIssueSandbox(5, "jd-solanki/krutrimbox", "codex")).toBe(
    deterministicTargetIssueSandbox(5, "jd-solanki/krutrimbox", "codex")
  );

  // Case-only spellings of one repository — which GitHub forbids from coexisting
  // — resolve to the same sandbox.
  expect(deterministicTargetIssueSandbox(5, "JD-Solanki/KrutrimBox", "codex")).toBe(
    deterministicTargetIssueSandbox(5, "jd-solanki/krutrimbox", "codex")
  );

  // Distinct repositories whose readable slugs collide still get distinct
  // sandboxes, because the fingerprint is taken over the original identity.
  expect(deterministicTargetIssueSandbox(5, "acme/foo.bar", "codex")).not.toBe(
    deterministicTargetIssueSandbox(5, "acme/foo-bar", "codex")
  );
});

test("clamps the Target Issue sandbox name to Docker's 63-character hostname limit", () => {
  // Docker maps the sandbox name to a container hostname (RFC 1035, 63-char cap),
  // so `sbx create` rejects longer names outright. A long repository slug must be
  // clamped so the whole name still fits. The exact name below is the golden
  // output: the readable slug is cut to `big-organization-extremely-lo` (mid-word,
  // no dangling hyphen) while the issue prefix and the `-<8hex>-<agent>` identity
  // tail stay intact, landing exactly on the 63-char limit.
  const name = deterministicTargetIssueSandbox(
    5,
    "big-organization/extremely-long-repository-name-here",
    "codex"
  );

  expect(name).toBe("krutrimbox-issue-5-big-organization-extremely-lo-8b029291-codex");
  expect(name.length).toBe(63);
});

test("keeps clamped sandbox names unique through the repository fingerprint", () => {
  // Two distinct repositories whose readable slugs share a long leading prefix
  // clamp to the same readable text (`acme-longrepository-name-shar`), so only the
  // fingerprint — taken over the full identity — tells their sandboxes apart. The
  // two golden names below are identical except for that fingerprint, which is
  // exactly the uniqueness guarantee.
  const first = deterministicTargetIssueSandbox(
    5,
    "acme/longrepository-name-shared-prefix-aaaaaaaaaaaa",
    "codex"
  );
  const second = deterministicTargetIssueSandbox(
    5,
    "acme/longrepository-name-shared-prefix-bbbbbbbbbbbb",
    "codex"
  );

  expect(first).toBe("krutrimbox-issue-5-acme-longrepository-name-shar-866ba7ea-codex");
  expect(second).toBe("krutrimbox-issue-5-acme-longrepository-name-shar-0950998f-codex");
  expect(first).not.toBe(second);
});

test("file locks use the deterministic Target Issue slug", async () => {
  const workdir = await mkdtemp(join(tmpdir(), "krutrimbox-locks-"));
  try {
    const store = new FileTargetIssueLockStore(workdir);
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
// streamed sandbox/agent bytes in a per-Target-Issue log file, without needing gh/sbx/
// codex. Uses the real file-backed run log (via importActual, bypassing the
// module mock above) pointed at a temp directory.
describe("run logging end-to-end", () => {
  test("writes status lines and streamed sandbox output to a per-Target-Issue log file", async () => {
    const { createFileRunLogFactory } =
      await vi.importActual<typeof import("../src/lib/factory/run-log")>("../src/lib/factory/run-log");

    const github = new FakeGitHubClient({
      targetIssues: [targetIssue({ body: "Full parent Target Issue body" })],
      subIssuesByTargetIssue: new Map([
        [
          1,
          [
            implementationIssue({
              number: 4,
              title: "Factory loop",
              body: "## Parent\n\nParent Target Issue: #1\n\nCurrent issue body",
              labels: ["ready-for-agent"]
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
      runAgentSession: async (input) => {
        input.output?.write("[codex] running the review\n");
        return "## krutrimbox Review\n\n### Findings\n\nNo findings.";
      },
      hasWorkingTreeChanges: async () => false,
      commitReviewChanges: async () => undefined,
      removeSandbox: async () => undefined
    };

    const workdir = await mkdtemp(join(tmpdir(), "krutrimbox-logs-"));
    try {
      const factory = new Krutrimbox({
        github,
        sandbox,
        lockStore: fakeLockStore(),
        templates: fixtureTemplates,
        hooks: prReadyHook([{ kind: "agent", id: "review", prompt: "Review." }]),
        // Silent terminal so the run is quiet; the file still receives everything.
        openRunLog: createFileRunLogFactory(workdir, { log: () => undefined })
      });

      await factory.runExplicit(1, "codex");

      const logsDir = join(workdir, ".krutrimbox", "logs");
      const files = await readdir(logsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^krutrimbox-issue-1--[\d_-]+\.log$/);

      const content = await readFile(join(logsDir, files[0]), "utf8");
      expect(content).toContain("[codex] implementing the issue");
      expect(content).toContain("[codex] running the review");
      expect(content).toContain("krutrimbox: completed AFK Issue #4.");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });
});
