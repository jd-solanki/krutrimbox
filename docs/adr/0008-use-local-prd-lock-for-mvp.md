# Use a local PRD lock for the MVP

The Code Factory prevents concurrent Factory Runs for the same PRD with a local PRD Lock because the MVP runs on a single trusted machine. This avoids duplicate issue processing and conflicting writes to the shared PRD Branch and PRD Sandbox, while deferring distributed locking through GitHub state, GitHub Actions concurrency, or an external queue until the factory needs to run from multiple machines.
