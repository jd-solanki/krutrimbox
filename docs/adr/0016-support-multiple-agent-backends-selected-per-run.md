# Support multiple Agent Backends selected per run

krutrimbox supports more than one coding agent — currently Codex and Claude Code — chosen per Factory Run by a required `--agent <codex|claude>` flag, rather than hardcoding a single agent. The flag is the only selector: there is no environment-variable fallback and no default, so every run states its agent explicitly.

The agent-specific surface is small and isolated behind one `CodingAgent` strategy ("Agent Backend"), which supplies exactly three things that differ between agents: the Docker Sandboxes agent name passed to `sbx create`, the non-interactive exec command built from a Sandboxed Agent prompt (`codex exec --ephemeral --dangerously-bypass-approvals-and-sandbox <prompt>` vs `claude -p <prompt> --dangerously-skip-permissions`), and the default krutrimbox Sandbox Template. Everything else — branch checkout, commit, push, the Done Set, prompts, and PR orchestration — stays agent-agnostic and shared. Inner-agent authentication is left entirely to Docker Sandboxes' host-side credential proxy (a one-time OAuth `/login` or the `anthropic`/`openai` service secret), so krutrimbox carries no agent-credential code.

## Considered Options

- **Replace Codex with Claude Code.** Rejected: the operator wants both, to compare real PR output on real issues.
- **Select via environment variable or a default.** Rejected in favor of a required flag so an agent is never chosen implicitly; the breaking CLI change is acceptable for a single-operator factory.
- **One sandbox per Target Issue, agent-blind.** Rejected: reusing a Codex-built sandbox for a Claude run would run `claude` inside a Codex-only image, and an agent-blind `git add -A` reuse could merge two agents' uncommitted work into one commit. See ADR-0007.

## Consequences

- Sandbox identity is now keyed on (Target Issue, Agent Backend); see the amended ADR-0007.
- The custom sandbox template is built once per agent from a parameterized `Dockerfile.sandbox`; see the amended ADR-0012.
- Switching agents across a Target Issue's Factory Runs is safe because the Done Set is derived from `Refs #<n>` footers on the shared Target Issue Branch, not from sandbox state. Uncommitted work from a failed run is preserved in that agent's own sandbox but is not carried across an agent switch.
