# Use a local Target Issue lock for the MVP

krutrimbox prevents concurrent Factory Runs for the same Target Issue with a local Target Issue Lock because the MVP runs on a single trusted machine. This avoids duplicate issue processing and conflicting writes to the shared Target Issue Branch and Target Issue Sandbox, while deferring distributed locking through GitHub state, GitHub Actions concurrency, or an external queue until the factory needs to run from multiple machines.
