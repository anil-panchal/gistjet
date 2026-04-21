import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createConflictResolver } from "../../src/core/conflict-resolver";
import { createDiffService } from "../../src/core/diff-service";
import { createStatusService } from "../../src/core/status-service";
import type { GistFull } from "../../src/shared/gist";
import type { FileContent, FileInfo, FileSystemPort } from "../../src/shared/ports/filesystem";
import type { GhError, GitHubGistPort } from "../../src/shared/ports/github-gist";
import type { WorkspaceStorePort } from "../../src/shared/ports/workspace-store";
import { err, ok } from "../../src/shared/result";
import type { FileSnapshot, Mapping, WorkspaceFile } from "../../src/shared/workspace";

const ROOT = "/tmp/ws";

function sha256(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
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
  id: string;
  localPath: string;
  content: string;
  revision?: string;
  status?: Mapping["status"];
}): Mapping {
  const filename = path.basename(opts.localPath);
  const snap = mkSnapshot(filename, opts.content);
  return {
    id: opts.id,
    local_path: opts.localPath,
    gist_id: `gist-${opts.id}`,
    kind: "file",
    visibility: "secret",
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
  gistId: string;
  revision?: string;
  files: Record<string, string>;
}): GistFull {
  const files = Object.entries(opts.files).map(([filename, content]) => ({
    filename,
    sizeBytes: Buffer.byteLength(content, "utf8"),
    isBinary: false,
    truncated: false,
    rawUrl: null,
    content,
  }));
  return {
    gistId: opts.gistId,
    htmlUrl: `https://gist.github.com/${opts.gistId}`,
    description: null,
    public: false,
    updatedAt: "2026-04-17T00:00:00Z",
    revision: opts.revision ?? "rev-1",
    files,
  };
}

function createFakeFs(files: Record<string, string>): FileSystemPort {
  // Auto-register any parent directories referenced by file paths so that
  // stat(dir) succeeds for folder mappings.
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    let current = path.dirname(p);
    while (current !== path.dirname(current)) {
      dirs.add(current);
      current = path.dirname(current);
    }
  }
  return {
    async stat(p) {
      if (dirs.has(p)) {
        const info: FileInfo = {
          absolutePath: p,
          relativePath: path.basename(p),
          sizeBytes: 0,
          isDirectory: true,
          isBinaryHint: false,
          mtimeMs: 0,
        };
        return ok(info);
      }
      if (!(p in files)) return err({ code: "E_NOT_FOUND" });
      const info: FileInfo = {
        absolutePath: p,
        relativePath: path.basename(p),
        sizeBytes: Buffer.byteLength(files[p] ?? "", "utf8"),
        isDirectory: false,
        isBinaryHint: false,
        mtimeMs: 0,
      };
      return ok(info);
    },
    async read(p) {
      if (!(p in files)) return err({ code: "E_NOT_FOUND" });
      const content: FileContent = { kind: "text", value: files[p] ?? "", encoding: "utf8" };
      return ok(content);
    },
    async writeAtomic() {
      return ok(undefined);
    },
    async *enumerate() {},
  };
}

function createFakeStore(ws: WorkspaceFile): WorkspaceStorePort {
  return {
    async load() {
      return ok(ws);
    },
    async writeAtomic() {
      return ok(undefined);
    },
    async withLock(_r, fn) {
      return fn();
    },
  };
}

function createFakeGist(remotes: Record<string, GistFull | GhError>): GitHubGistPort {
  const notImpl = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  return {
    create: notImpl,
    update: notImpl,
    async get(gistId) {
      const r = remotes[gistId];
      if (!r) return err({ code: "E_NOT_FOUND", resource: gistId });
      if ("code" in r) return err(r);
      return ok(r);
    },
    list: notImpl,
    delete: notImpl,
    fetchRaw: notImpl,
    probeGistAccess: notImpl,
  };
}

function createSvc(opts: {
  fs: FileSystemPort;
  store: WorkspaceStorePort;
  gistPort: GitHubGistPort;
}) {
  return createStatusService({
    fs: opts.fs,
    store: opts.store,
    gistPort: opts.gistPort,
    conflictResolver: createConflictResolver(),
    diffService: createDiffService(),
    workspaceRoot: ROOT,
  });
}

