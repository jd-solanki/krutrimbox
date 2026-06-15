# Clean up Target Issue sandboxes on success

krutrimbox uses a deterministic Target Issue Sandbox for each Target Issue and removes it automatically only after the Target Issue reaches final review routing. HITL pauses and errors keep the Target Issue Sandbox available for debugging, with the cleanup command included in the relevant comment or log; this trades temporary disk usage for better inspection of incomplete runs.
