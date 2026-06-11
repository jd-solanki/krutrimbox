# Use GitHub state for factory resume

The Code Factory is stateless for resume: each Factory Run rebuilds the Implementation Sequence from the PRD's current sub-issues and derives progress from GitHub issue state. Closed Implementation Issues are treated as handled, open HITL Issues pause the run, and open AFK Issues are delegated to a fresh agent session, avoiding a separate database, cursor file, or local progress ledger that could drift from the issue tracker.
