// Public barrel for the Code Factory. The orchestration is split into focused
// modules that relate by composition: CodeFactory builds a FactoryRun per locked
// PRD, which composes a PrdPullRequest and the sandbox / lock / template classes
// behind their injection seams (the Pick<Class, ...> types each module exports).
export * from "./constants.js";
export * from "./sequence.js";
export * from "./format.js";
export * from "./prd-pull-request.js";
export * from "./factory-run.js";
export * from "./template-renderer.js";
export * from "./lock-store.js";
export * from "./sandbox-runner.js";
export * from "./code-factory.js";
