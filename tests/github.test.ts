import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createExecFileCommandRunner, createGitHubCliClient, type CommandRunner } from "../src/lib/github";

function fixtureRunner(responses: Map<string, string>) {
  const calls: Array<{ command: string; args: string[] }> = [];

  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });

    const response =
      command === "gh" && args[0] === "api" && args[1] === "graphql"
        ? responses.get("graphql")
        : responses.get(commandKey(command, args));

    if (typeof response !== "string") {
      throw new Error(`No fixture response for ${command} ${args.join(" ")}`);
    }

    return response;
  };

  return Object.assign(run, { calls });
}

describe("ExecFileCommandRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streams child output to the sink while preserving captured stdout", async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    const runner = createExecFileCommandRunner();

    const output = await runner(
      process.execPath,
      ["-e", "process.stdout.write('hello'); process.stderr.write('warn');"],
      { output: sink }
    );

    const streamed = Buffer.concat(chunks).toString("utf8");
    expect(output).toBe("hello");
    expect(streamed).toContain("hello");
    expect(streamed).toContain("warn");
  });
});

describe("GitHubCliClient", () => {
  test("ensures required labels exist before discovery", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["label", "list", "--limit", "200", "--json", "name"]),
          JSON.stringify([{ name: "PRD" }, { name: "ready-for-agent" }])
        ],
        [
          commandKey("gh", [
            "label",
            "create",
            "ready-for-human",
            "--color",
            "1D76DB",
            "--description",
            "Requires human implementation"
          ]),
          ""
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await client.ensureRequiredLabels();

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["label", "list", "--limit", "200", "--json", "name"]
      },
      {
        command: "gh",
        args: [
          "label",
          "create",
          "ready-for-human",
          "--color",
          "1D76DB",
          "--description",
          "Requires human implementation"
        ]
      }
    ]);
  });

  test("discovers Factory-Owned PRDs through gh issue list fixture data", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", [
            "issue",
            "list",
            "--state",
            "open",
            "--author",
            "jd-solanki",
            "--label",
            "PRD",
            "--label",
            "ready-for-agent",
            "--limit",
            "100",
            "--json",
            "number,title,body,state,author,labels"
          ]),
          JSON.stringify([
            issueFixture({ number: 9, title: "PRD B" }),
            issueFixture({ number: 3, title: "PRD A" })
          ])
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    const prds = await client.listReadyPrds("jd-solanki");

    expect(prds.map((issue) => issue.number)).toEqual([3, 9]);
    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: [
        "issue",
        "list",
        "--state",
        "open",
        "--author",
        "jd-solanki",
        "--label",
        "PRD",
        "--label",
        "ready-for-agent",
        "--limit",
        "100",
        "--json",
        "number,title,body,state,author,labels"
      ]
    });
  });

  test("fetches attached sub-issues through gh api GraphQL fixture data", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["repo", "view", "--json", "owner,name"]),
          JSON.stringify({ owner: { login: "jd-solanki" }, name: "code-factory" })
        ],
        [
          "graphql",
          JSON.stringify({
            data: {
              repository: {
                issue: {
                  subIssues: {
                    nodes: [
                      {
                        number: 3,
                        title: "Discover PRDs",
                        body: "Implementation issue body",
                        state: "OPEN",
                        author: { login: "jd-solanki" },
                        labels: {
                          nodes: [{ name: "PRD-sub-issue" }, { name: "ready-for-agent" }]
                        },
                        parent: { number: 1 }
                      }
                    ]
                  }
                }
              }
            }
          })
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    const subIssues = await client.getAttachedSubIssues(1);

    expect(subIssues).toHaveLength(1);
    expect(subIssues[0]).toMatchObject({
      number: 3,
      title: "Discover PRDs",
      labels: [{ name: "PRD-sub-issue" }, { name: "ready-for-agent" }],
      parentNumber: 1
    });
    expect(runner.calls[1].args).toEqual([
      "api",
      "graphql",
      "-f",
      expect.stringMatching(/^query=/),
      "-F",
      "owner=jd-solanki",
      "-F",
      "repo=code-factory",
      "-F",
      "number=1"
    ]);
  });

  test("lists, creates, and updates issue comments through GitHub REST commands", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["repo", "view", "--json", "owner,name"]),
          JSON.stringify({ owner: { login: "jd-solanki" }, name: "code-factory" })
        ],
        [
          commandKey("gh", ["api", "repos/jd-solanki/code-factory/issues/4/comments"]),
          JSON.stringify([{ id: 123, body: "<!-- marker -->\nold" }])
        ],
        [
          commandKey("gh", [
            "api",
            "repos/jd-solanki/code-factory/issues/4/comments",
            "-f",
            "body=new comment"
          ]),
          "{}"
        ],
        [
          commandKey("gh", [
            "api",
            "repos/jd-solanki/code-factory/issues/comments/123",
            "-X",
            "PATCH",
            "-f",
            "body=updated comment"
          ]),
          "{}"
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await expect(client.listIssueComments(4)).resolves.toEqual([
      { id: "123", body: "<!-- marker -->\nold" }
    ]);
    await client.createIssueComment(4, "new comment");
    await client.updateIssueComment("123", "updated comment");

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["repo", "view", "--json", "owner,name"]
      },
      {
        command: "gh",
        args: ["api", "repos/jd-solanki/code-factory/issues/4/comments"]
      },
      {
        command: "gh",
        args: [
          "api",
          "repos/jd-solanki/code-factory/issues/4/comments",
          "-f",
          "body=new comment"
        ]
      },
      {
        command: "gh",
        args: [
          "api",
          "repos/jd-solanki/code-factory/issues/comments/123",
          "-X",
          "PATCH",
          "-f",
          "body=updated comment"
        ]
      }
    ]);
  });

  test("creates a draft PRD Pull Request and finds it by deterministic branch", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", [
            "pr",
            "create",
            "--draft",
            "--title",
            "Code Factory PRD #1: PRD",
            "--body",
            "body",
            "--base",
            "main",
            "--head",
            "code-factory/prd-1",
            "--label",
            "PRD"
          ]),
          "https://github.com/jd-solanki/code-factory/pull/8\n"
        ],
        [
          commandKey("gh", [
            "pr",
            "list",
            "--state",
            "all",
            "--head",
            "code-factory/prd-1",
            "--limit",
            "10",
            "--json",
            "number,labels"
          ]),
          JSON.stringify([{ number: 8, labels: [{ name: "PRD" }] }])
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await expect(
      client.createDraftPullRequest({
        title: "Code Factory PRD #1: PRD",
        body: "body",
        base: "main",
        head: "code-factory/prd-1",
        labels: ["PRD"]
      })
    ).resolves.toEqual({ number: 8, labels: [{ name: "PRD" }] });

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: [
          "pr",
          "create",
          "--draft",
          "--title",
          "Code Factory PRD #1: PRD",
          "--body",
          "body",
          "--base",
          "main",
          "--head",
          "code-factory/prd-1",
          "--label",
          "PRD"
        ]
      },
      {
        command: "gh",
        args: [
          "pr",
          "list",
          "--state",
          "all",
          "--head",
          "code-factory/prd-1",
          "--limit",
          "10",
          "--json",
          "number,labels"
        ]
      }
    ]);
  });

  test("gets the authenticated GitHub user login", async () => {
    const runner = fixtureRunner(
      new Map([
        [commandKey("gh", ["api", "/user"]), JSON.stringify({ login: "factory-bot" })]
      ])
    );
    const client = createGitHubCliClient(runner);

    await expect(client.getAuthenticatedUser()).resolves.toBe("factory-bot");
    expect(runner.calls[0]).toEqual({ command: "gh", args: ["api", "/user"] });
  });

  test("fetches the pull request diff", async () => {
    const runner = fixtureRunner(
      new Map([
        [commandKey("gh", ["pr", "diff", "8"]), "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new"]
      ])
    );
    const client = createGitHubCliClient(runner);

    await expect(client.getPullRequestDiff(8)).resolves.toBe(
      "--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new"
    );
    expect(runner.calls[0]).toEqual({ command: "gh", args: ["pr", "diff", "8"] });
  });

  test("marks a pull request ready for review", async () => {
    const runner = fixtureRunner(
      new Map([[commandKey("gh", ["pr", "ready", "8"]), ""]])
    );
    const client = createGitHubCliClient(runner);

    await client.markPullRequestReadyForReview(8);

    expect(runner.calls[0]).toEqual({ command: "gh", args: ["pr", "ready", "8"] });
  });

  test("requests review on a pull request from a specific reviewer", async () => {
    const runner = fixtureRunner(
      new Map([
        [commandKey("gh", ["pr", "edit", "8", "--add-reviewer", "jd-solanki"]), ""]
      ])
    );
    const client = createGitHubCliClient(runner);

    await client.requestPullRequestReview(8, "jd-solanki");

    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: ["pr", "edit", "8", "--add-reviewer", "jd-solanki"]
    });
  });

  test("updates a PRD Pull Request body and applies only the PRD label", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["pr", "edit", "8", "--body", "new body"]),
          ""
        ],
        [
          commandKey("gh", ["pr", "view", "8", "--json", "number,labels"]),
          JSON.stringify({
            number: 8,
            labels: [{ name: "PRD" }, { name: "ready-for-agent" }]
          })
        ],
        [
          commandKey("gh", [
            "pr",
            "edit",
            "8",
            "--add-label",
            "PRD",
            "--remove-label",
            "ready-for-agent"
          ]),
          ""
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await client.updatePullRequestBody(8, "new body");
    await client.setPullRequestLabels(8, ["PRD"]);

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["pr", "edit", "8", "--body", "new body"]
      },
      {
        command: "gh",
        args: ["pr", "view", "8", "--json", "number,labels"]
      },
      {
        command: "gh",
        args: [
          "pr",
          "edit",
          "8",
          "--add-label",
          "PRD",
          "--remove-label",
          "ready-for-agent"
        ]
      }
    ]);
  });
});

function issueFixture({
  number,
  title
}: {
  number: number;
  title: string;
}): unknown {
  return {
    number,
    title,
    body: "## Parent\n\nParent PRD: #1",
    state: "OPEN",
    author: { login: "jd-solanki" },
    labels: [{ name: "PRD" }, { name: "ready-for-agent" }]
  };
}

function commandKey(command: string, args: string[]): string {
  return JSON.stringify([command, ...args]);
}
