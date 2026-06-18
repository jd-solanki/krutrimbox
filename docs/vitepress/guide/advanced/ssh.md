# SSH Remotes

krutrimbox works unchanged when your repository's `origin` is an SSH remote — the sandbox never needs your SSH config or keys.

## How it works

Every git read inside a Target Issue Sandbox goes over **HTTPS**, authenticated by the read-only `github` secret (see [Authentication](../authentication)). Before any remote operation, krutrimbox rewrites the cloned sandbox's `origin` to its HTTPS GitHub form. So the sandbox authenticates with a token, not with keys, and never reads `~/.ssh`.

This covers the awkward cases:

- **A plain SSH remote** — `git@github.com:owner/repo.git` — is rewritten to its `https://github.com/owner/repo.git` form for sandbox reads.
- **An `~/.ssh/config` host alias** — such as `git@github-personal:owner/repo.git`, where `github-personal` is an alias you defined locally — resolves to `github.com`. The sandbox doesn't have your SSH config, so an alias would otherwise be unresolvable; krutrimbox normalizes it.
- **A real (dotted) SSH host** — for example a GitHub Enterprise host like `git@github.example.com:...` — is preserved, so Enterprise remotes keep pointing at the right server.

## The host push is separate

Only the sandbox's reads are rewritten to HTTPS. The Target Issue Branch **push** runs on the host, using your own git credentials directly — so an SSH `origin` works there too, with whatever keys and config you already have. This split keeps the write path on your machine while the sandbox stays read-only over HTTPS.
