// The Agent Backend seam (ADR-0016). A Factory Run is backed by exactly one
// coding agent, chosen per run by the required `--agent` flag. Everything that
// differs between agents — the `sbx create` agent name, the non-interactive exec
// command built from a Sandboxed Agent prompt, and the default krutrimbox
// Sandbox Template — lives behind this one interface so the rest of the factory
// (branch checkout, commit/push, Done Set, prompts, PR orchestration) stays
// agent-agnostic.

import { claudeRunLogCodec } from "./claude-run-log-codec";

// The selectable Agent Backend names, in CLI-presentation order. Doubles as the
// allow-list the run command validates `--agent` against.
export const AGENT_NAMES = ["codex", "claude"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

// Decodes an Agent Backend whose exec command emits structured (machine-readable)
// session output rather than plain prose. It keeps that structured stream from
// leaking into human-facing surfaces, in two independent directions:
//   - `extractResultText` lifts the final message out of a finished session for
//     callers (the review body), so a PR comment never carries raw event data.
//   - `renderLine` turns one raw event line into a human-readable run-log line
//     (or drops it), so an operator watching the log sees prose and actions
//     rather than a wall of JSON.
// A plain-prose agent (Codex) has no codec: its output is the human-readable text
// already, streamed and returned verbatim.
export interface RunLogCodec {
  // Renders one line of the agent's raw output for the run log. Returns the text
  // to log (without a trailing newline), or null to drop the line as noise. A
  // line that is not a recognized event is returned verbatim so nothing — not
  // even an interleaved stderr line — is silently lost.
  renderLine(line: string): string | null;
  extractResultText(stdout: string): string;
}

export interface CodingAgent {
  // The Agent Backend's identity, also used to scope the Target Issue Sandbox
  // name so one agent's run never reuses another agent's sandbox (ADR-0007).
  readonly name: AgentName;
  // The agent positional passed to `sbx create ... <sbxAgentName> <path>`.
  readonly sbxAgentName: string;
  // The krutrimbox Sandbox Template used when no override is configured.
  readonly defaultTemplate: string;
  // Builds the argv run via `sbx exec ... -- <argv>` for one Sandboxed Agent
  // prompt. Each agent runs non-interactively (no human is attached to an AFK
  // Issue) and never resumes a prior session, keeping context fresh per issue.
  buildExecCommand(prompt: string): string[];
  // Present only for an agent that emits structured session output; absent for a
  // plain-prose agent (Codex), whose output streams and returns verbatim.
  readonly runLogCodec?: RunLogCodec;
}

const CODEX_AGENT: CodingAgent = {
  name: "codex",
  sbxAgentName: "codex",
  defaultTemplate: "docker.io/library/krutrimbox-codex:pnpm",
  buildExecCommand(prompt) {
    return ["codex", "exec", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", prompt];
  }
};

const CLAUDE_AGENT: CodingAgent = {
  name: "claude",
  sbxAgentName: "claude",
  defaultTemplate: "docker.io/library/krutrimbox-claude:pnpm",
  buildExecCommand(prompt) {
    // `claude -p` is a fresh one-shot by construction — never `--continue` or
    // `--resume` — so it satisfies the fresh-context-per-AFK-Issue invariant
    // (ADR-0005). `--dangerously-skip-permissions` is the no-human analog of
    // Codex's approval bypass; the Docker Sandbox clone is the real boundary.
    //
    // `--output-format stream-json --verbose` is what makes the run log fill
    // live: the default `text` format buffers the whole turn and prints once at
    // the end, so the log stayed empty until completion. `stream-json` emits one
    // JSON event per line as each happens, and `--verbose` is required in print
    // mode for those intermediate events to appear at all. The run-log codec
    // decodes that stream (see `claudeRunLogCodec`).
    return [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions"
    ];
  },
  runLogCodec: claudeRunLogCodec
};

const AGENTS_BY_NAME: Record<AgentName, CodingAgent> = {
  codex: CODEX_AGENT,
  claude: CLAUDE_AGENT
};

// Resolves a validated `--agent` value to its Agent Backend. Throws on an
// unknown name rather than silently falling back, so a typo fails the run
// loudly instead of running the wrong agent.
export function resolveCodingAgent(name: AgentName): CodingAgent {
  const agent = AGENTS_BY_NAME[name];

  if (!agent) {
    throw new Error(`Unknown Agent Backend "${name}"; expected one of: ${AGENT_NAMES.join(", ")}.`);
  }

  return agent;
}
