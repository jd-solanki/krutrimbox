# Close implementation issues during factory runs

krutrimbox closes each completed AFK Issue immediately after its sandboxed agent session succeeds, rather than relying on GitHub closing keywords or manually linked pull requests to close the issue later. GitHub auto-closes linked issues only when a pull request is merged into the default branch, but Factory Runs need closed Implementation Issues before the final PR merge so later runs can resume by skipping completed work; the parent PRD can still rely on the final linked pull request closing it at merge time.
