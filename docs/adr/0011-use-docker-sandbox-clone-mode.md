# Use Docker Sandbox clone mode

krutrimbox uses Docker Sandbox clone mode for PRD Sandboxes so branch checkout, file changes, commits, and pushes happen inside a private sandbox clone rather than the host working tree. This keeps the host repository on its current branch, avoids branch restoration concerns, and still allows one reusable PRD Sandbox to preserve code and dependency continuity across fresh per-issue Codex sessions.
