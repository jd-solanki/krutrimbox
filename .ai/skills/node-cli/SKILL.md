---
name: node-cli
description: Patterns and conventions for building Node.js CLI tools — src structure, entry point setup, Commander wiring, and update notifications. Use when creating or modifying a Node.js CLI, adding Commander commands, wiring update-notifier, or asking how to structure a CLI entry point or src directory.
---

# Node CLI

## src structure

```
src/
├── index.ts              # Entry point — wires Commander, calls updateNotifier
├── update-notifier.d.ts  # Type shim for update-notifier package
├── commands/             # One file per CLI command
│   ├── add.ts
│   └── remove.ts
└── lib/                  # Pure domain logic, no Commander concerns
    ├── github.ts
    └── linker.ts
tests/                    # Mirrors src/ structure, one test file per module
├── add.test.ts
└── linker.test.ts
```

**conventions:**
- `commands/` — each file exports a single `Command` instance; all CLI concerns (prompts, flags, output) live here
- `lib/` — framework-agnostic helpers imported by commands; keep them testable in isolation

## Entry point structure

```ts
#!/usr/bin/env node
import { Command } from 'commander'
import updateNotifier from 'update-notifier'
import packageJson from '../package.json' with { type: 'json' }

// Call before parseAsync — notify() defers display to process exit so it
// never interleaves with command output.
updateNotifier({ pkg: packageJson }).notify()

const program = new Command('your-cli')
  .description('...')
  .version(packageJson.version)

program.addCommand(fooCommand)

await program.parseAsync()
```

## Update notifier

Use the [`update-notifier`](https://github.com/sindresorhus/update-notifier) package. It handles background checks (24 h interval), state persistence, CI/TTY/`NO_UPDATE_NOTIFIER` opt-outs automatically.

```bash
pnpm add update-notifier
```

**Where to call it:** top of `index.ts`, before `program.parseAsync()` — not in a `postAction` hook.

**Why before parse:** `notify()` defaults to `defer: true`, registering a `process.on('exit')` listener. Placing it before `parseAsync()` ensures the listener is always registered regardless of which command runs.

**Type shim** (package ships no `.d.ts`):

```ts
// src/update-notifier.d.ts
declare module 'update-notifier' {
  interface Package { name: string; version: string }
  interface Options { pkg: Package; updateCheckInterval?: number; distTag?: string }
  interface NotifyOptions { defer?: boolean; message?: string; isGlobal?: boolean }
  interface Notifier { notify(options?: NotifyOptions): void }
  export default function updateNotifier(options: Options): Notifier
}
```

## Recommended stack

| Concern | Package |
|---|---|
| CLI framework | [`commander`](https://github.com/tj/commander.js) |
| Interactive prompts | [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) |
| Update notifications | [`update-notifier`](https://github.com/sindresorhus/update-notifier) |
| Language | TypeScript |
| Test runner | [`vitest`](https://vitest.dev) |
| Version bumping | [`bumpp`](https://github.com/antfu/bumpp) — bumps `package.json`, commits, tags, and pushes in one step |
| Bundler | [`tsdown`](https://github.com/rolldown/tsdown) |

## package.json essentials

```json
{
  "type": "module",
  "bin": { "your-cli": "./dist/index.js" },
  "engines": { "node": "^24.0.0" }
}
```

## GitHub Workflow

For a complete end-to-end workflow combining npm publish + changelog generation, see `automate-npm-release/EXAMPLE_WORKFLOW.yml` if that skill is installed locally.
