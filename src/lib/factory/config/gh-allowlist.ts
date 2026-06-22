// The verb-level allowlist for hook Command Actions (ADR-0021). A Command Action
// runs one `gh` invocation on the host with the Operator's credential, so the
// surface is deliberately narrow: `run[0]` must be `gh`, only these
// `gh <command> <verb>` pairs are permitted, and the command is spawned directly —
// never through a shell. Destructive verbs (`pr merge`, `pr close`, `issue delete`,
// `label delete`) and escape hatches (`gh api`, `gh secret`) are intentionally absent.
export const ALLOWED_GH_COMMANDS = [
  "pr ready",
  "pr edit",
  "pr comment",
  "pr review",
  "issue comment",
  "issue edit",
  "label create"
] as const;

const ALLOWED = new Set<string>(ALLOWED_GH_COMMANDS);

// Whether a Command Action's argument array is allowed. The first three elements
// are always literal (`gh`, the command, the verb) — interpolation only ever
// appears in later arguments — so the schema can run this at parse time.
export function isAllowedGhCommand(run: string[]): boolean {
  if (run[0] !== "gh") {
    return false;
  }

  const pair = `${run[1] ?? ""} ${run[2] ?? ""}`.trim();
  return ALLOWED.has(pair);
}
