# Configuration

krutrimbox ships its built-in prompts and templates as readable Markdown files inside the installed package, so the same defaults apply whether you run from npm or from source. Repositories may keep shared krutrimbox configuration in `.krutrimbox/` and commit files that define team policy, such as `config.json`, comment templates, and review prompts:

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

## Prompt extensions

Sandboxed Agent prompts are **not** overridable — krutrimbox owns their safety boundaries. But each built-in prompt accepts an **append-only Prompt Extension**: a Markdown file whose contents are injected at the tail of the prompt inside a `<repository_instructions>` XML tag. Use it to add repository policy or invoke skills available in your agent setup, without touching krutrimbox's own prompt.

Configure extensions under the `prompts` key, keyed by prompt name. Paths resolve relative to `.krutrimbox/` (same path-escape and symlink guards as templates), and any prompt you omit simply renders an empty instructions block:

```json
{
  "prompts": {
    "afkIssue": "prompts/afk-issue.md"
  }
}
```

| Prompt name   | Built-in Markdown            | Injected into                        |
| ------------- | ---------------------------- | ------------------------------------ |
| `afkIssue`    | `prompts/afk-issue.md`       | the AFK Issue implementation prompt  |

Extensions can only **add** instructions; the built-in prompt states that its own boundaries take precedence, so a Prompt Extension can never relax them. Extension content is injected verbatim and is not scanned for `{{placeholders}}`.

### Example: load skills during implementation

A common use is to tell the agent which **skills** to load while it implements an issue. `.krutrimbox/prompts/afk-issue.md` asks the implementing agent to apply TDD and code-quality skills:

```md
Use the following skills if available to you:

- /tdd
- /comment-code
- /clean-code

Always add JSDoc/docstrings to functions and classes.
```

Because the extension is appended inside `<repository_instructions>`, it steers the agent without touching krutrimbox's own prompt or its safety boundaries. The skills load only if your Agent Backend actually provides them, so list the ones your team relies on.

## Hooks

krutrimbox fires named **hooks** at lifecycle points, and a repository attaches **Hook Actions** to them under the `hooks` key, keyed by hook name. The hook engine is [`hookable`](https://github.com/unjs/hookable). Today there is one hook, `pull-request:ready`: once a Target Issue finishes (every Implementation Issue resolved), krutrimbox marks its Target Issue Pull Request **ready** — the only built-in behavior — and then fires `pull-request:ready` against it. With no actions configured, krutrimbox only marks the pull request ready.

A Hook Action is one of three kinds:

| Action    | Does                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `agent`   | Runs a fresh AI session in the Target Issue Sandbox with your `prompt` (a file under `.krutrimbox/`). Captures its text as `{{steps.<id>.output}}`, and if the session changed code, commits and pushes it. |
| `comment` | Posts `body` as a pull request comment.                                                                 |
| `command` | Runs one allowlisted `gh` command on the host (`run[0]` must be `gh`).                                  |

```json
{
  "hooks": {
    "pull-request:ready": [
      { "type": "agent", "id": "review", "prompt": "prompts/final-review.md" },
      { "type": "comment", "body": "{{steps.review.output}}" },
      { "type": "command", "run": ["gh", "pr", "edit", "{{pr_number}}", "--add-reviewer", "{{target_issue_author}}"] }
    ]
  }
}
```

### Variables

Agent prompts, comment bodies, and command arguments interpolate `{{...}}` placeholders:

| Variable                  | Value                                              |
| ------------------------- | -------------------------------------------------- |
| `{{pr_number}}`           | the Target Issue Pull Request number               |
| `{{pr_url}}`              | the pull request URL                               |
| `{{target_issue_number}}` | the Target Issue number                            |
| `{{target_issue_title}}`  | the Target Issue title                             |
| `{{target_issue_author}}` | the Target Issue author's login                    |
| `{{target_issue_branch}}` | the Target Issue Branch                            |
| `{{operator}}`            | the authenticated GitHub user                      |
| `{{base_branch}}`         | the branch the pull request targets                |
| `{{steps.<id>.output}}`   | an earlier Agent Action's text output, by its `id` |

### Agent actions

An Agent Action owns its whole prompt (unlike the append-only Prompt Extensions above). The session runs with the sandbox's **read-only** GitHub token, so it gathers context itself — for example `gh pr diff {{pr_number}}` — and never mutates GitHub. If it changes code, krutrimbox commits and pushes that change **from the host**, with a message referencing the action and its prompt; these commits carry no `Refs` footer, so they stay out of the Done Set.

### Command actions

`command` actions run on the host with your `gh` credential, spawned directly (no shell). Only a curated set of `gh` verb pairs is allowed:

`pr ready`, `pr edit`, `pr comment`, `pr review`, `issue comment`, `issue edit`, `label create`

Anything else — including `gh api`, `gh secret`, `pr merge`, `pr close`, `issue delete`, and `label delete` — is rejected when the config loads.

### Behavior

- `pull-request:ready` runs **at most once** per Target Issue: marking the pull request ready is the guard, so a later run that finds a ready pull request skips it.
- Actions run in order and **fail fast**: the first failing action aborts the hook with an error naming it. Because the pull request is already marked ready, fix the action and re-run.

### Example: reconstruct krutrimbox's own AI review

krutrimbox uses the `pull-request:ready` hook on its own repository to run an AI review and post it as a comment. `.krutrimbox/config.json`:

```json
{
  "hooks": {
    "pull-request:ready": [
      { "type": "agent", "id": "review", "prompt": "prompts/final-review.md" },
      { "type": "comment", "body": "{{steps.review.output}}" }
    ]
  }
}
```

`.krutrimbox/prompts/final-review.md` is a full review prompt that gathers the diff with read-only `gh`, applies the `/clean-code` skill, and emits a Markdown review body which the `comment` action then posts.

## Invariants

A few invariants stay owned by krutrimbox and are not configurable:

- **Prompts are never overridden.** Project Configuration may append Prompt Extensions, but the built-in prompt body and its safety boundaries always stand. (Hook Agent Actions are a separate, opt-in mechanism with their own prompts.)
- **All GitHub writes happen on the host.** The sandbox only ever reads GitHub; Agent Action commits and `command` actions run host-side with your credential.
- **Factory Comment Markers are injected by krutrimbox** outside your template, so a custom comment body cannot break idempotent comment updates.
- **Invalid configuration fails fast.** Unknown keys, malformed JSON, missing referenced files, paths that escape `.krutrimbox/`, and disallowed `gh` commands stop the run with a clear error rather than silently falling back.

::: tip
krutrimbox also writes generated `logs/` and `locks/` under `.krutrimbox/` at runtime. Keep those out of version control — see [Prepare your repository](./getting-started#prepare-your-repository).
:::
