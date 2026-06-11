# Start a fresh Codex session per AFK issue

The Code Factory uses one Factory Run loop for a PRD, but starts a fresh non-resumed `codex exec` session for every AFK Issue. The PRD Branch provides code continuity across issues, while each Codex session gets a fresh context window; the factory must not use `codex exec resume` between Implementation Issues.
