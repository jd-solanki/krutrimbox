export const FACTORY_OWNER = "jd-solanki";
export const IMPLEMENTATION_LABEL = "PRD-sub-issue";
export const AFK_LABEL = "ready-for-agent";
export const HITL_LABEL = "ready-for-human";
export const PRD_LABEL = "PRD";
export const PRD_BRANCH_PREFIX = "krutrimbox/prd-";
export const PRD_SANDBOX_PREFIX = "krutrimbox-prd-";
export const DEFAULT_SANDBOX_TEMPLATE = "docker.io/library/krutrimbox-codex:pnpm";
export const SANDBOX_CODEX_EXEC_FLAGS = [
  "--ephemeral",
  "--dangerously-bypass-approvals-and-sandbox"
] as const;
