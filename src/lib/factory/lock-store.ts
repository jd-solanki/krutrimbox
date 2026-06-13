import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type PrdLock = {
  release(): Promise<void>;
};

// Acquires PRD Locks as exclusive lock directories under `.krutrimbox/locks`.
// `acquire` returns null when the lock already exists (another run holds it).
export class FilePrdLockStore {
  public constructor(private readonly cwd: string) {}

  public async acquire(prdNumber: number): Promise<PrdLock | null> {
    const locksDir = path.join(this.cwd, ".krutrimbox", "locks");
    const lockDir = path.join(locksDir, `prd-${prdNumber}.lock`);

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

// Injection seam: the public surface of FilePrdLockStore, so fakes need no separate contract.
export type PrdLockStore = Pick<FilePrdLockStore, "acquire">;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
