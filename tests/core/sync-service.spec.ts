import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConflictResolver } from "../../src/core/conflict-resolver";
import { createIgnoreEngine } from "../../src/core/ignore-engine";
import { createLocalOverwriteGate } from "../../src/core/local-overwrite-gate";
import { createSyncService } from "../../src/core/sync-service";
import type { GistFull } from "../../src/shared/gist";
import type { FileContent, FileInfo, FileSystemPort } from "../../src/shared/ports/filesystem";
import type { GhError, GitHubGistPort, UpdateGistInput } from "../../src/shared/ports/github-gist";
import type { WorkspaceStorePort } from "../../src/shared/ports/workspace-store";
import { err, ok } from "../../src/shared/result";
import type { FileSnapshot, Mapping, WorkspaceFile } from "../../src/shared/workspace";

const ROOT = "/tmp/ws";
const MAPPING_ID = "01HSYNCAAAAAAAAAAAAAAAAAAA";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function aggregate(files: Array<{ relative_path: string; contentSha: string }>): string {
  return sha256(
    files
      .slice()
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path))
      .map((f) => `${f.relative_path}:${f.contentSha}`)
      .join("|"),
  );
}

function mkSnapshot(relativePath: string, content: string): FileSnapshot {
  return {
    gist_filename: relativePath,
    relative_path: relativePath,
    size_bytes: Buffer.byteLength(content, "utf8"),
    is_binary: false,
    local_hash: sha256(content),
  };
}

function mkFileMapping(opts: {
  localPath: string;
  content: string;
  revision?: string;
  visibility?: "secret" | "public";
  status?: Mapping["status"];
}): Mapping {
  const filename = path.basename(opts.localPath);
  const snap = mkSnapshot(filename, opts.content);
  return {
    id: MAPPING_ID,
    local_path: opts.localPath,
    gist_id: "gist-abc",
    kind: "file",
    visibility: opts.visibility ?? "secret",
    sync_mode: "manual",
    status: opts.status ?? "active",
    created_at: "2026-04-17T00:00:00Z",
    last_synced_at: "2026-04-17T00:00:00Z",
    last_remote_revision: opts.revision ?? "rev-1",
    last_local_hash: aggregate([{ relative_path: filename, contentSha: snap.local_hash }]),
    file_snapshots: [snap],
  };
}

function mkWorkspace(mappings: readonly Mapping[]): WorkspaceFile {
  return {
    schema_version: 1,
    workspace_id: "ws-test",
    scratch_dir: "./scratch/",
    defaults: { visibility: "secret" },
    ignore: { workspace_patterns: [], respect_gitignore: false },
    mappings,
  };
}

function mkRemoteGist(opts: {
  gistId?: string;
  public?: boolean;
  revision?: string;
  files: Record<string, string>;
}): GistFull {
  const gistId = opts.gistId ?? "gist-abc";
  const files = Object.entries(opts.files).map(([filename, content]) => ({
    filename,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    isBinary: false,
    truncated: false,
    rawUrl: null,
    content,
  }));
  return {
    gistId,
    htmlUrl: `https://gist.github.com/${gistId}`,
    description: null,
    public: opts.public ?? false,
    updatedAt: "2026-04-17T00:00:00Z",
    revision: opts.revision ?? "rev-1",
    files,
  };
}

type VirtualEntry = { kind: "file"; content: string } | { kind: "dir"; children: string[] };

function createFakeFs(files: Record<string, VirtualEntry>): {
  fs: FileSystemPort;
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
} {
  const state = new Map<string, string>();
  for (const [p, e] of Object.entries(files)) {
    if (e.kind === "file") state.set(p, e.content);
  }
  const writes: Array<{ path: string; content: string }> = [];
  const fs: FileSystemPort = {
    async stat(p) {
      const e = files[p];
      if (!e && !state.has(p)) return err({ code: "E_NOT_FOUND" });
      const isDir = e?.kind === "dir";
      const content = isDir ? "" : (state.get(p) ?? "");
      const info: FileInfo = {
        absolutePath: p,
        relativePath: path.basename(p),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        isDirectory: isDir,
        isBinaryHint: false,
        mtimeMs: 0,
      };
      return ok(info);
    },
    async read(p) {
      if (!state.has(p)) return err({ code: "E_NOT_FOUND" });
      const content: FileContent = { kind: "text", value: state.get(p) ?? "", encoding: "utf8" };
      return ok(content);
    },
    async writeAtomic(p, content) {
      const str = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      state.set(p, str);
      writes.push({ path: p, content: str });
      return ok(undefined);
    },
    async *enumerate() {},
  };
  return { fs, files: state, writes };
}

