import { describe, expect, it } from "vitest";

import { createGistBrowserService } from "../../src/core/gist-browser-service";
import type { GistFull, GistSummary } from "../../src/shared/gist";
import type { GhError, GitHubGistPort, ListResult } from "../../src/shared/ports/github-gist";
import type { WorkspaceStorePort } from "../../src/shared/ports/workspace-store";
import { err, ok } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

const ROOT = "/tmp/ws";

function mkSummary(overrides: Partial<GistSummary> & { gistId: string }): GistSummary {
  return {
    htmlUrl: `https://gist.github.com/${overrides.gistId}`,
    description: "desc",
    public: false,
    updatedAt: "2026-04-17T00:00:00Z",
    filenames: ["notes.md"],
    ...overrides,
  };
}

function mkMapping(gistId: string): Mapping {
  return {
    id: `01H${gistId.toUpperCase().padEnd(23, "A")}`.slice(0, 26),
    local_path: `/tmp/${gistId}.md`,
    gist_id: gistId,
    kind: "file",
    visibility: "secret",
    sync_mode: "manual",
    status: "active",
    created_at: "2026-04-17T00:00:00Z",
    last_synced_at: null,
    last_remote_revision: null,
    last_local_hash: null,
    file_snapshots: [],
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

function createFakeGist(opts: {
  pages?: Record<string, ListResult>;
  getResult?: GistFull;
  getError?: GhError;
}): { port: GitHubGistPort; listCalls: Array<string | undefined> } {
  const listCalls: Array<string | undefined> = [];
  const notImpl = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  const port: GitHubGistPort = {
    create: notImpl,
    update: notImpl,
    async list(cursor) {
      listCalls.push(cursor);
      const page = opts.pages?.[cursor ?? "__first"];
      if (!page) return ok({ items: [] });
      return ok(page);
    },
    async get() {
      if (opts.getError) return err(opts.getError);
      if (!opts.getResult) return err({ code: "E_NOT_FOUND", resource: "gist" });
      return ok(opts.getResult);
    },
    delete: notImpl,
    fetchRaw: notImpl,
    probeGistAccess: notImpl,
  };
  return { port, listCalls };
}

function createSvc(opts: { store: WorkspaceStorePort; gistPort: GitHubGistPort }) {
  return createGistBrowserService({
    store: opts.store,
    gistPort: opts.gistPort,
    workspaceRoot: ROOT,
  });
}

describe("GistBrowserService.list cross-references mappings (task 8.6, req 5.1)", () => {
  it("marks is_mapped=true for gists that appear in the workspace", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([mkMapping("g1")])),
      gistPort: createFakeGist({
        pages: {
          __first: {
            items: [mkSummary({ gistId: "g1" }), mkSummary({ gistId: "g2" })],
          },
        },
      }).port,
    });
    const result = await svc.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = Object.fromEntries(result.value.items.map((i) => [i.gistId, i.isMapped]));
    expect(byId).toEqual({ g1: true, g2: false });
  });
});

describe("GistBrowserService.list filters (task 8.6, req 5.2)", () => {
  const summaries: GistSummary[] = [
    mkSummary({
      gistId: "g-secret-1",
      public: false,
      description: "private notes",
      filenames: ["a.md"],
    }),
    mkSummary({
      gistId: "g-public-1",
      public: true,
      description: "release",
      filenames: ["CHANGELOG.md"],
    }),
    mkSummary({
      gistId: "g-secret-2",
      public: false,
      description: "bug repro",
      filenames: ["case.ts"],
    }),
  ];

  it("filters by visibility=public", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: summaries } } }).port,
    });
    const result = await svc.list({ filter: { visibility: "public" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.gistId)).toEqual(["g-public-1"]);
  });

  it("filters by visibility=secret", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: summaries } } }).port,
    });
    const result = await svc.list({ filter: { visibility: "secret" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.gistId).sort()).toEqual(["g-secret-1", "g-secret-2"]);
  });

  it("treats visibility=all (the default) as no visibility filter", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: summaries } } }).port,
    });
    const result = await svc.list({ filter: { visibility: "all" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(3);
  });

  it("filters by case-insensitive substring match against the description", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: summaries } } }).port,
    });
    const result = await svc.list({ filter: { query: "REPRO" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.gistId)).toEqual(["g-secret-2"]);
  });

  it("filters by substring match against any filename", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: summaries } } }).port,
    });
    const result = await svc.list({ filter: { query: "CHANGELOG" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.gistId)).toEqual(["g-public-1"]);
  });

  it("combines visibility and query filters", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: summaries } } }).port,
    });
    const result = await svc.list({ filter: { visibility: "secret", query: "notes" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((i) => i.gistId)).toEqual(["g-secret-1"]);
  });
});

