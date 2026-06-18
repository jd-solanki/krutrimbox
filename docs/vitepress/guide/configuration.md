# Configuration

krutrimbox ships its built-in prompts and templates as readable Markdown files inside the installed package, so the same defaults apply whether you run from npm or from source. Repositories may keep shared krutrimbox configuration in `.krutrimbox/` and commit files that define team policy, such as `config.json` and comment templates:

```text
.krutrimbox/
  config.json
  templates/
    pull-request-body.md
    hitl-pause-comment.md
  prompts/
    afk-issue.md
    final-review.md
```

`.krutrimbox/config.json` may partially override Template Slots by their friendly names. Override paths are resolved relative to `.krutrimbox/`, and any omitted slot falls back to the built-in default:

```json
{
  "templates": {
    "pullRequestBody": "templates/pull-request-body.md",
    "hitlPauseComment": "templates/hitl-pause-comment.md"
  }
}
```

The supported Template Slots, aligned with their built-in Markdown filenames, are:

| Template Slot        | Built-in Markdown                      | Used for                              |
| -------------------- | -------------------------------------- | ------------------------------------- |
| `pullRequestBody`    | `templates/pull-request-body.md`       | the Target Issue Pull Request body    |
| `hitlPauseComment`   | `templates/hitl-pause-comment.md`      | the HITL pause comment                |
| `afkErrorComment`    | `templates/afk-error-comment.md`       | the AFK issue error comment           |
| `finalReviewComment` | `templates/final-review-comment.md`    | the final review comment              |

## Prompt extensions

Sandboxed Agent prompts are **not** overridable — krutrimbox owns their safety boundaries. But each built-in prompt accepts an **append-only Prompt Extension**: a Markdown file whose contents are injected at the tail of the prompt inside a `<repository_instructions>` XML tag. Use it to add repository policy or invoke skills available in your agent setup, without touching krutrimbox's own prompt.

Configure extensions under the `prompts` key, keyed by prompt name. Paths resolve relative to `.krutrimbox/` (same path-escape and symlink guards as templates), and any prompt you omit simply renders an empty instructions block:

```json
{
  "prompts": {
    "afkIssue": "prompts/afk-issue.md",
    "finalReview": "prompts/final-review.md"
  }
}
```

| Prompt name   | Built-in Markdown            | Injected into                        |
| ------------- | ---------------------------- | ------------------------------------ |
| `afkIssue`    | `prompts/afk-issue.md`       | the AFK Issue implementation prompt  |
| `finalReview` | `prompts/final-review.md`    | the final review prompt              |

Extensions can only **add** instructions; the built-in prompt states that its own boundaries take precedence, so a Prompt Extension can never relax them. Extension content is injected verbatim and is not scanned for `{{placeholders}}`.

### Example: load skills during implementation and review

A common use is to tell the agent which **skills** to load while it implements an issue and while it reviews the result. krutrimbox does exactly this on its own repository.

`.krutrimbox/config.json` points both prompts at extension files:

```json
{
  "prompts": {
    "afkIssue": "prompts/afk-issue.md",
    "finalReview": "prompts/final-review.md"
  }
}
```

`.krutrimbox/prompts/afk-issue.md` asks the implementing agent to apply TDD and code-quality skills:

```md
Use the following skills if available to you:

- /tdd
- /comment-code
- /clean-code

Always add JSDoc/docstrings to functions and classes.
```

`.krutrimbox/prompts/final-review.md` points the review session at the matching standard:

```md
Use the following skills if available to you:

- /clean-code

Flag functions or classes that are missing JSDoc/docstrings.
```

Because the extension is appended inside `<repository_instructions>`, it steers the agent without touching krutrimbox's own prompt or its safety boundaries. The skills load only if your Agent Backend actually provides them, so list the ones your team relies on.

## Invariants

A few invariants stay owned by krutrimbox and are not configurable:

- **Prompts are never overridden.** Project Configuration may append Prompt Extensions, but the built-in prompt body and its safety boundaries always stand.
- **Factory Comment Markers are injected by krutrimbox** outside your template, so a custom comment body cannot break idempotent comment updates.
- **Invalid configuration fails fast.** Unknown top-level keys, unknown Template Slots, malformed JSON, missing override files, and paths that escape `.krutrimbox/` stop the run with a clear error rather than silently falling back.

::: tip
krutrimbox also writes generated `logs/` and `locks/` under `.krutrimbox/` at runtime. Keep those out of version control — see [Prepare your repository](./getting-started#prepare-your-repository).
:::
