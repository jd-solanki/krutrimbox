// The Agent Backend seam (ADR-0016): the `CodingAgent` interface plus its
// concrete backends and the per-agent run-log codecs that decode structured
// session output. Adding a new agent means adding a file here and listing it in
// this barrel; nothing outside `agents/` needs to know which agent is running.
export * from "./coding-agent";
export * from "./claude-run-log-codec";
