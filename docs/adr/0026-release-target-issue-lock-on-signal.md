# Release the Target Issue Lock on signal; guide manual recovery on hard kill

A hard stop during a Factory Run left the Target Issue Lock behind and wedged the
next `kb run` (the lock was only released in a `finally`, which a killed process
never reaches). We register `SIGINT`/`SIGTERM` handlers that release the lock
before re-raising the signal, so Ctrl+C and `SIGTERM` self-clean; an exception
crash is already covered by the existing `finally`. We deliberately did **not**
make the lock liveness-aware (PID/host stamp + auto-reclaim): for a
single-operator local tool the only case that buys is `SIGKILL`/power-loss, which
we instead cover with an "already locked" message that names the exact lock
directory and how to delete it — trading self-healing of a rare case for a far
smaller change.

## Consequences

- A Ctrl+C'd run now releases its lock, so `kb status` reports it **LEFT-BEHIND**,
  not **STALE**; only a hard kill or a between-sessions pause now leaves a STALE
  lock.
- A process killed mid-`acquire()` can still leak a lock, which falls to the same
  manual-clear message rather than being auto-healed.