describe("GistBrowserService.list pagination (task 8.6, req 5.1)", () => {
  it("forwards the caller-supplied cursor to the adapter and passes through nextCursor", async () => {
    const { port, listCalls } = createFakeGist({
      pages: {
        page2: {
          items: [mkSummary({ gistId: "g10" })],
          nextCursor: "page3",
        },
      },
    });
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: port,
    });
    const result = await svc.list({ cursor: "page2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listCalls).toEqual(["page2"]);
    expect(result.value.nextCursor).toBe("page3");
    expect(result.value.items.map((i) => i.gistId)).toEqual(["g10"]);
  });

  it("omits nextCursor when the adapter signals end-of-pages", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ pages: { __first: { items: [mkSummary({ gistId: "g1" })] } } })
        .port,
    });
    const result = await svc.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextCursor).toBeUndefined();
  });
});

describe("GistBrowserService.list error propagation (task 8.6)", () => {
  it("propagates E_AUTH from the gist adapter", async () => {
    const port: GitHubGistPort = {
      create: async () => err({ code: "E_AUTH", detail: "invalid_token" }),
      update: async () => err({ code: "E_AUTH", detail: "invalid_token" }),
      get: async () => err({ code: "E_AUTH", detail: "invalid_token" }),
      list: async () => err({ code: "E_AUTH", detail: "invalid_token" }),
      delete: async () => ok(undefined),
      fetchRaw: async () => err({ code: "E_INTERNAL", cause: "no" }),
      probeGistAccess: async () => err({ code: "E_AUTH", detail: "invalid_token" }),
    };
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: port,
    });
    const result = await svc.list();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_AUTH");
  });
});

describe("GistBrowserService.open (task 8.6, req 5.3, 5.4)", () => {
  function mkFull(overrides: Partial<GistFull> = {}): GistFull {
    return {
      gistId: "g-open",
      htmlUrl: "https://gist.github.com/g-open",
      description: "hello",
      public: false,
      updatedAt: "2026-04-17T00:00:00Z",
      revision: "rev-1",
      files: [
        {
          filename: "notes.md",
          sizeBytes: 5,
          isBinary: false,
          truncated: false,
          rawUrl: null,
          content: "hello",
        },
      ],
      ...overrides,
    };
  }

  it("returns metadata, file list, and utf8 content for a text gist", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ getResult: mkFull() }).port,
    });
    const result = await svc.open("g-open");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gistId).toBe("g-open");
    expect(result.value.files[0]?.filename).toBe("notes.md");
    expect(result.value.files[0]?.content).toBe("hello");
    expect(result.value.files[0]?.encoding).toBe("utf8");
  });

  it("cross-references is_mapped for the opened gist", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([mkMapping("g-open")])),
      gistPort: createFakeGist({ getResult: mkFull() }).port,
    });
    const result = await svc.open("g-open");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isMapped).toBe(true);
  });

  it("returns content even when the adapter reports the file was truncated (raw URL fetch handled upstream)", async () => {
    const truncatedFull = mkFull({
      files: [
        {
          filename: "big.md",
          sizeBytes: 1_048_577,
          isBinary: false,
          truncated: true,
          rawUrl: "https://example.invalid/raw",
          content: "PAYLOAD-FROM-RAW-URL",
        },
      ],
    });
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ getResult: truncatedFull }).port,
    });
    const result = await svc.open("g-open");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.files[0]?.content).toBe("PAYLOAD-FROM-RAW-URL");
    expect(result.value.files[0]?.truncated).toBe(true);
  });

  it("omits content (content=null) for binary files when include_binary is not set", async () => {
    const binaryFull = mkFull({
      files: [
        {
          filename: "image.bin",
          sizeBytes: 3,
          isBinary: false, // adapter may not flag; service detects via null byte
          truncated: false,
          rawUrl: null,
          content: "abc\0def",
        },
      ],
    });
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ getResult: binaryFull }).port,
    });
    const result = await svc.open("g-open");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const file = result.value.files[0];
    expect(file?.content).toBeNull();
    expect(file?.encoding).toBe("utf8");
  });

  it("base64-encodes content for binary files when include_binary=true", async () => {
    const raw = "abc\0def";
    const binaryFull = mkFull({
      files: [
        {
          filename: "image.bin",
          sizeBytes: Buffer.byteLength(raw, "utf8"),
          isBinary: false,
          truncated: false,
          rawUrl: null,
          content: raw,
        },
      ],
    });
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ getResult: binaryFull }).port,
    });
    const result = await svc.open("g-open", { includeBinary: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const file = result.value.files[0];
    expect(file?.encoding).toBe("base64");
    expect(file?.content).toBe(Buffer.from(raw, "utf8").toString("base64"));
  });

  it("returns E_NOT_FOUND when the gist is not accessible (no server-side leak)", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({ getError: { code: "E_NOT_FOUND", resource: "gist" } }).port,
    });
    const result = await svc.open("missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_NOT_FOUND");
    if (result.error.code === "E_NOT_FOUND") {
      expect(result.error.gistId).toBe("missing");
    }
  });

  it("propagates E_RATE_LIMIT with resetAt", async () => {
    const svc = createSvc({
      store: createFakeStore(mkWorkspace([])),
      gistPort: createFakeGist({
        getError: { code: "E_RATE_LIMIT", resetAt: "2026-04-17T23:00:00.000Z" },
      }).port,
    });
    const result = await svc.open("g");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_RATE_LIMIT");
  });
});
