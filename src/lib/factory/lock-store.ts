import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type TargetIssueLock = {
  release(): Promise<void>;
};

// Acquires Target Issue Locks as exclusive lock directories under `.krutrimbox/locks`.
// `acquire` returns null when the lock already exists (another run holds it).
export class FileTargetIssueLockStore {
  public constructor(private readonly cwd: string) {}

  public async acquire(targetIssueNumber: number): Promise<TargetIssueLock | null> {
    const lockDir = this.lockDir(targetIssueNumber);

    await mkdir(path.dirname(lockDir), { recursive: true });

    try {
      await mkdir(lockDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        return null;
      }

      throw error;
    }

    return {
      release: async () => {
        await rm(lockDir, { recursive: true, force: true });
      }
    };
  }

  // Whether a Target Issue Lock currently exists — a read-only probe for Sandbox
  // Inspection, which reports Sandbox Liveness without ever taking the lock. A held
  // lock means a Factory Run believes it is driving the issue; cross-checked against
  // the Sandboxed Agent process, a held lock with no agent is a crashed run's stale
  // lock rather than a live one.
  public async isHeld(targetIssueNumber: number): Promise<boolean> {
    try {
      await access(this.lockDir(targetIssueNumber));
      return true;
    } catch {
      return false;
    }
  }

  private lockDir(targetIssueNumber: number): string {
    return path.join(this.cwd, ".krutrimbox", "locks", `issue-${targetIssueNumber}.lock`);
  }
}

// Injection seam for the Factory Run, which only ever acquires. The read-only
// `isHeld` probe is deliberately outside it — Sandbox Inspection consumes that
// through its own dependency, so the run path is never asked to provide it.
export type TargetIssueLockStore = Pick<FileTargetIssueLockStore, "acquire">;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
