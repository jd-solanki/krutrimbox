# Use Node.js CLI for factory orchestration

The Code Factory MVP is implemented as a small TypeScript Node.js CLI instead of a shell-only loop. The factory still shells out to tools such as `gh`, `git`, `sbx`, and `codex exec`, but Node.js owns orchestration concerns like JSON parsing, prompt rendering, idempotent comments, PR body updates, and local locking; Commander may be used for CLI argument parsing if helpful. The package may move to a separate repository later if it grows beyond this workspace.
