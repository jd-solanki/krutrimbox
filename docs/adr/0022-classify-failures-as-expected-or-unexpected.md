# Classify failures as Expected or Unexpected

krutrimbox splits every failure into **Expected** (carries a `KB_*` diagnostic code with a `why`/`fix`/`docs`) or **Unexpected** (an uncoded error reaching the top-level handler). Expected failures render their remedy in the run log, the terminal, and any GitHub comment; Unexpected failures are presented as likely krutrimbox bugs and invite a report with the run log attached. We chose a mechanical coded-vs-uncoded rule — rather than per-site fault categories — so classification can't drift: a developer who forgets to code a new failure gets a "report this bug" path by default rather than a silently misleading message.

## Considered Options

- **Coded vs uncoded (chosen).** One axis, enforced at a single top-level catch. The most common legitimate failure (the Sandboxed Agent exiting non-zero) must therefore be *coded* (`KB_R0009`) so it reads as an agent/issue problem, not a krutrimbox bug. A few coded diagnostics are nonetheless krutrimbox's own invariants; they are listed in `REPORTABLE_INTERNAL_CODES` (beside the catalog in `lib/diagnostics.ts`) so they join the report-worthy path rather than reading as operator-actionable.
- **Multi-bucket fault categories (krutrimbox/environment/agent/project), assigned per throw site.** More precise messages, but requires human judgment at every throw and drifts toward inconsistency as the codebase grows.

## Consequences

- New, unmodelled failures default to the bug-report path. This is intentional — it surfaces krutrimbox's own robustness gaps (e.g. parsing `sbx` output that carries a `Starting sandbox daemon…` preamble) instead of hiding them — but it means coding a failure is the act that reclassifies it from "our bug" to "operator-actionable."
- The GitHub comment path must become diagnostic-aware (today it flattens to `error.message`, discarding `fix`/`docs`), sharing one renderer with the CLI top-level handler.
