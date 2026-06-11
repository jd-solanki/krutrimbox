---
name: automate-npm-release
description: Automate npm package publishing via GitHub Actions — version bumping with bumpp, npm publish with provenance, and NODE_AUTH_TOKEN/setup-node configuration. Use when setting up or modifying npm publish workflows, npm release pipelines, version bumping, provenance badges, or NPM_TOKEN secrets.
---

# Automate npm Release

## First publish (manual)

npm requires the first publish to be done manually to establish package name and ownership. All future releases are automated.

```bash
npm publish --access public
```

## Automated releases via GitHub Actions

Pushing a `v*` tag triggers the full release pipeline:

```
pnpm release        # bumps version, commits, tags & pushes
      ↓
GitHub Actions workflow triggers on v* tag
      ↓
tests → build → npm publish → GitHub release with changelog
```

### 1. Version bump with bumpp

[`bumpp`](https://github.com/antfu/bumpp) bumps `package.json`, commits, tags, and pushes in one step:

```json
// package.json
"scripts": {
  "release": "bumpp"
}
```

Run `pnpm release` and pick the version increment interactively.

### 2. Workflow trigger

```yaml
on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write   # required for creating GitHub releases
  id-token: write   # required for npm provenance
```

### 3. npm provenance

npm provenance uses GitHub's OIDC token to cryptographically attest that a package was built from a specific repo, commit, and workflow run. Adds a verified provenance badge on the npm package page.

```yaml
- uses: actions/setup-node@v6
  with:
    registry-url: https://registry.npmjs.org  # required — writes .npmrc for auth

- run: npm publish --provenance --access public
  env:
    NODE_AUTH_TOKEN: ${{secrets.NPM_TOKEN}}
```

`setup-node` with `registry-url` auto-configures `.npmrc` to read `NODE_AUTH_TOKEN`. Without `registry-url`, the env var has nothing to hook into and publish fails unauthenticated.

## Reference

- [EXAMPLE_WORKFLOW.yml](EXAMPLE_WORKFLOW.yml) — complete pnpm-based publish workflow with provenance, tests, and changelog generation
