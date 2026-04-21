import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFsWorkspaceStore,
  LOCK_FILE_NAME,
  LockContentionError,
  STALE_LOCK_MS,
} from "../../src/adapters/fs-workspace-store";
import { createNodeFileSystem } from "../../src/adapters/node-filesystem";

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gistjet-lock-"));
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

async function writeLockFile(
  root: string,
  payload: { pid: number; created_at: string; hostname: string },
): Promise<void> {
  await fs.writeFile(path.join(root, LOCK_FILE_NAME), JSON.stringify(payload), {
    encoding: "utf8",
    flag: "wx",
  });
}

describe("FsWorkspaceStore.withLock file lock (task 4.3)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("creates .gistjet.lock during fn execution with pid, created_at, and hostname", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    let inside: unknown;
    await store.withLock(tmp, async () => {
      const raw = await fs.readFile(path.join(tmp, LOCK_FILE_NAME), "utf8");
      inside = JSON.parse(raw);
    });
    expect(inside).toMatchObject({
      pid: process.pid,
      hostname: os.hostname(),
    });
    const payload = inside as { created_at: string };
    expect(Number.isFinite(Date.parse(payload.created_at))).toBe(true);
  });

  it("removes .gistjet.lock after fn completes successfully", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    await store.withLock(tmp, async () => {
      /* noop */
    });
    await expect(fs.access(path.join(tmp, LOCK_FILE_NAME))).rejects.toThrow();
  });

  it("removes .gistjet.lock after fn throws", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    await expect(
      store.withLock(tmp, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(fs.access(path.join(tmp, LOCK_FILE_NAME))).rejects.toThrow();
  });

  it("throws LockContentionError when a fresh lock file already exists", async () => {
    await writeLockFile(tmp, {
      pid: 99999,
      created_at: new Date().toISOString(),
      hostname: "other-host",
    });
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    let caught: unknown;
    try {
      await store.withLock(tmp, async () => "nope");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LockContentionError);
    const e = caught as LockContentionError;
    expect(e.holder.pid).toBe(99999);
    expect(e.holder.hostname).toBe("other-host");
    expect(e.lockPath).toBe(path.join(tmp, LOCK_FILE_NAME));
    // The foreign lock must be preserved — we are not the owner.
    const raw = await fs.readFile(path.join(tmp, LOCK_FILE_NAME), "utf8");
    expect(JSON.parse(raw).pid).toBe(99999);
  });

  it("reclaims and replaces a stale lock (older than STALE_LOCK_MS) and runs fn", async () => {
    const staleIso = new Date(Date.now() - (STALE_LOCK_MS + 1_000)).toISOString();
    await writeLockFile(tmp, { pid: 1, created_at: staleIso, hostname: "ghost" });
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    let ran = false;
    await store.withLock(tmp, async () => {
      ran = true;
      const raw = await fs.readFile(path.join(tmp, LOCK_FILE_NAME), "utf8");
      const info = JSON.parse(raw) as { pid: number };
      expect(info.pid).toBe(process.pid);
    });
    expect(ran).toBe(true);
    await expect(fs.access(path.join(tmp, LOCK_FILE_NAME))).rejects.toThrow();
  });

  it("treats an unparseable lock file as stale and reclaims it", async () => {
    await fs.writeFile(path.join(tmp, LOCK_FILE_NAME), "{garbage", "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    let ran = false;
    await store.withLock(tmp, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("still serializes in-process callers (no contention error for sequential same-process calls)", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const order: string[] = [];
    const a = store.withLock(tmp, async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 15));
      order.push("a:end");
    });
    const b = store.withLock(tmp, async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("uses an injectable clock to decide staleness (deterministic reclaim)", async () => {
    await writeLockFile(tmp, {
      pid: 1,
      created_at: new Date(1_000_000).toISOString(),
      hostname: "old",
    });
    const simulated = 1_000_000 + STALE_LOCK_MS + 1;
    const store = createFsWorkspaceStore({
      fs: createNodeFileSystem(),
      now: () => simulated,
    });
    let ran = false;
    await store.withLock(tmp, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("LockContentionError.message includes the holder's pid", async () => {
    await writeLockFile(tmp, {
      pid: 4242,
      created_at: new Date().toISOString(),
      hostname: "h",
    });
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    await expect(store.withLock(tmp, async () => undefined)).rejects.toThrow(/4242/);
  });
});
