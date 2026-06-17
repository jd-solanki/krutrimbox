# Trigger Factory Runs by the `ready-for-agent` label and issue assignee

krutrimbox processes an issue because it carries the `ready-for-agent` label and is assigned to the **Operator** (the authenticated `gh` user, matched via `assignee:@me`). Applying a label and assigning a user both require GitHub's Triage role or above, so the label-plus-assignee pair is a permission-gated, team-visible trust boundary that an arbitrary issue reporter cannot forge — the label says the work is ready, the assignee says which Operator should run it.

## Considered Options

- **Gate on the issue author** — rejected: opening an issue requires no permission, so the author is not a trust signal; and keying on a specific author identity would bind krutrimbox to one account rather than any authenticated Operator.
- **Configure the Operator username in `.krutrimbox/`** — rejected as the default: the authenticated `gh` user is zero-config and naturally per-operator. A configured identity only matters for a shared bot/CI account and can be added later as an override.

## Consequences

- Anyone with **Triage** permission can trigger an agent run by labelling and assigning an issue. The blast radius is bounded — output is a pull request that still needs human review and merge — but on repositories that grant Triage widely, this widens who can spend agent/compute budget.
- Discovery still requires the native no-parent check (ADR-0014). See ADR-0018 for what "assigned to the Operator" means precisely, and ADR-0019 for how sub-issues route.
