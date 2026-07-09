import { defineDiagnostics } from "nostics";

// The single krutrimbox diagnostic catalog (issue #26). Instead of scattering
// bare `throw new Error("...")` strings across the codebase, every operational
// failure krutrimbox raises itself is defined here once as a stable `KB_*`
// code carrying a `why` (the diagnosis), a `fix` (the remedy), and a `docs`
// URL derived from `docsBase`. Call sites stay terse —
// `throw diagnostics.KB_C0001({ ... })` — and TypeScript checks each call's
// params against the code definition.
//
// Code shape follows the nostics convention `KB_<area-letter><4-digit>`, where
// the letter is the area, not the severity (`B` build, `R` runtime, `C` config,
// `D` deprecation). krutrimbox is a CLI with only two areas: `C` for Project
// Configuration loading/validation and `R` for everything else at run time.
// Codes are permanent once published — add new ones rather than renumbering, so
// the derived docs URLs stay stable.
//
// `why` is the diagnosis and `fix` is the remedy; they never restate each other,
// since the formatter prints both. No reporters are registered: every code here
// is thrown, and a console reporter would print the diagnostic once on creation
// and again when the uncaught throw is rendered. The top-level handler in
// index.ts formats the thrown Diagnostic instead.
export const diagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: (code) => `https://krutrimbox.pages.dev/errors/${code.toLowerCase()}`,
  codes: {
    // config/index.ts — `.krutrimbox/config.json` exists but is not valid JSON.
    KB_C0001: {
      why: (p: { configFile: string; detail: string }) =>
        `krutrimbox: ${p.configFile} is not valid JSON: ${p.detail}`,
      fix: (p: { configFile: string }) => `Fix the JSON syntax in ${p.configFile}.`
    },

    // config/index.ts — config parsed as JSON but failed schema validation.
    KB_C0002: {
      why: (p: { configFile: string; issue: string }) =>
        `krutrimbox: invalid ${p.configFile}${p.issue}`,
      fix: 'Match the accepted shape: optional "templates"/"prompts" objects mapping known keys to Markdown file paths under .krutrimbox/, and an optional "hooks" object mapping a hook name to an array of {type:"agent"|"comment"|"command"} actions.'
    },

    // config/index.ts — a configured Template Slot / Prompt Extension path escapes
    // the repository-owned `.krutrimbox/` directory.
    KB_C0003: {
      why: (p: { entityNoun: string; key: string; configuredPath: string; dirname: string }) =>
        `krutrimbox: ${p.entityNoun} "${p.key}" path "${p.configuredPath}" escapes ${p.dirname}/.`,
      fix: (p: { entityNoun: string; key: string; dirname: string }) =>
        `Point ${p.entityNoun} "${p.key}" at a file inside ${p.dirname}/.`
    },

    // config/index.ts — a configured Template Slot / Prompt Extension path resolves
    // inside `.krutrimbox/` but the referenced file does not exist.
    KB_C0004: {
      why: (p: { entityNoun: string; key: string; dirname: string; configuredPath: string }) =>
        `krutrimbox: ${p.entityNoun} "${p.key}" file not found: ${p.dirname}/${p.configuredPath}.`,
      fix: (p: { entityNoun: string; key: string }) =>
        `Create the file or fix the path for ${p.entityNoun} "${p.key}".`
    },

    // coding-agent.ts — `--agent` resolved to no known Agent Backend.
    KB_R0001: {
      why: (p: { name: string }) => `Unknown Agent Backend "${p.name}".`,
      fix: (p: { expected: string }) => `Pass --agent with one of: ${p.expected}.`
    },

    // commands/run.ts — `--issue` was not a positive integer.
    KB_R0002: {
      why: "Target Issue number must be a positive integer.",
      fix: "Pass --issue with a value like 42."
    },

    // sandbox-runner.ts — the requested base branch does not exist on origin, so
    // there is nothing to cut the Target Issue Branch from.
    KB_R0003: {
      why: (p: { baseBranch: string }) => `Base branch "${p.baseBranch}" does not exist on origin.`,
      fix: "Create the branch on origin, or pass an existing branch with --base-branch."
    },

    // github.ts — krutrimbox created the Target Issue Pull Request but a follow-up
    // lookup by head branch returned nothing.
    KB_R0004: {
      why: (p: { head: string }) =>
        `Created Pull Request for ${p.head}, but could not find it by head.`,
      fix: "Re-run krutrimbox; if it persists, check branch-protection or PR rules that could hide the pull request."
    },

    // github.ts — a GraphQL search returned a node that was not an Issue, which the
    // parser does not expect.
    KB_R0005: {
      why: (p: { typename: string }) => `Unexpected GitHub search result type: ${p.typename}`,
      fix: "This is an internal invariant; please report it with the search that triggered it."
    },

    // sequence.ts — an open Implementation Issue is missing the single state label
    // krutrimbox needs to route it (AFK vs HITL), or carries both.
    KB_R0006: {
      why: (p: { number: number }) =>
        `Implementation Issue #${p.number} must have exactly one open state label.`,
      fix: (p: { afkLabel: string; hitlLabel: string }) =>
        `Label it with exactly one of ${p.afkLabel} or ${p.hitlLabel}.`
    },

    // asset-store.ts — the bundled Markdown assets directory could not be found
    // next to the running module. An internal/packaging invariant, not user error.
    KB_R0007: {
      why: "krutrimbox: built-in Markdown assets directory was not found.",
      fix: "Reinstall krutrimbox; the published package ships its assets/ directory alongside the bundle."
    },

    // hooks.ts — a Hook Action threw, so krutrimbox aborts the hook fail-fast
    // (ADR-0021). For the `pull-request:ready` hook the pull request is already
    // marked ready, so a re-run skips it; the operator fixes the action and
    // re-triggers manually.
    KB_R0008: {
      why: (p: { hook: string; action: string; detail: string }) =>
        `krutrimbox: ${p.hook} hook ${p.action} failed: ${p.detail}`,
      fix: "Fix the failing hook action in .krutrimbox/config.json, then re-run krutrimbox."
    },

    // sandbox-runner.ts — the Sandboxed Agent session exited non-zero. This is the
    // common, legitimate failure (the agent could not finish the issue), so it is
    // coded rather than left as an Unexpected Failure: the operator's remedy is to
    // read what the agent did, not to report a krutrimbox bug. The agent's own
    // output already streamed to the run log; the non-zero exec error is kept as
    // the diagnostic's `cause` so the run log's FAILURE block shows it too.
    KB_R0009: {
      why: (p: { detail: string }) =>
        `The Sandboxed Agent exited without completing the issue (${p.detail}).`,
      fix: "Review the agent's output in the run log and inspect the sandbox (sbx shell), refine the issue, then rerun krutrimbox."
    },

    // factory-run.ts — an AFK Issue lists `Blocked by` issues that are neither in
    // the Done Set nor closed, so krutrimbox cannot implement it yet. Expected and
    // the operator's to resolve, not a krutrimbox bug.
    KB_R0010: {
      why: (p: { issueNumber: number; blockers: string }) =>
        `AFK Issue #${p.issueNumber} has unresolved blockers:\n${p.blockers}`,
      fix: "Resolve the blocking issues (land their work or close them), then rerun krutrimbox."
    },

    // github.ts (runGh) — a host `gh` command exited non-zero. Unlike the codes
    // above this is not raised by krutrimbox logic; it wraps any failure of the
    // GitHub CLI itself. `gh` runs on the host under the operator's own
    // credentials, so a failure here is almost always an environment condition —
    // the wrong `gh` account is active, that account lacks write access to the
    // repository, or the network is down — not a krutrimbox bug. Coding it keeps
    // the raw child-process Error from reaching the top-level "likely a bug"
    // handler and points the operator at their gh setup instead. `detail` carries
    // the command and its stderr; the original error is kept as the `cause` so the
    // run log's FAILURE block still shows the full output. `guidance` is
    // specialized at the call site for the common account/permission signal (a
    // 403/404 on a write) versus a network or auth failure.
    KB_R0011: {
      why: (p: { detail: string }) => `krutrimbox: a GitHub CLI (\`gh\`) command failed.\n${p.detail}`,
      fix: (p: { guidance: string }) => p.guidance
    },

    // sandbox-runner.ts (hostGit) — a host `git` command exited non-zero. The
    // counterpart to KB_R0011 for `gh`: it wraps the raw child-process failure of
    // git run on the host — the `fetch` from the `sandbox-<name>` remote and the
    // `push` to origin that publish a sandbox commit. A rejected push, a protected
    // branch, or missing credentials is the operator's environment, not a
    // krutrimbox bug, so coding it keeps the failure out of the top-level "likely a
    // bug" handler. `detail` carries the command and git's stderr; the original
    // error is kept as the `cause`. `guidance` is specialized at the call site for
    // push rejection, authentication, and network signals.
    KB_R0012: {
      why: (p: { detail: string }) => `krutrimbox: a git command failed on the host.\n${p.detail}`,
      fix: (p: { guidance: string }) => p.guidance
    },

    // sandbox-runner.ts — the Sandboxed Agent exited non-zero, but its output shows
    // the exit was a transient error from the model provider's API (e.g. Claude
    // Code's "API Error: 529 Overloaded"), not the agent giving up on the issue.
    // Split out from KB_R0009 so the operator is not sent to inspect the sandbox or
    // refine the issue for something that is neither their code nor their config:
    // the only remedy is to rerun. Expected and operator-facing — a provider
    // outage is not a krutrimbox bug — so it stays out of REPORTABLE_INTERNAL_CODES.
    KB_R0013: {
      why: (p: { detail: string }) =>
        `The Sandboxed Agent stopped on a transient model-provider API error (${p.detail}) — an upstream problem, not your issue, configuration, or sandbox.`,
      fix: "Rerun krutrimbox. If it persists, check the model provider's status page for an outage."
    },

    // sandbox-inspector.ts — `kb status --issue <n>` found a Target Issue Sandbox
    // for that issue under more than one Agent Backend, so the agent cannot be
    // inferred. The operator names it, exactly as `kb run` requires.
    KB_R0014: {
      why: (p: { issueNumber: number; agents: string }) =>
        `Target Issue #${p.issueNumber} has a sandbox under more than one Agent Backend (${p.agents}).`,
      fix: "Re-run with --agent to choose which one to inspect."
    },

    // sandbox-inspector.ts — the initial `sbx ls` failed, so Sandbox Inspection
    // cannot even find the sandbox. Unlike a stopped container (a reportable EXITED
    // state), a failing `sbx` is an environment problem: it is not installed, not on
    // PATH, or its daemon is down. Coded so it does not reach the top-level "likely a
    // bug" handler; the raw error is kept as the cause.
    KB_R0015: {
      why: "krutrimbox: could not list sandboxes — `sbx` failed.",
      fix: "Ensure the `sbx` CLI is installed and on your PATH (`sbx ls` should work), then re-run."
    }
  }
});

// Coded (Expected) diagnostics that are nonetheless krutrimbox's own invariants
// rather than something the operator can fix: a future reader should never hit them.
// They are routed to the same bug-report affordance an uncoded Unexpected Failure
// gets (see lib/factory/failure.ts). Kept beside the catalog so a new invariant
// code is flagged here, next to where it is defined, not in a distant module.
export const REPORTABLE_INTERNAL_CODES: ReadonlySet<string> = new Set(["KB_R0005", "KB_R0007"]);
