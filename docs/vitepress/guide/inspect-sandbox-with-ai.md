# Inspect a Sandbox with AI

When a factory run looks stuck, slow, or silent, you rarely need to debug it by hand. Hand the prompt below to a coding agent (Claude Code, Codex, or similar) running from your repository root, and it will inspect the live [Docker Sandbox](./sandbox-template) for you and report **what the inner agent is actually doing** — busy, blocked, wedged, or crashed — with the evidence.

The prompt is deliberately project-agnostic: it reads the sandbox's live process tree and Git state rather than assuming a language, so it works the same whether your project uses npm, pip/uv, Go modules, Cargo, or anything else. It also starts by asking you a short, focused question or two (which Target Issue, what symptom) so the AI hunts for the answer instead of exploring your whole repo and burning tokens.

::: tip For a quick answer, try `kb status` first
If you just want to know whether the agent is busy, stalled, or gone, run `kb status --issue <number>` — it does the same live inspection deterministically and prints a verdict with the evidence, no coding agent or tokens required (see [Troubleshooting](./troubleshooting#a-sandbox-is-left-behind-after-a-failure)). Reach for the prompt below when you want an agent to *reason* about the cause and recommend a fix, not just report the state.
:::

::: tip Target Issue Sandbox names are long and deterministic
A sandbox name is keyed on the repository, the Target Issue, and the agent — `krutrimbox-issue-<number>-<repository-slug>-<fingerprint>-<agent>` (e.g. `krutrimbox-issue-1-acme-webapp-1a2b3c4d-codex`), never just `krutrimbox-issue-1`. The AI resolves the exact name from `sbx ls`.
:::

## How to use it

1. Open your coding agent in the **repository root** of the project krutrimbox is running against (the same directory you launched the factory from). The `-w "$(pwd)"` in the commands depends on this.
2. Make sure the `sbx` CLI is on your `PATH` (`sbx ls` should work).
3. Paste the prompt. Answer the one or two scoping questions it asks, then let it run.

## The prompt

```text
You are helping me inspect a **krutrimbox Docker sandbox** to find out what the
sandboxed coding agent is doing right now. krutrimbox runs each AFK issue as a
fresh agent (Claude Code or Codex) inside a Docker Sandbox managed by the `sbx`
CLI. It may be stuck, slow, failed — or I may just want a status.

Your job is to INSPECT and REPORT, not to do the project's work: do not write
code, edit files, or fix the issue unless I explicitly ask afterwards. Stay
read-only. Be economical — stop as soon as you can answer "what is the agent
doing and why", instead of exploring the repository.

## Step 0 — Scope it before spending tokens
Run `sbx ls` first, then:
- If exactly one krutrimbox sandbox is running, assume that one.
- If several are running, or none clearly matches, ask me which Target Issue
  number you were running (names look like
  krutrimbox-issue-<n>-<repo-slug>-<fingerprint>-<agent>).
- Unless I already told you, ask what symptom prompted this (stuck / errored /
  just a status check) and roughly how long it has been running.
Ask these in ONE short batch, then proceed.

## Step 1 — Locate the sandbox and the outer process
- `sbx ls` — find the running sandbox name for my issue.
- On the host: `ps aux | grep -iE 'krutrimbox|sbx exec|claude|codex' | grep -v grep`
  to confirm the outer krutrimbox run and its `sbx exec` are still alive.
- Optionally tail the newest host log for this issue at
  `.krutrimbox/logs/krutrimbox-issue-<n>-*.log`; its last lines show the agent's
  last COMPLETED step. NOTE: this log only flushes when a tool call finishes, so
  a long install/build/test looks frozen here even while the agent is busy — do
  not conclude "stuck" from the host log alone.

## Step 2 — See what the inner agent is doing (the key step)
Inspect the sandbox's live process tree. This is language-agnostic:
  sbx exec -w "$(pwd)" <sandbox-name> -- ps -eo pid,etime,pcpu,stat,args
Interpret it:
- Is the inner agent process (`claude` / `codex`) present? If absent, it exited
  or crashed — jump to Step 4 and read the host log tail for the cause.
- Is a CHILD command running under it (a package install, a build, a test run, a
  migration)? That command IS what the agent is doing right now.
- Judge busy vs wedged from that child:
  - Rising %CPU or growing elapsed time → BUSY (slow, not stuck). Normal for
    dependency installs and builds.
  - 0% CPU, state S/D, unchanged across two checks → possibly BLOCKED (waiting
    on network, disk, or stdin) — investigate in Step 3.
  - A command clearly waiting on interactive input → WEDGED on a prompt.
- If unsure, wait briefly and re-run the same `ps` line to compare elapsed
  time / CPU / command. Do this at most twice.

## Step 3 — If it looks blocked, check network and work state
- Network is the most common cause of a real hang:
    sbx policy ls    — the active allow/deny rules
    sbx policy log   — recently ALLOWED and DENIED hosts; a DENY that lines up
                       with the stuck command is your answer.
- If the running command needs a specific host, test reachability from inside
  the sandbox, substituting the host it uses:
    sbx exec <sandbox-name> -- sh -c 'curl -sS -m 10 -o /dev/null -w "%{http_code} %{time_total}s\n" https://<host>/'
  (e.g. registry.npmjs.org for npm/pnpm, pypi.org for pip/uv, proxy.golang.org
  for Go modules, static.crates.io for Cargo — pick the one the command uses.)
- Work done so far (language-agnostic):
    sbx exec -w "$(pwd)" <sandbox-name> -- git status --short --branch
    sbx exec -w "$(pwd)" <sandbox-name> -- git diff --stat
  Empty diff + a running install/build means it is still in setup and has not
  edited files yet.

## Step 4 — Report back concisely
Give me, in a few lines:
1. Verdict: BUSY (slow) / BLOCKED (why) / WEDGED (on what) / EXITED (crashed) /
   IDLE-DONE.
2. Evidence: the exact inner command running, its elapsed time / CPU, and any
   matching policy DENY or network result.
3. WIP: current branch, and whether files have changed yet.
4. Recommended next action (e.g. "just wait — install in progress", "allow host
   X in the network policy", or "no agent process — read the host log and
   re-run").

Do not remove the sandbox, change files, or alter policy unless I ask you to.
```

## What the AI checks, and why

Each step maps to a specific question about the run:

| Step | Command | Answers |
|---|---|---|
| Locate | `sbx ls`, host `ps aux` | Is the sandbox up and is the outer factory still driving it? |
| Live work | `sbx exec … -- ps -eo pid,etime,pcpu,stat,args` | What command is the inner agent running *right now*? |
| Busy vs wedged | re-run `ps`, compare `etime`/`pcpu` | Is it making progress or frozen? |
| Network | `sbx policy ls`, `sbx policy log` | Did a denied host block it? See [Network Policy](./network-policy). |
| Work state | `git status --short --branch`, `git diff --stat` | Has it edited files yet, or is it still in setup? |

The single most useful line is the inner `ps` in Step 2 — it names the exact command the agent is executing, which is almost always enough to tell "slow install" from "genuinely stuck". A frozen [host log](./troubleshooting#a-sandbox-is-left-behind-after-a-failure) on its own is not evidence of a hang, because krutrimbox only writes a log line when a tool call finishes.

## Useful references

- [Troubleshooting](./troubleshooting) — manual inspection commands and common errors.
- [Network Policy](./network-policy) — allow/deny rules and how to loosen them.
- [Sandbox Template](./sandbox-template) — what tools live inside the sandbox.
