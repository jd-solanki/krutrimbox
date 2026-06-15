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
          JSON.stringify([{ name: "ready-for-agent" }])
        ],
        [
          commandKey("gh", [
            "label",
            "create",
            "krutrimbox",
            "--color",
            "5319E7",
            "--description",
            "Pull requests authored by krutrimbox"
          ]),
          ""
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
          "krutrimbox",
          "--color",
          "5319E7",
          "--description",
          "Pull requests authored by krutrimbox"
        ]
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

  test("discovers Factory-Owned Target Issues with no parent through GraphQL parent links", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["repo", "view", "--json", "owner,name"]),
          JSON.stringify({ owner: { login: "jd-solanki" }, name: "krutrimbox" })
        ],
        [
          "graphql",
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  issueFixture({ number: 9, title: "Target B" }),
                  issueFixture({ number: 7, title: "Child issue", parentNumber: 3 }),
                  issueFixture({ number: 3, title: "Target A" })
                ]
              }
            }
          })
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    const targetIssues = await client.listReadyTargetIssues("jd-solanki");

    expect(targetIssues.map((issue) => issue.number)).toEqual([3, 9]);
    expect(runner.calls[0]).toEqual({
      command: "gh",
      args: ["repo", "view", "--json", "owner,name"]
    });
    expect(runner.calls[1].args).toEqual([
      "api",
      "graphql",
      "-f",
      expect.stringMatching(/^query=/),
      "-F",
      "queryString=repo:jd-solanki/krutrimbox is:issue is:open author:jd-solanki label:ready-for-agent"
    ]);
  });

  test("fetches attached sub-issues through gh api GraphQL fixture data", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["repo", "view", "--json", "owner,name"]),
          JSON.stringify({ owner: { login: "jd-solanki" }, name: "krutrimbox" })
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
      "repo=krutrimbox",
      "-F",
      "number=1"
    ]);
  });

  test("lists, creates, and updates issue comments through GitHub REST commands", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["repo", "view", "--json", "owner,name"]),
          JSON.stringify({ owner: { login: "jd-solanki" }, name: "krutrimbox" })
        ],
        [
          commandKey("gh", ["api", "repos/jd-solanki/krutrimbox/issues/4/comments"]),
          JSON.stringify([
            {
              id: 123,
              body: "<!-- marker -->\nold",
              html_url: "https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-123"
            }
          ])
        ],
        [
          commandKey("gh", [
            "api",
            "repos/jd-solanki/krutrimbox/issues/4/comments",
            "-f",
            "body=new comment"
          ]),
          JSON.stringify({
            id: 124,
            body: "new comment",
            html_url: "https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-124"
          })
        ],
        [
          commandKey("gh", [
            "api",
            "repos/jd-solanki/krutrimbox/issues/comments/123",
            "-X",
            "PATCH",
            "-f",
            "body=updated comment"
          ]),
          JSON.stringify({
            id: 123,
            body: "updated comment",
            html_url: "https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-123"
          })
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await expect(client.listIssueComments(4)).resolves.toEqual([
      {
        id: "123",
        body: "<!-- marker -->\nold",
        url: "https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-123"
      }
    ]);
    await expect(client.createIssueComment(4, "new comment")).resolves.toEqual({
      id: "124",
      body: "new comment",
      url: "https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-124"
    });
    await expect(client.updateIssueComment("123", "updated comment")).resolves.toEqual({
      id: "123",
      body: "updated comment",
      url: "https://github.com/jd-solanki/krutrimbox/issues/4#issuecomment-123"
    });

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["repo", "view", "--json", "owner,name"]
      },
      {
        command: "gh",
        args: ["api", "repos/jd-solanki/krutrimbox/issues/4/comments"]
      },
      {
        command: "gh",
        args: [
          "api",
          "repos/jd-solanki/krutrimbox/issues/4/comments",
          "-f",
          "body=new comment"
        ]
      },
      {
        command: "gh",
        args: [
          "api",
          "repos/jd-solanki/krutrimbox/issues/comments/123",
          "-X",
          "PATCH",
          "-f",
          "body=updated comment"
        ]
      }
    ]);
  });

  test("creates a draft Target Issue Pull Request and finds it by deterministic branch", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", [
            "pr",
            "create",
            "--draft",
            "--title",
            "krutrimbox #1: PRD",
            "--body",
            "body",
            "--base",
            "main",
            "--head",
            "krutrimbox/issue-1",
            "--label",
            "krutrimbox"
          ]),
          "https://github.com/jd-solanki/krutrimbox/pull/8\n"
        ],
        [
          commandKey("gh", [
            "pr",
            "list",
            "--state",
            "all",
            "--head",
            "krutrimbox/issue-1",
            "--limit",
            "10",
            "--json",
            "number,isDraft,labels"
          ]),
          JSON.stringify([{ number: 8, isDraft: true, labels: [{ name: "krutrimbox" }] }])
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await expect(
      client.createDraftPullRequest({
        title: "krutrimbox #1: PRD",
        body: "body",
        base: "main",
        head: "krutrimbox/issue-1",
        labels: ["krutrimbox"]
      })
    ).resolves.toEqual({ number: 8, isDraft: true, labels: [{ name: "krutrimbox" }] });

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: [
          "pr",
          "create",
          "--draft",
          "--title",
          "krutrimbox #1: PRD",
          "--body",
          "body",
          "--base",
          "main",
          "--head",
          "krutrimbox/issue-1",
          "--label",
          "krutrimbox"
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
          "krutrimbox/issue-1",
          "--limit",
          "10",
          "--json",
          "number,isDraft,labels"
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

  test("lists branch commit messages and treats an absent branch as empty", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });

      if (commandKey(command, args) === commandKey("gh", ["repo", "view", "--json", "owner,name"])) {
        return JSON.stringify({ owner: { login: "jd-solanki" }, name: "krutrimbox" });
      }

      if (
        commandKey(command, args) ===
        commandKey("gh", [
          "api",
          "repos/jd-solanki/krutrimbox/commits",
          "--paginate",
          "-f",
          "sha=krutrimbox/issue-14"
        ])
      ) {
        return JSON.stringify([
          { commit: { message: "chore: first\n\nRefs #14" } },
          { commit: { message: "chore: second\n\nRefs #15" } }
        ]);
      }

      throw new Error("No commit found for SHA: krutrimbox/issue-99");
    };
    const client = createGitHubCliClient(runner);

    await expect(client.listBranchCommitMessages("krutrimbox/issue-14")).resolves.toEqual([
      "chore: first\n\nRefs #14",
      "chore: second\n\nRefs #15"
    ]);
    await expect(client.listBranchCommitMessages("krutrimbox/issue-99")).resolves.toEqual([]);

    expect(calls).toEqual([
      { command: "gh", args: ["repo", "view", "--json", "owner,name"] },
      {
        command: "gh",
        args: [
          "api",
          "repos/jd-solanki/krutrimbox/commits",
          "--paginate",
          "-f",
          "sha=krutrimbox/issue-14"
        ]
      },
      {
        command: "gh",
        args: [
          "api",
          "repos/jd-solanki/krutrimbox/commits",
          "--paginate",
          "-f",
          "sha=krutrimbox/issue-99"
        ]
      }
    ]);
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

  test("updates a Target Issue Pull Request body and applies only the krutrimbox label", async () => {
    const runner = fixtureRunner(
      new Map([
        [
          commandKey("gh", ["pr", "edit", "8", "--body", "new body"]),
          ""
        ],
        [
          commandKey("gh", ["pr", "view", "8", "--json", "number,isDraft,labels"]),
          JSON.stringify({
            number: 8,
            isDraft: false,
            labels: [{ name: "krutrimbox" }, { name: "ready-for-agent" }]
          })
        ],
        [
          commandKey("gh", [
            "pr",
            "edit",
            "8",
            "--add-label",
            "krutrimbox",
            "--remove-label",
            "ready-for-agent"
          ]),
          ""
        ]
      ])
    );
    const client = createGitHubCliClient(runner);

    await client.updatePullRequestBody(8, "new body");
    await client.setPullRequestLabels(8, ["krutrimbox"]);

    expect(runner.calls).toEqual([
      {
        command: "gh",
        args: ["pr", "edit", "8", "--body", "new body"]
      },
      {
        command: "gh",
        args: ["pr", "view", "8", "--json", "number,isDraft,labels"]
      },
      {
        command: "gh",
        args: [
          "pr",
          "edit",
          "8",
          "--add-label",
          "krutrimbox",
          "--remove-label",
          "ready-for-agent"
        ]
      }
    ]);
  });
});

function issueFixture({
  number,
  title,
  parentNumber = null
}: {
  number: number;
  title: string;
  parentNumber?: number | null;
}): unknown {
  return {
    __typename: "Issue",
    number,
    title,
    body: "Target Issue body",
    state: "OPEN",
    author: { login: "jd-solanki" },
    labels: { nodes: [{ name: "ready-for-agent" }] },
    parent: parentNumber === null ? null : { number: parentNumber }
  };
}

function commandKey(command: string, args: string[]): string {
  return JSON.stringify([command, ...args]);
}
