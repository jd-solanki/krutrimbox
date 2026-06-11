import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildImplementationSequence,
  createCodeFactory,
  type CodeFactoryRunner
} from "../src/factory.js";
import type { GitHubClient, GitHubIssue } from "../src/github.js";

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
        body: "## Parent\n\nParent PRD: #2",
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

describe("createCodeFactory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("explicit runs skip PRDs not authored by the factory owner", async () => {
    const github = fakeGitHubClient({
      prd: prdIssue({ author: "someone-else" })
    });
    const factory = createCodeFactory(github);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await factory.runExplicit(1);

    expect(github.ensureRequiredLabels).toHaveBeenCalledOnce();
    expect(github.getIssue).toHaveBeenCalledWith(1);
    expect(github.getAttachedSubIssues).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "Code Factory: skipping PRD #1; author someone-else is not jd-solanki."
    );
  });

  test("batch runs discover ready PRDs and build their implementation sequences", async () => {
    const github = fakeGitHubClient({
      prd: prdIssue({ number: 2 }),
      subIssues: [
        implementationIssue({
          number: 4,
          body: "## Parent\n\nParent PRD: #2",
          labels: ["PRD-sub-issue", "ready-for-agent"]
        })
      ]
    });
    const factory: CodeFactoryRunner = createCodeFactory(github);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await factory.runBatch();

    expect(github.ensureRequiredLabels).toHaveBeenCalledOnce();
    expect(github.listReadyPrds).toHaveBeenCalledWith("jd-solanki");
    expect(github.getAttachedSubIssues).toHaveBeenCalledWith(2);
    expect(log).toHaveBeenCalledWith(
      "Code Factory: Implementation Sequence for PRD #2: #4 (afk)."
    );
  });
});

function fakeGitHubClient({
  prd,
  subIssues = []
}: {
  prd: GitHubIssue;
  subIssues?: GitHubIssue[];
}): GitHubClient {
  return {
    ensureRequiredLabels: vi.fn(async () => undefined),
    getIssue: vi.fn(async () => prd),
    listReadyPrds: vi.fn(async () => [prd]),
    getAttachedSubIssues: vi.fn(async () => subIssues)
  };
}

function prdIssue({
  number = 1,
  author = "jd-solanki"
}: {
  number?: number;
  author?: string;
} = {}): GitHubIssue {
  return {
    number,
    title: "PRD: Code Factory MVP",
    body: "",
    state: "OPEN",
    author: { login: author },
    labels: [{ name: "PRD" }, { name: "ready-for-agent" }]
  };
}

function implementationIssue({
  number,
  title = "Implementation issue",
  body = "## Parent\n\nParent PRD: #1",
  state = "OPEN",
  labels
}: {
  number: number;
  title?: string;
  body?: string;
  state?: "OPEN" | "CLOSED";
  labels: string[];
}): GitHubIssue {
  return {
    number,
    title,
    body,
    state,
    author: { login: "jd-solanki" },
    labels: labels.map((name) => ({ name }))
  };
}
