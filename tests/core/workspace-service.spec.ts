import path from "node:path";

import { describe, expect, it } from "vitest";

import { createWorkspaceService } from "../../src/core/workspace-service";
import type { FileContent, FileInfo, FileSystemPort } from "../../src/shared/ports/filesystem";
import type { WorkspaceStorePort } from "../../src/shared/ports/workspace-store";
import { err, ok } from "../../src/shared/result";
import type { WorkspaceFile } from "../../src/shared/workspace";

const ROOT = "/tmp/ws";
const WORKSPACE_PATH = path.join(ROOT, ".gistjet.json");
const GITIGNORE_PATH = path.join(ROOT, ".gitignore");

type FakeFsOptions = {
  existingFiles?: Record<string, string>;
  writeError?: { path?: string };
};

function createFakeFs(opts: FakeFsOptions = {}): {
  fs: FileSystemPort;
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
} {
  const files = new Map<string, string>(Object.entries(opts.existingFiles ?? {}));
  const writes: Array<{ path: string; content: string }> = [];
  const fs: FileSystemPort = {
    async stat(p) {
      if (files.has(p)) {
        const info: FileInfo = {
          absolutePath: p,
          relativePath: path.basename(p),
          sizeBytes: Buffer.byteLength(files.get(p) ?? "", "utf8"),
          isDirectory: false,
          isBinaryHint: false,
          mtimeMs: 0,
        };
        return ok(info);
      }
      return err({ code: "E_NOT_FOUND" });
    },
    async read(p) {
      if (!files.has(p)) return err({ code: "E_NOT_FOUND" });
      const text = files.get(p) ?? "";
      const content: FileContent = { kind: "text", value: text, encoding: "utf8" };
      return ok(content);
    },
    async writeAtomic(p, content) {
      if (opts.writeError?.path === p) {
        return err({ code: "E_IO" });
      }
      const str = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      files.set(p, str);
      writes.push({ path: p, content: str });
      return ok(undefined);
    },
    async *enumerate(): AsyncIterable<FileInfo> {
      // no-op for tests
    },
  };
  return { fs, files, writes };
}

type FakeStoreOptions = {
  readonly existing?: WorkspaceFile;
  readonly writeFails?: boolean;
};

function createFakeStore(opts: FakeStoreOptions = {}): {
  store: WorkspaceStorePort;
  state: { current: WorkspaceFile | null };
  writes: WorkspaceFile[];
  lockCalls: number;
} {
  const state: { current: WorkspaceFile | null } = { current: opts.existing ?? null };
  const writes: WorkspaceFile[] = [];
  let lockCalls = 0;
  const store: WorkspaceStorePort = {
    async load() {
      if (!state.current) return err({ code: "E_NOT_INITIALIZED" });
      return ok(state.current);
    },
    async writeAtomic(_root, next) {
      if (opts.writeFails) return err({ code: "E_IO", cause: "forced" });
      state.current = next;
      writes.push(next);
      return ok(undefined);
    },
    async withLock(_root, fn) {
      lockCalls += 1;
      return fn();
    },
  };
  return {
    store,
    state,
    writes,
    get lockCalls() {
      return lockCalls;
    },
  } as ReturnType<typeof createFakeStore>;
}

describe("WorkspaceService.init (task 8.1, req 1.1-1.7)", () => {
  it("creates a .gistjet.json with schema_version=1, secret default, hardened ignore patterns, and empty mappings", async () => {
    const { fs } = createFakeFs();
    const { store, writes } = createFakeStore();
    const svc = createWorkspaceService({
      fs,
      store,
      workspaceRoot: ROOT,
      idGenerator: () => "ws_fixed_id",
    });
    const result = await svc.init();
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    const wf = writes[0]!;
    expect(wf.schema_version).toBe(1);
    expect(wf.workspace_id).toBe("ws_fixed_id");
    expect(wf.defaults.visibility).toBe("secret");
    expect(wf.mappings).toEqual([]);
    expect(wf.ignore.workspace_patterns).toEqual(expect.arrayContaining([".env*", ".git/"]));
  });

  it("uses ./scratch/ as the default scratch directory when no scratchDir is passed", async () => {
    const { fs } = createFakeFs();
    const { store, writes } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    await svc.init();
    expect(writes[0]?.scratch_dir).toBe("./scratch/");
  });

  it("records the caller-supplied scratchDir when provided", async () => {
    const { fs } = createFakeFs();
    const { store, writes } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    await svc.init({ scratchDir: "./notes/" });
    expect(writes[0]?.scratch_dir).toBe("./notes/");
  });

  it("refuses to overwrite an existing .gistjet.json with E_EXISTS", async () => {
    const { fs } = createFakeFs({ existingFiles: { [WORKSPACE_PATH]: "{}" } });
    const { store, writes } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_EXISTS");
    if (result.error.code === "E_EXISTS") {
      expect(result.error.path).toBe(WORKSPACE_PATH);
    }
    expect(writes).toHaveLength(0);
  });

  it("returns E_IO when the workspace store write fails", async () => {
    const { fs } = createFakeFs();
    const { store } = createFakeStore({ writeFails: true });
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_IO");
  });

  it("reports workspacePath and config on success", async () => {
    const { fs } = createFakeFs();
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspacePath).toBe(WORKSPACE_PATH);
    expect(result.value.config.schema_version).toBe(1);
  });
});