const MAPPING_ID = "01HSTATAAAAAAAAAAAAAAAAAAA";
const filePath = path.join(ROOT, "notes.md");

describe("StatusService.forMapping classifications (task 8.5, req 4.1, 4.5, 4.6)", () => {
  it("returns in_sync when local and remote match the last-known hashes", async () => {
    const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "hi\n" });
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "hi\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({ gistId: mapping.gist_id, files: { "notes.md": "hi\n" } }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("in_sync");
  });

  it("returns local_ahead when only the local content has changed", async () => {
    const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "old\n" });
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "new\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({
          gistId: mapping.gist_id,
          files: { "notes.md": "old\n" },
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("local_ahead");
  });

  it("returns remote_ahead when only the remote revision has changed", async () => {
    const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "hi\n" });
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "hi\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({
          gistId: mapping.gist_id,
          files: { "notes.md": "hi\n" },
          revision: "rev-9",
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("remote_ahead");
  });

  it("returns diverged when both sides have moved", async () => {
    const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "base\n" });
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "local-new\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({
          gistId: mapping.gist_id,
          files: { "notes.md": "remote-new\n" },
          revision: "rev-42",
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("diverged");
  });

  it("returns orphaned when the remote gist is gone (without mutating the mapping)", async () => {
    const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "hi\n" });
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "hi\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({}),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("orphaned");
  });

  it("returns local_missing when the mapped path is absent and does NOT fetch the remote (req 4.6)", async () => {
    const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "hi\n" });
    let getCalls = 0;
    const remotes = {
      [mapping.gist_id]: mkRemoteGist({ gistId: mapping.gist_id, files: { "notes.md": "hi\n" } }),
    };
    const port: GitHubGistPort = {
      ...createFakeGist(remotes),
      async get(gistId) {
        getCalls += 1;
        return createFakeGist(remotes).get(gistId);
      },
    };
    const svc = createSvc({
      fs: createFakeFs({}),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: port,
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.classification).toBe("local_missing");
    expect(getCalls).toBe(0);
  });

  it("returns E_NOT_FOUND when the mapping does not exist", async () => {
    const svc = createSvc({
      fs: createFakeFs({}),
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({}),
    });
    const result = await svc.forMapping("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_FOUND");
  });
});

