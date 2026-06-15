// The Agent Backend seam (ADR-0016). A Factory Run is backed by exactly one
// coding agent, chosen per run by the required `--agent` flag. Everything that
// differs between agents — the `sbx create` agent name, the non-interactive exec
// command built from a Sandboxed Agent prompt, and the default krutrimbox
// Sandbox Template — lives behind this one interface so the rest of the factory
// (branch checkout, commit/push, Done Set, prompts, PR orchestration) stays
// agent-agnostic.

// The selectable Agent Backend names, in CLI-presentation order. Doubles as the
// allow-list the run command validates `--agent` against.
export const AGENT_NAMES = ["codex", "claude"] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

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
    return ["claude", "-p", prompt, "--dangerously-skip-permissions"];
  }
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
