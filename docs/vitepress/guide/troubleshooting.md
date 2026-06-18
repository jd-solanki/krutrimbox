# Troubleshooting

## Existing sandboxes after auth or template changes

Existing sandboxes keep the template and global secrets they were created with. If you created a Target Issue Sandbox before preparing your sandbox template or before setting the global `github` secret, that old sandbox will not automatically gain the missing tool or credential.

List existing sandboxes:

```sh
sbx ls
```

Check an existing Target Issue Sandbox:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- pnpm --version   # or whatever tool your template adds
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- gh auth status
```

If your project's tool is not found or `gh` is not authenticated, inspect for uncommitted work first:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- git status --short --branch
```

If there is no work to preserve, remove the old sandbox:

```sh
sbx rm --force krutrimbox-issue-1
```

The next factory run will recreate it with the configured template and current global secrets.

## Why commands use `-w "$(pwd)"`

In clone mode, Docker Sandboxes exposes the private repository clone at the original host repository path inside the sandbox.

This works:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-1 -- git status --short --branch
```

This may fail:

```sh
sbx exec krutrimbox-issue-1 -- git status --short --branch
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
sbx rm --force krutrimbox-issue-<number>-<agent>
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
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
sbx rm --force krutrimbox-issue-<number>-<agent>
```

Or apply the secret directly to that running sandbox:

```sh
echo "$CREATE_READ_ONLY_TOKEN" | sbx secret set krutrimbox-issue-<number>-<agent> github
```

### A sandbox is left behind after a failure

krutrimbox intentionally keeps Target Issue Sandboxes after HITL pauses and failures so you can inspect them.

List sandboxes:

```sh
sbx ls
```

Inspect a Target Issue Sandbox:

```sh
sbx exec -w "$(pwd)" krutrimbox-issue-<number>-<agent> -- git status --short --branch
```

Remove it when you are sure no work needs preserving:

```sh
sbx rm --force krutrimbox-issue-<number>-<agent>
```

## Useful references

- [Factory Flow](/guide/concepts/factory-flow) — the main run loop.
- [Sandbox Template](./sandbox-template) — template setup and the rationale for a custom image.
- Docker Sandboxes template docs: <https://docs.docker.com/ai/sandboxes/customize/templates/>
