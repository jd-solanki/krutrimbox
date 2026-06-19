# Use nostics for structured diagnostics

krutrimbox previously raised every self-detected failure as a bare `throw new Error("...")` with the message inlined at the call site, scattered across the factory, GitHub, config, and CLI layers. We now define each operational failure once in a single [nostics](https://nostics.dev) catalog (`src/lib/diagnostics.ts`) as a stable `KB_*` code carrying a `why` (the diagnosis), a `fix` (the remedy), and a `docs` URL derived from `docsBase`. Call sites become `throw diagnostics.KB_C0001({ ... })`, and TypeScript checks each call's interpolation params against the code definition. The catalog and its conventions follow the published `nostics` agent skill (`.agents/skills/nostics`), including its migration guide. The top-level handler in `index.ts` renders a thrown `Diagnostic` with `formatDiagnostic` (message + fix + docs) before exiting non-zero; any other error rethrows unchanged so its stack survives.

Codes follow the nostics convention `KB_<area-letter><4-digit-sequence>`, where the letter is the area, not the severity (`B` build, `R` runtime, `C` config, `D` deprecation). krutrimbox is a CLI with only two areas — `C` for Project Configuration loading/validation and `R` for everything else at run time. Codes are stable once published — add new ones rather than renumbering — so the derived `https://krutrimbox.pages.dev/errors/<code>` links stay permanent. `why` states only what is wrong and `fix` only what to do, so the formatter never prints the same sentence twice; config parse/validation failures additionally carry the original error as `cause` and the offending file as `sources`, since the JS stack points inside krutrimbox.

## Considered Options

- **Keep inline `throw new Error` strings** — rejected: messages drift in wording, carry no fix or docs, have no stable identifier to document or search, and duplicate near-identical phrasing across layers.
- **Hand-roll a local `KbError` subclass with a code field** — rejected: reimplements what nostics already provides (typed per-code params, `fix`/`docs`/`sources`, a formatter, and a prod-stripping path) with no upside for a single small CLI.
- **Register a nostics console reporter on the catalog** — rejected: every code is thrown, and a reporter fires on the call that builds the diagnostic, so it would print once on creation and again when the throw is rendered. The catalog registers no reporters; the top-level handler is the single output point.

## Consequences

- Error wording and remediation live in one catalog, so messages stay consistent and each failure has a documentable, greppable code. Most thrown-message text is preserved verbatim; two messages that bundled a remedy into the diagnosis (the unknown-Agent-Backend list and the Implementation Issue state-label list) were split so the remedy moved to `fix`, and their exact-text tests were updated deliberately rather than weakened.
- Operators see a `fix` line and a `docs` URL on failures instead of a raw stack. The `KB_*` codes imply per-code documentation pages under `/errors/`; those pages still need to be authored (and, per the nostics registry recipe, a CI check could later assert every code has a matching page).
- New self-raised failures should be added as catalog codes rather than inline `throw new Error`, keeping the single-source-of-truth intact.
