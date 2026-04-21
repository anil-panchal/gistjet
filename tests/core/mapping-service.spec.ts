import { describe, expect, it } from "vitest";

import { createMappingService } from "../../src/core/mapping-service";
import type { GhError, GitHubGistPort } from "../../src/shared/ports/github-gist";
import type { WorkspaceStorePort } from "../../src/shared/ports/workspace-store";
import { err, ok } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

const ROOT = "/tmp/ws";

function mkMapping(overrides: Partial<Mapping> = {}): Mapping {
  return {
    id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    local_path: "src/notes.md",
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

function createFakeStore(initial: WorkspaceFile): {
  store: WorkspaceStorePort;
  writes: WorkspaceFile[];
  lockCalls: { n: number };
} {
  const lockCalls = { n: 0 };
  const state: { current: WorkspaceFile } = { current: initial };
  const writes: WorkspaceFile[] = [];
  const store: WorkspaceStorePort = {
    async load() {
      return ok(state.current);
    },
    async writeAtomic(_root, next) {
      state.current = next;
      writes.push(next);
      return ok(undefined);
    },
    async withLock(_root, fn) {
      lockCalls.n += 1;
      return fn();
    },
  };
  return { store, writes, lockCalls };
}

type DeleteResult = Awaited<ReturnType<GitHubGistPort["delete"]>>;

function createFakeGist(opts: { deleteResult?: DeleteResult } = {}): {
  port: GitHubGistPort;
  deleteCalls: string[];
} {
  const deleteCalls: string[] = [];
  const notImpl = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  const port: GitHubGistPort = {
    create: notImpl,
    update: notImpl,
    get: notImpl,
    list: notImpl,
    async delete(gistId) {
      deleteCalls.push(gistId);
      return opts.deleteResult ?? ok(undefined);
    },
    fetchRaw: notImpl,
    probeGistAccess: notImpl,
  };
  return { port, deleteCalls };
}

type LogEntry = {
  readonly level: string;
  readonly event: string;
  readonly payload?: Record<string, unknown>;
};
function createSpyLogger(): {
  logger: {
    child: () => typeof spyLogger;
    debug: (e: string, p?: Record<string, unknown>) => void;
    info: (e: string, p?: Record<string, unknown>) => void;
    warn: (e: string, p?: Record<string, unknown>) => void;
    error: (e: string, p: Record<string, unknown>) => void;
  };
  entries: LogEntry[];
} {
  const entries: LogEntry[] = [];
  const spyLogger = {
    child: () => spyLogger,
    debug: (event: string, payload?: Record<string, unknown>) =>
      entries.push({ level: "debug", event, ...(payload ? { payload } : {}) }),
    info: (event: string, payload?: Record<string, unknown>) =>
      entries.push({ level: "info", event, ...(payload ? { payload } : {}) }),
    warn: (event: string, payload?: Record<string, unknown>) =>
      entries.push({ level: "warn", event, ...(payload ? { payload } : {}) }),
    error: (event: string, payload: Record<string, unknown>) =>
      entries.push({ level: "error", event, payload }),
  };
  return { logger: spyLogger, entries };
}

describe("MappingService.list & get (task 8.2, req 6.1)", () => {
  it("lists every mapping currently in the workspace", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "g1" });
    const b = mkMapping({ id: "01HBBBBBBBBBBBBBBBBBBBBBBB", gist_id: "g2", local_path: "b.md" });
    const { store } = createFakeStore(mkWorkspace([a, b]));
    const { port } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("returns a mapping by id", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA" });
    const { store } = createFakeStore(mkWorkspace([a]));
    const { port } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.get("01HAAAAAAAAAAAAAAAAAAAAAAA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gist_id).toBe("gist-abc");
  });

  it("returns E_NOT_FOUND for an unknown mapping id", async () => {
    const { store } = createFakeStore(mkWorkspace([]));
    const { port } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.get("missing-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_FOUND");
  });
});

describe("MappingService.unlink without remote delete (task 8.2, req 6.1, 6.2)", () => {
  it("removes the mapping from the workspace without calling any GitHub delete endpoint", async () => {
    const target = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const other = mkMapping({
      id: "01HBBBBBBBBBBBBBBBBBBBBBBB",
      gist_id: "gist-b",
      local_path: "other.md",
    });
    const { store, writes, lockCalls } = createFakeStore(mkWorkspace([target, other]));
    const { port, deleteCalls } = createFakeGist();
    const { logger, entries } = createSpyLogger();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT, logger });
    const result = await svc.unlink({ selector: { mappingId: target.id } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removedMapping.id).toBe(target.id);
    expect(result.value.deletedRemote).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.mappings.map((m) => m.id)).toEqual([other.id]);
    expect(deleteCalls).toEqual([]);
    expect(lockCalls.n).toBe(1);
    const unlinkEvent = entries.find((e) => e.event === "mapping.unlinked");
    expect(unlinkEvent).toBeDefined();
    expect(unlinkEvent?.payload?.mapping_id).toBe(target.id);
    expect(unlinkEvent?.payload?.deleted_remote).toBe(false);
  });

  it("allows selecting by gistId", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const { store, writes } = createFakeStore(mkWorkspace([a]));
    const { port } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.unlink({ selector: { gistId: "gist-a" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removedMapping.id).toBe(a.id);
    expect(writes[0]?.mappings).toEqual([]);
  });

  it("returns E_NOT_FOUND when no mapping matches the selector", async () => {
    const { store, writes } = createFakeStore(mkWorkspace([]));
    const { port } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.unlink({ selector: { mappingId: "nope" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_FOUND");
    expect(writes).toHaveLength(0);
  });
});

describe("MappingService.unlink with remote delete gate (task 8.2, req 6.3)", () => {
  it("rejects delete_remote_gist when confirm_delete is missing", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const { store, writes } = createFakeStore(mkWorkspace([a]));
    const { port, deleteCalls } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.unlink({
      selector: { mappingId: a.id },
      deleteRemoteGist: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_INPUT");
    expect(deleteCalls).toEqual([]);
    expect(writes).toHaveLength(0);
  });

  it("rejects delete_remote_gist when confirm_delete is explicitly false", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const { store } = createFakeStore(mkWorkspace([a]));
    const { port } = createFakeGist();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.unlink({
      selector: { mappingId: a.id },
      deleteRemoteGist: true,
      confirmDelete: false,
    });
    expect(result.ok).toBe(false);
  });

  it("deletes the remote gist and removes the mapping when confirm_delete is true", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const { store, writes } = createFakeStore(mkWorkspace([a]));
    const { port, deleteCalls } = createFakeGist();
    const { logger, entries } = createSpyLogger();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT, logger });
    const result = await svc.unlink({
      selector: { mappingId: a.id },
      deleteRemoteGist: true,
      confirmDelete: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedRemote).toBe(true);
    expect(deleteCalls).toEqual(["gist-a"]);
    expect(writes[0]?.mappings).toEqual([]);
    const remoteEvent = entries.find((e) => e.event === "mapping.remote_deleted");
    expect(remoteEvent).toBeDefined();
    expect(remoteEvent?.payload?.gist_id).toBe("gist-a");
  });

  it("propagates upstream gist errors without removing the local mapping (req 6.3: write follows delete)", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const { store, writes } = createFakeStore(mkWorkspace([a]));
    const { port } = createFakeGist({
      deleteResult: err<GhError>({ code: "E_AUTH", detail: "missing_permission" }),
    });
    const { logger, entries } = createSpyLogger();
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT, logger });
    const result = await svc.unlink({
      selector: { mappingId: a.id },
      deleteRemoteGist: true,
      confirmDelete: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_AUTH");
    expect(writes).toHaveLength(0);
    const failure = entries.find((e) => e.event === "mapping.remote_delete_failed");
    expect(failure).toBeDefined();
  });

  it("propagates rate-limit errors with resetAt", async () => {
    const a = mkMapping({ id: "01HAAAAAAAAAAAAAAAAAAAAAAA", gist_id: "gist-a" });
    const { store } = createFakeStore(mkWorkspace([a]));
    const { port } = createFakeGist({
      deleteResult: err<GhError>({ code: "E_RATE_LIMIT", resetAt: "2026-04-17T22:00:00.000Z" }),
    });
    const svc = createMappingService({ store, gistPort: port, workspaceRoot: ROOT });
    const result = await svc.unlink({
      selector: { mappingId: a.id },
      deleteRemoteGist: true,
      confirmDelete: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_RATE_LIMIT");
  });
});
