# Start a fresh Sandboxed Agent session per AFK issue

krutrimbox uses one Factory Run loop for a Target Issue, but starts a fresh non-resumed Sandboxed Agent session for every AFK Issue, regardless of Agent Backend. The Target Issue Branch provides code continuity across issues, while each session gets a fresh context window; the factory must not resume a prior session between Implementation Issues. Both backends satisfy this by construction: Codex runs `codex exec` without `resume`, and Claude Code runs `claude -p` (a fresh one-shot, never `--continue`/`--resume`).