function createFakeStore(initial: WorkspaceFile): {
  store: WorkspaceStorePort;
  writes: WorkspaceFile[];
  state: { current: WorkspaceFile };
} {
  const state = { current: initial };
  const writes: WorkspaceFile[] = [];
  const store: WorkspaceStorePort = {
    async load() {
      return ok(state.current);
    },
    async writeAtomic(_r, next) {
      state.current = next;
      writes.push(next);
      return ok(undefined);
    },
    async withLock(_r, fn) {
      return fn();
    },
  };
  return { store, writes, state };
}

function createFakeGist(
  opts: {
    remote?: GistFull;
    getError?: GhError;
    updateResult?: { revision: string } | GhError;
  } = {},
): {
  port: GitHubGistPort;
  updates: UpdateGistInput[];
} {
  const updates: UpdateGistInput[] = [];
  const notImpl = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  const port: GitHubGistPort = {
    create: notImpl,
    async update(input) {
      updates.push(input);
      if (opts.updateResult && "code" in opts.updateResult) {
        return err(opts.updateResult);
      }
      return ok({
        ...(opts.remote ?? mkRemoteGist({ files: {} })),
        revision: opts.updateResult?.revision ?? "rev-2",
      });
    },
    async get() {
      if (opts.getError) return err(opts.getError);
      if (!opts.remote) return err({ code: "E_NOT_FOUND", resource: "gist" });
      return ok(opts.remote);
    },
    list: notImpl,
    delete: notImpl,
    fetchRaw: notImpl,
    probeGistAccess: notImpl,
  };
  return { port, updates };
}

type LogEntry = { level: string; event: string; payload?: Record<string, unknown> };
function createSpyLogger(): {
  logger: {
    child: () => typeof spy;
    debug: (e: string, p?: Record<string, unknown>) => void;
    info: (e: string, p?: Record<string, unknown>) => void;
    warn: (e: string, p?: Record<string, unknown>) => void;
    error: (e: string, p: Record<string, unknown>) => void;
  };
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  const spy = {
    child: () => spy,
    debug: (event: string, payload?: Record<string, unknown>) =>
      entries.push({ level: "debug", event, ...(payload ? { payload } : {}) }),
    info: (event: string, payload?: Record<string, unknown>) =>
      entries.push({ level: "info", event, ...(payload ? { payload } : {}) }),
    warn: (event: string, payload?: Record<string, unknown>) =>
      entries.push({ level: "warn", event, ...(payload ? { payload } : {}) }),
    error: (event: string, payload: Record<string, unknown>) =>
      entries.push({ level: "error", event, payload }),
  };
  return { logger: spy, entries };
}

function createSvc(opts: {
  fs: FileSystemPort;
  store: WorkspaceStorePort;
  gistPort: GitHubGistPort;
  logger?: Parameters<typeof createSyncService>[0]["logger"];
}) {
  return createSyncService({
    fs: opts.fs,
    store: opts.store,
    gistPort: opts.gistPort,
    conflictResolver: createConflictResolver(),
    localOverwriteGate: createLocalOverwriteGate(),
    ignoreEngine: createIgnoreEngine(),
    workspaceRoot: ROOT,
    clock: () => new Date("2026-04-17T12:00:00Z"),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}

const filePath = path.join(ROOT, "notes.md");
const localContent = "hello\n";

describe("SyncService local-missing short-circuit (task 8.4, req 3.6)", () => {
  it("returns E_LOCAL_MISSING and promotes mapping status to local_missing when the path is gone", async () => {
    const { fs } = createFakeFs({}); // no file at path
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store, writes } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": localContent } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_LOCAL_MISSING");
    if (result.error.code === "E_LOCAL_MISSING") {
      expect(result.error.path).toBe(filePath);
    }
    const updated = writes[writes.length - 1]?.mappings.find((m) => m.id === mapping.id);
    expect(updated?.status).toBe("local_missing");
  });
});

