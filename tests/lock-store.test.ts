import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileTargetIssueLockStore } from "../src/lib/factory/lock-store";

describe("FileTargetIssueLockStore.isHeld", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "krutrimbox-lock-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("reports no lock before one is acquired", async () => {
    const store = new FileTargetIssueLockStore(cwd);

    await expect(store.isHeld(1)).resolves.toBe(false);
  });

  test("reports a held lock while a run owns it, and none once released", async () => {
    const store = new FileTargetIssueLockStore(cwd);

    const lock = await store.acquire(1);
    expect(lock).not.toBeNull();
    await expect(store.isHeld(1)).resolves.toBe(true);

    // The stale-lock case (#34) is exactly a held lock a crashed run never released;
    // isHeld must keep reporting it until release runs.
    await lock!.release();
    await expect(store.isHeld(1)).resolves.toBe(false);
  });
});

describe("FileTargetIssueLockStore.lockPath", () => {
  test("names the lock directory a stale-lock message points an operator at (#34)", () => {
    const store = new FileTargetIssueLockStore("/repo");

    expect(store.lockPath(34)).toBe(path.join("/repo", ".krutrimbox", "locks", "issue-34.lock"));
  });
});
