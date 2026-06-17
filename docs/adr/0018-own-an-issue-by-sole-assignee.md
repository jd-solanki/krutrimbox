# Own an issue by sole assignee; `--implement-unassigned` for solo developers

An issue belongs to the Operator only when it is assigned to **exactly** the Operator and nobody else; krutrimbox refuses an issue assigned to one other person (explicitly someone else's), and refuses an issue assigned to multiple people (ambiguous — it cannot decide who implements it). A zero-assignee issue is refused by default and accepted only when the Operator passes `--implement-unassigned`, an escape hatch for solo developers who label issues but do not want to assign every one to themselves.

## Considered Options

- **Any assignee that includes the Operator counts (allow multiple)** — rejected: a single assignee per issue is what guarantees exactly one operator discovers and runs it, which is the cross-machine collision guard for teams (`assignee:@me` returns a shared issue to only one person).
- **A flag that ignores assignment entirely (including taking a sole foreign assignee's issue)** — rejected: an explicit assignment to one other person is a team-visible claim. Ownership takeovers must happen by reassigning on GitHub, not via an invisible local flag.

## Consequences

- `--implement-unassigned` deliberately disables the collision guard (two operators could both grab the same unowned issue), so it is documented as solo-only.
- In batch mode the flag cannot use `assignee:@me` (which excludes unowned issues); discovery falls back to label-only and then keeps only sole-Operator and zero-assignee issues.
