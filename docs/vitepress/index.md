---
layout: home

hero:
  name: Krutrimbox
  text: A code factory for agent-ready GitHub issues
  tagline: A local orchestrator that discovers ready issues, delegates AFK work to sandboxed agents, pauses for human handoffs, and crates AI reviewed PRs.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/quickstart
    - theme: alt
      text: How it works
      link: /guide/concepts/factory-flow
    - theme: alt
      text: View on GitHub
      link: https://github.com/jd-solanki/krutrimbox

features:
  - title: Issue-driven orchestration
    details: Discovers Target Issues labeled ready-for-agent, implements standalone issues directly, or walks a parent's ordered sub-issues in number order.
  - title: Isolated sandboxed agents
    details: Each AFK issue runs in a fresh Codex or Claude Code session inside a Docker Sandbox private clone — agent changes never touch your working tree.
  - title: A read-only security boundary
    details: The sandbox only ever reads GitHub. All commits, pushes, and PR mutations happen on the host with your credential, so a stray agent cannot change GitHub state.
  - title: Human-in-the-loop handoffs
    details: Pauses on ready-for-human issues with an idempotent comment, resumes from Refs commit footers, and routes the final review to the issue author.
---
