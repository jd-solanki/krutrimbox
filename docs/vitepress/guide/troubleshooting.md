# Troubleshooting

## Existing sandboxes after auth or template changes

Existing sandboxes keep the template and global secrets they were created with. If you created a Target Issue Sandbox before preparing your sandbox template or before setting the global `github` secret, that old sandbox will not automatically gain the missing tool or credential.

List existing sandboxes:

```sh
sbx ls
```

::: tip Target Issue Sandbox names are long and deterministic
A sandbox name is keyed on the repository, the Target Issue, and the agent — `krutrimbox-issue-<number>-<repository-slug>-<fingerprint>-<agent>` (e.g. `krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex`), never just `krutrimbox-issue-1`. Copy the exact name from `sbx ls` and substitute it for `<sandbox-name>` in the commands below.
:::

Check an existing Target Issue Sandbox:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- pnpm --version   # or whatever tool your template adds
sbx exec -w "$(pwd)" <sandbox-name> -- gh auth status
```

If your project's tool is not found or `gh` is not authenticated, inspect for uncommitted work first:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
```

If there is no work to preserve, remove the old sandbox:

```sh
sbx rm --force <sandbox-name>
```

The next factory run will recreate it with the configured template and current global secrets.

## Why commands use `-w "$(pwd)"`

In clone mode, Docker Sandboxes exposes the private repository clone at the original host repository path inside the sandbox.

This works:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
```

This may fail:

```sh
sbx exec <sandbox-name> -- git status --short --branch
```

Without `-w`, `sbx exec` can start in a default directory that is not a Git repository. krutrimbox handles this internally by resolving the host repository path and passing it to `sbx exec --workdir`.

## Common errors

### `ERROR: default network policy has not been configured`

Set a default policy:

```sh
sbx policy set-default balanced
```

Then rerun the factory.

### `fatal: not a git repository`

When debugging manually, include the sandbox workdir:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
```

The factory does this automatically. If you still see this from the factory, reinstall the CLI (`npm install -g krutrimbox`), or rebuild with `pnpm build` if you run from a clone.

### `executable file <tool> not found` (e.g. `pnpm`, `uv`)

The sandbox is missing a tool your project needs. Add it to your [sandbox template](./sandbox-template), reload the image, then recreate any old Target Issue Sandbox that was created before the template existed:

```sh
sbx rm --force <sandbox-name>
```

### `pull failed for image "..."`

The image was built in Docker but never loaded into Docker Sandboxes' separate template store. Load it and verify:

```sh
sbx template load /tmp/my-template-codex.tar
sbx template ls
```

See [Sandbox Template › Build a template](./sandbox-template#build-a-template) for the full build-and-load steps.

### `gh` cannot connect or is not authenticated

This can be either credential (see [Authentication](./authentication)). First check the host GitHub CLI login that the outer process uses for all writes:

```sh
gh auth status
```

If needed:

```sh
gh auth login
```

If instead the failure is inside a sandbox, (re)store the **read-only** `krutrimbox` token as the global `github` secret for future Docker Sandboxes:

```sh
echo "$CREATE_READ_ONLY_TOKEN" | sbx secret set -g github
```

If the Target Issue Sandbox already exists, either remove it after confirming there is no work to preserve:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
sbx rm --force <sandbox-name>
```

Or apply the secret directly to that running sandbox:

```sh
echo "$CREATE_READ_ONLY_TOKEN" | sbx secret set <sandbox-name> github
```

### A sandbox is left behind after a failure

krutrimbox intentionally keeps Target Issue Sandboxes after HITL pauses and failures so you can inspect them.

List sandboxes:

```sh
sbx ls
```

Inspect a Target Issue Sandbox:

```sh
sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
```

Remove it when you are sure no work needs preserving:

```sh
sbx rm --force <sandbox-name>
```

### `krutrimbox: <hook> hook <action> failed` (`KB_R0008`)

A [lifecycle hook](/guide/configuration#hooks) action threw. Hook actions run in order and **fail fast**: the first failing action aborts the run with this error, naming the hook and the action.

For the `pull-request:ready` hook the pull request has **already been marked ready for review** by the time actions run, so a plain re-run finds a ready pull request and skips the hook entirely. Fix the failing action in `.krutrimbox/config.json` (a bad `gh` invocation, an agent prompt that errored, an unreachable interpolation), then re-trigger it yourself — for example by re-running the command an Agent or Command Action wraps.

### Config errors (`KB_C0001`–`KB_C0004`)

`.krutrimbox/config.json` failed to load. These surface before any run work starts:

| Code | Meaning | Fix |
|---|---|---|
| `KB_C0001` | The file is not valid JSON. | Fix the JSON syntax. |
| `KB_C0002` | Valid JSON but the wrong shape. | Match the accepted shape: optional `templates`/`prompts` objects mapping known keys to Markdown paths under `.krutrimbox/`, and an optional `hooks` object mapping a hook name to an array of `{type:"agent"\|"comment"\|"command"}` actions. See [Configuration](./configuration). |
| `KB_C0003` | A configured Template Slot / Prompt path escapes `.krutrimbox/`. | Point the path at a file **inside** `.krutrimbox/`. |
| `KB_C0004` | A configured path resolves inside `.krutrimbox/` but the file is missing. | Create the file, or fix the path. |

## Useful references

- [Factory Flow](/guide/concepts/factory-flow) — the main run loop.
- [Sandbox Template](./sandbox-template) — template setup and the rationale for a custom image.
- Docker Sandboxes template docs: <https://docs.docker.com/ai/sandboxes/customize/templates/>