describe("SyncService orphaned detection (task 8.4, req 3.5)", () => {
  it("marks the mapping orphaned and returns E_ORPHANED when the remote gist is 404", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store, writes } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({ getError: { code: "E_NOT_FOUND", resource: "gist-abc" } });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_ORPHANED");
    const updated = writes[writes.length - 1]?.mappings.find((m) => m.id === mapping.id);
    expect(updated?.status).toBe("orphaned");
  });
});

describe("SyncService visibility drift (task 8.4, req 9.4)", () => {
  it("refuses a sync when remote visibility no longer matches the mapping (E_VISIBILITY_CHANGE_REFUSED)", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({
      localPath: filePath,
      content: localContent,
      visibility: "secret",
    });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port, updates } = createFakeGist({
      remote: mkRemoteGist({ public: true, files: { "notes.md": localContent } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_VISIBILITY_CHANGE_REFUSED");
    expect(updates).toHaveLength(0);
  });
});

describe("SyncService classification and directions (task 8.4, req 3.1, 3.4, 12.x)", () => {
  it("classifies in_sync and updates mapping timestamp without touching the remote", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store, writes } = createFakeStore(mkWorkspace([mapping]));
    const { port, updates } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": localContent } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("in_sync");
    expect(result.value.applied).toBe(true);
    expect(updates).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  it("pushes local changes on local_ahead and updates mapping with new revision", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "new\n" } });
    const { store, writes } = createFakeStore(mkWorkspace([mapping]));
    const { port, updates } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "old\n" }, revision: "rev-1" }),
      updateResult: { revision: "rev-2" },
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("local_ahead");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.files["notes.md"]?.content).toBe("new\n");
    const persisted = writes[writes.length - 1]?.mappings.find((m) => m.id === mapping.id);
    expect(persisted?.last_remote_revision).toBe("rev-2");
  });
});

describe("SyncService pull path + local overwrite gate (task 8.4, req 3.7, 17.1-17.5)", () => {
  it("blocks a remote_ahead pull without confirmOverwriteLocal with E_LOCAL_OVERWRITE_CONFIRM", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const { fs, writes } = createFakeFs({ [filePath]: { kind: "file", content: "old\n" } });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "new\n" }, revision: "rev-2" }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_LOCAL_OVERWRITE_CONFIRM");
    expect(writes.filter((w) => w.path === filePath)).toHaveLength(0);
  });

  it("applies a remote_ahead pull with confirmOverwriteLocal and logs every approved write", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const { fs, writes, files } = createFakeFs({ [filePath]: { kind: "file", content: "old\n" } });
    const { store, writes: wsWrites } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "new\n" }, revision: "rev-2" }),
    });
    const { logger, entries } = createSpyLogger();
    const svc = createSvc({ fs, store, gistPort: port, logger });
    const result = await svc.sync({
      selector: { mappingId: mapping.id },
      confirmOverwriteLocal: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("remote_ahead");
    expect(result.value.applied).toBe(true);
    expect(files.get(filePath)).toBe("new\n");
    expect(writes.some((w) => w.path === filePath && w.content === "new\n")).toBe(true);
    expect(
      wsWrites[wsWrites.length - 1]?.mappings.find((m) => m.id === mapping.id)
        ?.last_remote_revision,
    ).toBe("rev-2");
    const writeEvent = entries.find((e) => e.event === "sync.local_write");
    expect(writeEvent).toBeDefined();
    expect(writeEvent?.payload?.mapping_id).toBe(mapping.id);
  });
});

