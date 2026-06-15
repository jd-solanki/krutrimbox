export const FACTORY_OWNER = "jd-solanki";
export const AFK_LABEL = "ready-for-agent";
export const HITL_LABEL = "ready-for-human";
export const KRUTRIMBOX_LABEL = "krutrimbox";
export const TARGET_ISSUE_BRANCH_PREFIX = "krutrimbox/issue-";
export const TARGET_ISSUE_SANDBOX_PREFIX = "krutrimbox-issue-";
export const DEFAULT_SANDBOX_TEMPLATE = "docker.io/library/krutrimbox-codex:pnpm";
export const SANDBOX_CODEX_EXEC_FLAGS = [
  "--ephemeral",
  "--dangerously-bypass-approvals-and-sandbox"
] as const;