describe("StatusService per-file diffs (task 8.5, req 4.3, 4.4)", () => {
  const mapping = mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "old\n" });

  it("includes a unified diff when includeDiffs=true and content fits in the size cap", async () => {
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "new\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({
          gistId: mapping.gist_id,
          files: { "notes.md": "old\n" },
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID, { includeDiffs: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.files.find((f) => f.filename === "notes.md");
    expect(entry?.change).toBe("modified");
    expect(entry?.diff).toContain("+new");
    expect(entry?.diff).toContain("-old");
    expect(entry?.diffTruncated).toBeFalsy();
  });

  it("omits diffs and returns summary-only entries when includeDiffs is not set", async () => {
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "new\n" }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({
          gistId: mapping.gist_id,
          files: { "notes.md": "old\n" },
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.files[0];
    expect(entry?.diff).toBeUndefined();
  });

  it("replaces oversize diffs with a truncated summary (req 4.4)", async () => {
    const huge = "x".repeat(2_000);
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: huge }),
      store: createFakeStore(mkWorkspace([mapping])),
      gistPort: createFakeGist({
        [mapping.gist_id]: mkRemoteGist({
          gistId: mapping.gist_id,
          files: { "notes.md": "old\n" },
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID, {
      includeDiffs: true,
      diffSizeLimitBytes: 256,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.files[0];
    expect(entry?.diff).toBeUndefined();
    expect(entry?.diffTruncated).toBe(true);
    expect(entry?.sizeBytes).toBeGreaterThan(256);
  });

  it("reports unchanged files when both sides are identical and includeDiffs=true", async () => {
    const svc = createSvc({
      fs: createFakeFs({ [filePath]: "hi\n" }),
      store: createFakeStore(
        mkWorkspace([mkFileMapping({ id: MAPPING_ID, localPath: filePath, content: "hi\n" })]),
      ),
      gistPort: createFakeGist({
        [`gist-${MAPPING_ID}`]: mkRemoteGist({
          gistId: `gist-${MAPPING_ID}`,
          files: { "notes.md": "hi\n" },
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID, { includeDiffs: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.change).toBe("unchanged");
  });

  it("reports added files present only on the remote side", async () => {
    const dirPath = path.join(ROOT, "mod");
    const aSha = sha256("AA");
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
      last_local_hash: aggregate([{ relative_path: "a.md", contentSha: aSha }]),
      file_snapshots: [
        {
          gist_filename: "a.md",
          relative_path: "a.md",
          size_bytes: 2,
          is_binary: false,
          local_hash: aSha,
        },
      ],
    };
    const svc = createSvc({
      fs: createFakeFs({ [path.join(dirPath, "a.md")]: "AA" }),
      store: createFakeStore(mkWorkspace([folderMapping])),
      gistPort: createFakeGist({
        "gist-folder": mkRemoteGist({
          gistId: "gist-folder",
          files: { "a.md": "AA", "b.md": "BB-NEW" },
          revision: "rev-99",
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = result.value.files.find((f) => f.filename === "b.md");
    expect(added?.change).toBe("added");
  });

  it("reports deleted files present locally but missing on the remote", async () => {
    const dirPath = path.join(ROOT, "mod");
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
    const svc = createSvc({
      fs: createFakeFs({
        [path.join(dirPath, "a.md")]: "AA",
        [path.join(dirPath, "b.md")]: "BB",
      }),
      store: createFakeStore(mkWorkspace([folderMapping])),
      gistPort: createFakeGist({
        "gist-folder": mkRemoteGist({
          gistId: "gist-folder",
          files: { "a.md": "AA" },
          revision: "rev-42",
        }),
      }),
    });
    const result = await svc.forMapping(MAPPING_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const deleted = result.value.files.find((f) => f.filename === "b.md");
    expect(deleted?.change).toBe("deleted");
  });
});

describe("StatusService.forAll bulk aggregation (task 8.5, req 4.2)", () => {
  it("returns a status entry for every mapping in the workspace", async () => {
    const m1 = mkFileMapping({
      id: "01HFIRSTFIRSTFIRSTFIRSTFIR",
      localPath: path.join(ROOT, "a.md"),
      content: "AA",
    });
    const m2 = mkFileMapping({
      id: "01HSECNDSECNDSECNDSECNDSEC",
      localPath: path.join(ROOT, "b.md"),
      content: "BB",
    });
    const svc = createSvc({
      fs: createFakeFs({
        [path.join(ROOT, "a.md")]: "AA",
        [path.join(ROOT, "b.md")]: "BB-NEW",
      }),
      store: createFakeStore(mkWorkspace([m1, m2])),
      gistPort: createFakeGist({
        [m1.gist_id]: mkRemoteGist({ gistId: m1.gist_id, files: { "a.md": "AA" } }),
        [m2.gist_id]: mkRemoteGist({ gistId: m2.gist_id, files: { "b.md": "BB" } }),
      }),
    });
    const result = await svc.forAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const byId = Object.fromEntries(result.value.map((s) => [s.mappingId, s.classification]));
    expect(byId[m1.id]).toBe("in_sync");
    expect(byId[m2.id]).toBe("local_ahead");
  });

  it("returns an empty list for a workspace with no mappings", async () => {
    const svc = createSvc({
      fs: createFakeFs({}),
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({}),
    });
    const result = await svc.forAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("propagates E_AUTH when the gist fetch fails for any mapping", async () => {
    const m1 = mkFileMapping({
      id: "01HFIRSTFIRSTFIRSTFIRSTFIR",
      localPath: path.join(ROOT, "a.md"),
      content: "AA",
    });
    const svc = createSvc({
      fs: createFakeFs({ [path.join(ROOT, "a.md")]: "AA" }),
      store: createFakeStore(mkWorkspace([m1])),
      gistPort: createFakeGist({
        [m1.gist_id]: { code: "E_AUTH", detail: "invalid_token" },
      }),
    });
    const result = await svc.forAll();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_AUTH");
  });
});