describe("SyncService diverged strategies (task 8.4, req 12.3, 12.4, 12.5)", () => {
  function setupDiverged(args: {
    onConflict?: "prefer_local" | "prefer_remote" | "abort";
    confirmOverwriteLocal?: boolean;
  }) {
    const mapping = mkFileMapping({ localPath: filePath, content: "base\n" });
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "local-new\n" } });
    const { store, writes: wsWrites } = createFakeStore(mkWorkspace([mapping]));
    const { port, updates } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "remote-new\n" }, revision: "rev-99" }),
      updateResult: { revision: "rev-100" },
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const req: Parameters<ReturnType<typeof createSvc>["sync"]>[0] = {
      selector: { mappingId: mapping.id },
      ...(args.onConflict !== undefined ? { onConflict: args.onConflict } : {}),
      ...(args.confirmOverwriteLocal !== undefined
        ? { confirmOverwriteLocal: args.confirmOverwriteLocal }
        : {}),
    };
    return { svc, mapping, updates, wsWrites, req };
  }

  it("abort: returns E_CONFLICT with a diverged report and makes no writes", async () => {
    const { svc, req, updates, wsWrites } = setupDiverged({ onConflict: "abort" });
    const result = await svc.sync(req);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_CONFLICT");
    if (result.error.code === "E_CONFLICT") {
      expect(result.error.report.classification).toBe("diverged");
    }
    expect(updates).toHaveLength(0);
    expect(wsWrites).toHaveLength(0);
  });

  it("prefer_local: pushes local content to the remote and updates mapping", async () => {
    const { svc, req, updates, mapping, wsWrites } = setupDiverged({ onConflict: "prefer_local" });
    const result = await svc.sync(req);
    expect(result.ok).toBe(true);
    expect(updates[0]?.files["notes.md"]?.content).toBe("local-new\n");
    const persisted = wsWrites[wsWrites.length - 1]?.mappings.find((m) => m.id === mapping.id);
    expect(persisted?.last_remote_revision).toBe("rev-100");
  });

  it("prefer_remote with confirm: pulls remote onto local", async () => {
    const { svc, req } = setupDiverged({
      onConflict: "prefer_remote",
      confirmOverwriteLocal: true,
    });
    const result = await svc.sync(req);
    expect(result.ok).toBe(true);
  });

  it("prefer_remote without confirm: blocked by E_LOCAL_OVERWRITE_CONFIRM", async () => {
    const { svc, req } = setupDiverged({ onConflict: "prefer_remote" });
    const result = await svc.sync(req);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_LOCAL_OVERWRITE_CONFIRM");
  });
});

describe("SyncService dry_run (task 8.4, req 3.3)", () => {
  it("reports the plan with applied=false and makes no remote or local writes", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const { fs, writes: fsWrites } = createFakeFs({
      [filePath]: { kind: "file", content: "new\n" },
    });
    const { store, writes: wsWrites } = createFakeStore(mkWorkspace([mapping]));
    const { port, updates } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "old\n" } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id }, dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);
    expect(result.value.plan.length).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);
    expect(fsWrites).toHaveLength(0);
    expect(wsWrites).toHaveLength(0);
  });
});

