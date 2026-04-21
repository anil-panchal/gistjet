import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFsWorkspaceStore } from "../../src/adapters/fs-workspace-store";
import { createNodeFileSystem } from "../../src/adapters/node-filesystem";
import type {
  FileContent,
  FileInfo,
  FileSystemPort,
  ReadError,
  StatError,
  WriteError,
} from "../../src/shared/ports/filesystem";
import { err, isErr, isOk, ok, type Result } from "../../src/shared/result";
import type { WorkspaceFile } from "../../src/shared/workspace";

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gistjet-crash-"));
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

function sampleWorkspace(): WorkspaceFile {
  return {
    schema_version: 1,
    workspace_id: "01HXTESTWORKSPACE0000000000",
    scratch_dir: "./scratch",
    defaults: { visibility: "secret" },
    ignore: { workspace_patterns: [], respect_gitignore: false },
    mappings: [],
  };
}

describe("NodeFileSystem.writeAtomic crash simulation (task 4.4)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
    vi.restoreAllMocks();
  });

  it("leaves the original file intact and removes the temp sibling when rename fails mid-write", async () => {
    const target = path.join(tmp, "state.json");
    await fs.writeFile(target, "ORIGINAL", "utf8");

    const nfs = createNodeFileSystem();
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValue(Object.assign(new Error("simulated crash"), { code: "EXDEV" }));
    const res = await nfs.writeAtomic(target, "NEW-CONTENTS");
    renameSpy.mockRestore();

    expect(isErr(res) && res.error.code).toBe("E_IO");
    expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
    const leftovers = (await fs.readdir(tmp)).filter((name) => name !== "state.json");
    expect(leftovers).toEqual([]);
  });

  it("cleans up the temp sibling even when the write step itself fails mid-payload", async () => {
    const target = path.join(tmp, "state.json");
    await fs.writeFile(target, "ORIGINAL", "utf8");

    const nfs = createNodeFileSystem();
    const openSpy = vi
      .spyOn(fs, "open")
      .mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    const res = await nfs.writeAtomic(target, "NEW");
    openSpy.mockRestore();

    expect(isErr(res) && res.error.code).toBe("E_IO");
    expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
    const leftovers = (await fs.readdir(tmp)).filter((name) => name !== "state.json");
    expect(leftovers).toEqual([]);
  });
});

describe("FsWorkspaceStore.writeAtomic crash simulation (task 4.4)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("preserves the original .gistjet.json when the underlying FileSystemPort.writeAtomic fails", async () => {
    const baseFs = createNodeFileSystem();
    const store = createFsWorkspaceStore({ fs: baseFs });

    const original = sampleWorkspace();
    const first = await store.writeAtomic(tmp, original);
    expect(isOk(first)).toBe(true);
    const originalBytes = await fs.readFile(path.join(tmp, ".gistjet.json"), "utf8");

    const failingFs: FileSystemPort = {
      stat: (p): Promise<Result<FileInfo, StatError>> => baseFs.stat(p),
      read: (p, o): Promise<Result<FileContent, ReadError>> => baseFs.read(p, o),
      writeAtomic: async (): Promise<Result<void, WriteError>> => err({ code: "E_IO" }),
      enumerate: (r) => baseFs.enumerate(r),
    };
    const crashedStore = createFsWorkspaceStore({ fs: failingFs });
    const next = { ...original, workspace_id: "NEW-ID-AFTER-CRASH".padEnd(26, "0") };
    const res = await crashedStore.writeAtomic(tmp, next as WorkspaceFile);
    expect(isErr(res) && res.error.code).toBe("E_IO");

    const after = await fs.readFile(path.join(tmp, ".gistjet.json"), "utf8");
    expect(after).toBe(originalBytes);
    const loaded = await store.load(tmp);
    expect(isOk(loaded) && loaded.value.workspace_id).toBe(original.workspace_id);
  });

  it("surfaces the underlying io error code in the WriteError.cause", async () => {
    const baseFs = createNodeFileSystem();
    const failingFs: FileSystemPort = {
      stat: (p): Promise<Result<FileInfo, StatError>> => baseFs.stat(p),
      read: (p, o): Promise<Result<FileContent, ReadError>> => baseFs.read(p, o),
      writeAtomic: async (): Promise<Result<void, WriteError>> => err({ code: "E_IO" }),
      enumerate: (r) => baseFs.enumerate(r),
    };
    const store = createFsWorkspaceStore({ fs: failingFs });
    const res = await store.writeAtomic(tmp, sampleWorkspace());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_IO");
    expect(res.error.cause).toContain("E_IO");
  });

  it("keeps a valid .gistjet.json reachable via load() after a failed overwrite attempt", async () => {
    const baseFs = createNodeFileSystem();
    const store = createFsWorkspaceStore({ fs: baseFs });

    await store.writeAtomic(tmp, sampleWorkspace());

    // Attempt a write that fails validation — original must survive and stay loadable.
    const bogus = { ...sampleWorkspace(), schema_version: 7 } as unknown as WorkspaceFile;
    const res = await store.writeAtomic(tmp, bogus);
    expect(isErr(res)).toBe(true);

    const loaded = await store.load(tmp);
    expect(isOk(loaded) && loaded.value.schema_version).toBe(1);
  });

  it("silently passes through a successful write when the underlying adapter returns ok()", async () => {
    const baseFs = createNodeFileSystem();
    let calls = 0;
    const countingFs: FileSystemPort = {
      stat: (p): Promise<Result<FileInfo, StatError>> => baseFs.stat(p),
      read: (p, o): Promise<Result<FileContent, ReadError>> => baseFs.read(p, o),
      writeAtomic: async (p, c): Promise<Result<void, WriteError>> => {
        calls++;
        return await baseFs.writeAtomic(p, c);
      },
      enumerate: (r) => baseFs.enumerate(r),
    };
    const store = createFsWorkspaceStore({ fs: countingFs });
    const res = await store.writeAtomic(tmp, sampleWorkspace());
    expect(isOk(res)).toBe(true);
    expect(calls).toBe(1);
  });
});
