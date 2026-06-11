# Reuse one PRD sandbox per PRD

The Code Factory reuses one PRD Sandbox across the AFK Issues for a PRD, while starting a fresh non-resumed Codex session for each AFK Issue. This keeps the Codex context window fresh per issue while preserving dependency caches, branch checkout state, and cumulative code changes inside one sandbox that can be cleaned up deterministically when the PRD completes.
