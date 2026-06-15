# Reuse one Target Issue sandbox per Target Issue

krutrimbox reuses one Target Issue Sandbox across the AFK Issues for a Target Issue, while starting a fresh non-resumed Codex session for each AFK Issue. This keeps the Codex context window fresh per issue while preserving dependency caches, branch checkout state, and cumulative code changes inside one sandbox that can be cleaned up deterministically when the Target Issue completes.
