// The catalog of krutrimbox lifecycle hook names, kept dependency-free so both the
// config schema (which validates the `hooks` keys) and the hook runtime can share
// it without an import cycle. Add a new lifecycle point's name here, then wire its
// `callHook` site and document it. `pull-request:ready` — fired once a Target Issue
// finishes and its pull request is marked ready — is the first.
export const KRUTRIMBOX_HOOK_NAMES = ["pull-request:ready"] as const;

export type KrutrimboxHookName = (typeof KRUTRIMBOX_HOOK_NAMES)[number];