describe("WorkspaceService .gitignore handling (task 8.1, req 1.6, 1.7)", () => {
  it("creates a .gitignore with the .gistjet.json entry when one does not exist", async () => {
    const { fs, files } = createFakeFs();
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gitignore.action).toBe("created");
    expect(result.value.gitignore.path).toBe(GITIGNORE_PATH);
    expect(files.get(GITIGNORE_PATH)).toContain(".gistjet.json");
  });

  it("appends .gistjet.json to an existing .gitignore that does not already ignore it", async () => {
    const { fs, files } = createFakeFs({
      existingFiles: { [GITIGNORE_PATH]: "node_modules/\n.DS_Store\n" },
    });
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gitignore.action).toBe("appended");
    const updated = files.get(GITIGNORE_PATH) ?? "";
    expect(updated).toContain("node_modules/");
    expect(updated).toContain(".gistjet.json");
  });

  it("reports already_ignored when .gitignore already lists .gistjet.json and does not rewrite", async () => {
    const { fs, writes } = createFakeFs({
      existingFiles: { [GITIGNORE_PATH]: "node_modules/\n.gistjet.json\n" },
    });
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gitignore.action).toBe("already_ignored");
    const gitignoreWrites = writes.filter((w) => w.path === GITIGNORE_PATH);
    expect(gitignoreWrites).toHaveLength(0);
  });

  it("skips .gitignore modification and emits an advisory note when commitMappings is true", async () => {
    const { fs, files, writes } = createFakeFs();
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init({ commitMappings: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gitignore.action).toBe("skipped_commit_mappings");
    expect(result.value.gitignore.advisory).toBeDefined();
    expect(files.has(GITIGNORE_PATH)).toBe(false);
    const gitignoreWrites = writes.filter((w) => w.path === GITIGNORE_PATH);
    expect(gitignoreWrites).toHaveLength(0);
  });

  it("treats commented `#.gistjet.json` entries as NOT ignored and appends a real entry", async () => {
    const { fs, files } = createFakeFs({
      existingFiles: { [GITIGNORE_PATH]: "#.gistjet.json\nnode_modules/\n" },
    });
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.init();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gitignore.action).toBe("appended");
    const updated = files.get(GITIGNORE_PATH) ?? "";
    expect(updated).toMatch(/^\.gistjet\.json$/m);
  });
});

describe("WorkspaceService.get (task 8.1)", () => {
  it("returns E_NOT_INITIALIZED when the workspace has not been created", async () => {
    const { fs } = createFakeFs();
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.get();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_INITIALIZED");
  });

  it("returns the current workspace once initialized", async () => {
    const { fs } = createFakeFs();
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    await svc.init();
    const result = await svc.get();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schema_version).toBe(1);
  });
});

describe("WorkspaceService.update (task 8.1)", () => {
  it("wraps the read+mutate+write cycle in the advisory lock", async () => {
    const { fs } = createFakeFs();
    const fakeStore = createFakeStore();
    const { store } = fakeStore;
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    await svc.init();
    const beforeUpdateLockCalls = fakeStore.lockCalls;
    const result = await svc.update((w) => ({
      ...w,
      scratch_dir: "./lock-updated/",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scratch_dir).toBe("./lock-updated/");
    expect(fakeStore.lockCalls).toBeGreaterThan(beforeUpdateLockCalls);
  });

  it("surfaces load errors when the workspace is not initialized", async () => {
    const { fs } = createFakeFs();
    const { store } = createFakeStore();
    const svc = createWorkspaceService({ fs, store, workspaceRoot: ROOT });
    const result = await svc.update((w) => w);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_INITIALIZED");
  });
});