describe("SyncService selector + error mapping (task 8.4)", () => {
  it("returns E_NOT_FOUND when no mapping matches the selector", async () => {
    const { fs } = createFakeFs({});
    const { store } = createFakeStore(mkWorkspace([]));
    const { port } = createFakeGist();
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: "no-such" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_FOUND");
  });

  it("finds mappings by local path selector", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": localContent } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { path: filePath } });
    expect(result.ok).toBe(true);
  });

  it("propagates gist E_AUTH errors on push (gist.update failure)", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "new\n" } });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "old\n" } }),
      updateResult: { code: "E_AUTH", detail: "missing_permission" },
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_AUTH");
  });

  it("uses a default clock when none is provided", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": localContent } }),
    });
    const svc = createSyncService({
      fs,
      store,
      gistPort: port,
      conflictResolver: createConflictResolver(),
      localOverwriteGate: createLocalOverwriteGate(),
      ignoreEngine: createIgnoreEngine(),
      workspaceRoot: ROOT,
    });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(true);
  });

  it("returns a LoadError when the workspace is not initialized", async () => {
    const { fs } = createFakeFs({});
    const store: WorkspaceStorePort = {
      async load() {
        return err({ code: "E_NOT_INITIALIZED" });
      },
      async writeAtomic() {
        return ok(undefined);
      },
      async withLock(_r, fn) {
        return fn();
      },
    };
    const { port } = createFakeGist();
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: "any" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_INITIALIZED");
  });

  it("propagates gist E_RATE_LIMIT on fetch with the reset timestamp", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      getError: { code: "E_RATE_LIMIT", resetAt: "2026-04-17T22:30:00.000Z" },
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_RATE_LIMIT");
  });

  it("preserves unrelated mappings in the workspace when updating one", async () => {
    const target = mkFileMapping({ localPath: filePath, content: localContent });
    const other: Mapping = {
      ...target,
      id: "01HOTHEROTHEROTHEROTHEROTH",
      local_path: "/other/path.md",
      gist_id: "g2",
    };
    const { fs } = createFakeFs({});
    const { store, writes } = createFakeStore(mkWorkspace([target, other]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": localContent } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    await svc.sync({ selector: { mappingId: target.id } });
    // local-missing short-circuit promotes target to local_missing; other stays active.
    const persisted = writes[writes.length - 1];
    expect(persisted?.mappings.find((m) => m.id === other.id)?.status).toBe("active");
  });

  it("handles folder mappings by reading per-snapshot relative paths", async () => {
    const dirPath = path.join(ROOT, "mod");
    const aPath = path.join(dirPath, "a.md");
    const bPath = path.join(dirPath, "b.md");
    const aSha = sha256("AA");
    const bSha = sha256("BB");
    const folderMapping: Mapping = {
      id: MAPPING_ID,
      local_path: dirPath,
      gist_id: "gist-folder",
      kind: "folder",
      visibility: "secret",
      sync_mode: "manual",
      status: "active",
      created_at: "2026-04-17T00:00:00Z",
      last_synced_at: "2026-04-17T00:00:00Z",
      last_remote_revision: "rev-1",
      last_local_hash: aggregate([
        { relative_path: "a.md", contentSha: aSha },
        { relative_path: "b.md", contentSha: bSha },
      ]),
      file_snapshots: [
        {
          gist_filename: "a.md",
          relative_path: "a.md",
          size_bytes: 2,
          is_binary: false,
          local_hash: aSha,
        },
        {
          gist_filename: "b.md",
          relative_path: "b.md",
          size_bytes: 2,
          is_binary: false,
          local_hash: bSha,
        },
      ],
    };
    const { fs } = createFakeFs({
      [dirPath]: { kind: "dir", children: ["a.md", "b.md"] },
      [aPath]: { kind: "file", content: "AA" },
      [bPath]: { kind: "file", content: "BB" },
    });
    const { store } = createFakeStore(mkWorkspace([folderMapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ gistId: "gist-folder", files: { "a.md": "AA", "b.md": "BB" } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: folderMapping.id } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("in_sync");
  });

  it("propagates gist E_AUTH errors on fetch", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({ getError: { code: "E_AUTH", detail: "invalid_token" } });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_AUTH");
  });

  it("maps unexpected gist error codes (e.g., E_INTERNAL) to E_IO", async () => {
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: localContent } });
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({ getError: { code: "E_INTERNAL", cause: "boom" } });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_IO");
  });

  it("promotes mapping status to local_missing when fs.read fails after stat succeeds", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: localContent });
    // stat returns ok via our fake (file registered) but read returns E_NOT_FOUND
    // because we only registered it in stat dictionary, not state map.
    const fs: FileSystemPort = {
      async stat() {
        return ok({
          absolutePath: filePath,
          relativePath: "notes.md",
          sizeBytes: 10,
          isDirectory: false,
          isBinaryHint: false,
          mtimeMs: 0,
        });
      },
      async read() {
        return err({ code: "E_IO" });
      },
      async writeAtomic() {
        return ok(undefined);
      },
      async *enumerate() {},
    };
    const { store, writes } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": localContent } }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_LOCAL_MISSING");
    expect(writes[writes.length - 1]?.mappings.find((m) => m.id === mapping.id)?.status).toBe(
      "local_missing",
    );
  });

  it("treats binary-kind reads as empty text so they are detected as local changes rather than crashing", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "" });
    const fs: FileSystemPort = {
      async stat() {
        return ok({
          absolutePath: filePath,
          relativePath: "notes.md",
          sizeBytes: 0,
          isDirectory: false,
          isBinaryHint: true,
          mtimeMs: 0,
        });
      },
      async read() {
        return ok({ kind: "binary", value: new Uint8Array([1, 2, 3]) });
      },
      async writeAtomic() {
        return ok(undefined);
      },
      async *enumerate() {},
    };
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({ remote: mkRemoteGist({ files: { "notes.md": "" } }) });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(true);
  });

  it("treats null remote content as empty string and computes classification without crashing", async () => {
    const mapping: Mapping = {
      ...mkFileMapping({ localPath: filePath, content: "" }),
      last_remote_revision: "",
    };
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "" } });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const customRemote: GistFull = {
      gistId: "gist-abc",
      htmlUrl: "https://gist.github.com/gist-abc",
      description: null,
      public: false,
      updatedAt: "2026-04-17T00:00:00Z",
      revision: "",
      files: [
        {
          filename: "notes.md",
          sizeBytes: 0,
          isBinary: false,
          truncated: false,
          rawUrl: null,
          content: null,
        },
      ],
    };
    const { port } = createFakeGist({ remote: customRemote });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(true);
  });

  it("defaults diverged mappings to E_CONFLICT when onConflict is unspecified", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "base\n" });
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "local-new\n" } });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "remote-new\n" }, revision: "rev-99" }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_CONFLICT");
  });

  it("emits a sync.pushed log event after a successful push when a logger is supplied", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "new\n" } });
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "old\n" } }),
      updateResult: { revision: "rev-2" },
    });
    const { logger, entries } = createSpyLogger();
    const svc = createSvc({ fs, store, gistPort: port, logger });
    await svc.sync({ selector: { mappingId: mapping.id } });
    expect(entries.find((e) => e.event === "sync.pushed")).toBeDefined();
  });

  it("pulls each remote file to its relative path in a folder mapping", async () => {
    const dirPath = path.join(ROOT, "mod");
    const aPath = path.join(dirPath, "a.md");
    const bPath = path.join(dirPath, "b.md");
    const aSha = sha256("AA");
    const bSha = sha256("BB");
    const folderMapping: Mapping = {
      id: MAPPING_ID,
      local_path: dirPath,
      gist_id: "gist-folder",
      kind: "folder",
      visibility: "secret",
      sync_mode: "manual",
      status: "active",
      created_at: "2026-04-17T00:00:00Z",
      last_synced_at: "2026-04-17T00:00:00Z",
      last_remote_revision: "rev-1",
      last_local_hash: aggregate([
        { relative_path: "a.md", contentSha: aSha },
        { relative_path: "b.md", contentSha: bSha },
      ]),
      file_snapshots: [
        {
          gist_filename: "a.md",
          relative_path: "a.md",
          size_bytes: 2,
          is_binary: false,
          local_hash: aSha,
        },
        {
          gist_filename: "b.md",
          relative_path: "b.md",
          size_bytes: 2,
          is_binary: false,
          local_hash: bSha,
        },
      ],
    };
    const { fs, files } = createFakeFs({
      [dirPath]: { kind: "dir", children: ["a.md", "b.md"] },
      [aPath]: { kind: "file", content: "AA" },
      [bPath]: { kind: "file", content: "BB" },
    });
    const { store } = createFakeStore(mkWorkspace([folderMapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({
        gistId: "gist-folder",
        files: { "a.md": "AA-NEW", "b.md": "BB-NEW" },
        revision: "rev-2",
      }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({
      selector: { mappingId: folderMapping.id },
      confirmOverwriteLocal: true,
    });
    expect(result.ok).toBe(true);
    expect(files.get(aPath)).toBe("AA-NEW");
    expect(files.get(bPath)).toBe("BB-NEW");
  });

  it("returns E_IO when fs.writeAtomic fails during a remote→local pull", async () => {
    const mapping = mkFileMapping({ localPath: filePath, content: "old\n" });
    const fs: FileSystemPort = {
      async stat() {
        return ok({
          absolutePath: filePath,
          relativePath: "notes.md",
          sizeBytes: 4,
          isDirectory: false,
          isBinaryHint: false,
          mtimeMs: 0,
        });
      },
      async read() {
        return ok({ kind: "text", value: "old\n", encoding: "utf8" });
      },
      async writeAtomic() {
        return err({ code: "E_IO" });
      },
      async *enumerate() {},
    };
    const { store } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "new\n" }, revision: "rev-2" }),
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({
      selector: { mappingId: mapping.id },
      confirmOverwriteLocal: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_IO");
  });

  it("falls back to currentRemoteRevision when gist.update returns an empty revision", async () => {
    // local_ahead: mapping revision matches remote, but local content differs
    const mapping: Mapping = {
      ...mkFileMapping({ localPath: filePath, content: "old\n", revision: "rev-7" }),
    };
    const { fs } = createFakeFs({ [filePath]: { kind: "file", content: "new\n" } });
    const { store, writes } = createFakeStore(mkWorkspace([mapping]));
    const { port } = createFakeGist({
      remote: mkRemoteGist({ files: { "notes.md": "old\n" }, revision: "rev-7" }),
      updateResult: { revision: "" },
    });
    const svc = createSvc({ fs, store, gistPort: port });
    const result = await svc.sync({ selector: { mappingId: mapping.id } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const persisted = writes[writes.length - 1]?.mappings.find((m) => m.id === mapping.id);
    expect(persisted?.last_remote_revision).toBe("rev-7");
  });
});
