import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFsWorkspaceStore } from "../../src/adapters/fs-workspace-store";
import { createNodeFileSystem } from "../../src/adapters/node-filesystem";
import { createMappingId } from "../../src/shared/id";
import { isErr, isOk } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gistjet-ws-"));
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

function sampleWorkspace(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    schema_version: 1,
    workspace_id: "01HXWORKSPACE00000000000000",
    scratch_dir: "./scratch",
    defaults: { visibility: "secret" },
    ignore: { workspace_patterns: [".env*"], respect_gitignore: false },
    mappings: [],
    ...overrides,
  };
}

function sampleMapping(overrides: Partial<Mapping> = {}): Mapping {
  return {
    id: createMappingId(),
    local_path: "./notes/a.md",
    gist_id: "gist-abc",
    kind: "file",
    visibility: "secret",
    sync_mode: "manual",
    status: "active",
    created_at: "2026-04-17T00:00:00Z",
    last_synced_at: null,
    last_remote_revision: null,
    last_local_hash: null,
    file_snapshots: [],
    ...overrides,
  };
}

describe("FsWorkspaceStore.load (task 4.2)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("returns E_NOT_INITIALIZED when .gistjet.json is absent", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isErr(res) && res.error.code).toBe("E_NOT_INITIALIZED");
  });

  it("loads and returns a valid WorkspaceFile", async () => {
    const ws = sampleWorkspace({ mappings: [sampleMapping()] });
    await fs.writeFile(path.join(tmp, ".gistjet.json"), JSON.stringify(ws, null, 2), "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.schema_version).toBe(1);
    expect(res.value.mappings).toHaveLength(1);
    expect(res.value.mappings[0]?.status).toBe("active");
  });

  it("returns E_PARSE when the file is not valid JSON", async () => {
    await fs.writeFile(path.join(tmp, ".gistjet.json"), "{not json", "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isErr(res) && res.error.code).toBe("E_PARSE");
    if (!isErr(res) || res.error.code !== "E_PARSE") return;
    expect(typeof res.error.cause).toBe("string");
    expect(res.error.cause.length).toBeGreaterThan(0);
  });

  it("returns E_PARSE when the JSON violates the schema", async () => {
    const broken = { ...sampleWorkspace(), defaults: { visibility: "other-thing" } };
    await fs.writeFile(path.join(tmp, ".gistjet.json"), JSON.stringify(broken), "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isErr(res) && res.error.code).toBe("E_PARSE");
  });

  it("returns E_PARSE when a mapping has an invalid status", async () => {
    const ws = sampleWorkspace({
      mappings: [{ ...sampleMapping(), status: "frozen" as unknown as Mapping["status"] }],
    });
    await fs.writeFile(path.join(tmp, ".gistjet.json"), JSON.stringify(ws), "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isErr(res) && res.error.code).toBe("E_PARSE");
  });

  it("returns E_PARSE when a mapping id is not a valid ULID", async () => {
    const ws = sampleWorkspace({
      mappings: [{ ...sampleMapping(), id: "not-a-ulid" }],
    });
    await fs.writeFile(path.join(tmp, ".gistjet.json"), JSON.stringify(ws), "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isErr(res) && res.error.code).toBe("E_PARSE");
  });

  it("returns E_SCHEMA_NEWER when the stored schema_version exceeds the supported version", async () => {
    const ws = { ...sampleWorkspace(), schema_version: 2 };
    await fs.writeFile(path.join(tmp, ".gistjet.json"), JSON.stringify(ws), "utf8");
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const res = await store.load(tmp);
    expect(isErr(res) && res.error.code).toBe("E_SCHEMA_NEWER");
    if (!isErr(res) || res.error.code !== "E_SCHEMA_NEWER") return;
    expect(res.error.found).toBe(2);
    expect(res.error.required).toBe(1);
  });
});

describe("FsWorkspaceStore.writeAtomic (task 4.2)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("writes the JSON payload and round-trips through load", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const ws = sampleWorkspace({ mappings: [sampleMapping()] });
    const writeRes = await store.writeAtomic(tmp, ws);
    expect(isOk(writeRes)).toBe(true);
    const loaded = await store.load(tmp);
    expect(isOk(loaded) && loaded.value.mappings[0]?.gist_id).toBe("gist-abc");
  });

  it("produces a pretty-printed UTF-8 JSON file at .gistjet.json with no temp sibling lingering", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    await store.writeAtomic(tmp, sampleWorkspace());
    const raw = await fs.readFile(path.join(tmp, ".gistjet.json"), "utf8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw)).toMatchObject({ schema_version: 1 });
    const entries = await fs.readdir(tmp);
    expect(entries).toEqual([".gistjet.json"]);
  });

  it("preserves the original file when a write of an invalid value is attempted", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const original = sampleWorkspace({ mappings: [sampleMapping()] });
    await store.writeAtomic(tmp, original);
    const bogus = { ...original, defaults: { visibility: "nope" } } as unknown as WorkspaceFile;
    const res = await store.writeAtomic(tmp, bogus);
    expect(isErr(res)).toBe(true);
    const stillThere = await store.load(tmp);
    expect(isOk(stillThere) && stillThere.value.mappings).toHaveLength(1);
  });

  it("accepts mappings carrying ULID ids produced by createMappingId", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const id = createMappingId();
    const ws = sampleWorkspace({ mappings: [sampleMapping({ id })] });
    const res = await store.writeAtomic(tmp, ws);
    expect(isOk(res)).toBe(true);
    const loaded = await store.load(tmp);
    expect(isOk(loaded) && loaded.value.mappings[0]?.id).toBe(id);
  });
});

describe("FsWorkspaceStore.withLock (task 4.2)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("serializes concurrent invocations for the same root", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const order: string[] = [];
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const a = store.withLock(tmp, async () => {
      order.push("a:start");
      await delay(20);
      order.push("a:end");
    });
    const b = store.withLock(tmp, async () => {
      order.push("b:start");
      await delay(5);
      order.push("b:end");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("returns the value produced by fn", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    const result = await store.withLock(tmp, async () => 42);
    expect(result).toBe(42);
  });

  it("releases the lock when fn throws so a later caller can acquire it", async () => {
    const store = createFsWorkspaceStore({ fs: createNodeFileSystem() });
    await expect(
      store.withLock(tmp, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await store.withLock(tmp, async () => "after");
    expect(after).toBe("after");
  });
});
