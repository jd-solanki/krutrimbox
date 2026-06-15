import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type TargetIssueLock = {
  release(): Promise<void>;
};

// Acquires Target Issue Locks as exclusive lock directories under `.krutrimbox/locks`.
// `acquire` returns null when the lock already exists (another run holds it).
export class FileTargetIssueLockStore {
  public constructor(private readonly cwd: string) {}

  public async acquire(targetIssueNumber: number): Promise<TargetIssueLock | null> {
    const locksDir = path.join(this.cwd, ".krutrimbox", "locks");
    const lockDir = path.join(locksDir, `issue-${targetIssueNumber}.lock`);

    await mkdir(locksDir, { recursive: true });

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
}

// Injection seam: the public surface of FileTargetIssueLockStore, so fakes need no separate contract.
export type TargetIssueLockStore = Pick<FileTargetIssueLockStore, "acquire">;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
