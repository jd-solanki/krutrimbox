# Network Policy

Sandboxes need network access for things like GitHub, package registries, and model/tool calls.

For a non-interactive setup, set the default policy before creating sandboxes:

```sh
sbx policy set-default balanced
```

`balanced` is Docker's recommended starting point. It allows common development services and blocks everything else by default.

Other choices:

```sh
sbx policy set-default allow-all
sbx policy set-default deny-all
```

Use `allow-all` only if you intentionally want unrestricted outbound network access from sandboxes. Use `deny-all` only if you are prepared to add explicit allow rules.

You can inspect network policy activity with:

```sh
sbx policy log
```
