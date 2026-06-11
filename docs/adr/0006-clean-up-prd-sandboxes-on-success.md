# Clean up PRD sandboxes on success

The Code Factory uses a deterministic PRD Sandbox for each PRD and removes it automatically only after the PRD reaches final review routing. HITL pauses and errors keep the PRD Sandbox available for debugging, with the cleanup command included in the relevant comment or log; this trades temporary disk usage for better inspection of incomplete runs.
