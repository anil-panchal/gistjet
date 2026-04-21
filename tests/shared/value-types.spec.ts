import { describe, expect, it } from "vitest";

import type {
  GistAccessProbe,
  GistFileRef,
  GistFull,
  GistMeta,
  GistSummary,
} from "../../src/shared/gist";
import type { FileSnapshot, Mapping, WorkspaceFile } from "../../src/shared/workspace";

describe("WorkspaceFile (task 2.2)", () => {
  it("is constructible with the on-disk snake_case shape", () => {
    const w: WorkspaceFile = {
      schema_version: 1,
      workspace_id: "01HXABC",
      scratch_dir: "./scratch",
      defaults: { visibility: "secret" },
      ignore: { workspace_patterns: [".env*"], respect_gitignore: false },
      mappings: [],
    };
    expect(w.schema_version).toBe(1);
    expect(w.defaults.visibility).toBe("secret");
  });

  it("supports an optional description_prefix in defaults", () => {
    const w: WorkspaceFile = {
      schema_version: 1,
      workspace_id: "x",
      scratch_dir: ".",
      defaults: { visibility: "secret", description_prefix: "gistjet:" },
      ignore: { workspace_patterns: [], respect_gitignore: true },
      mappings: [],
    };
    expect(w.defaults.description_prefix).toBe("gistjet:");
  });
});

describe("Mapping and FileSnapshot (task 2.2)", () => {
  it("Mapping carries id, local_path, gist_id, kind, visibility, sync_mode, status, timestamps, and snapshots", () => {
    const snap: FileSnapshot = {
      gist_filename: "a.md",
      relative_path: "notes/a.md",
      size_bytes: 42,
      is_binary: false,
      local_hash: "sha256-abc",
    };
    const m: Mapping = {
      id: "01HXULID",
      local_path: "./notes",
      gist_id: "gist-abc",
      kind: "folder",
      visibility: "secret",
      sync_mode: "manual",
      status: "active",
      created_at: "2026-04-17T00:00:00Z",
      last_synced_at: null,
      last_remote_revision: null,
      last_local_hash: null,
      file_snapshots: [snap],
    };
    expect(m.status).toBe("active");
    expect(m.file_snapshots[0]?.gist_filename).toBe("a.md");
  });

  it("Mapping.status accepts all four documented states", () => {
    const states: Mapping["status"][] = ["active", "orphaned", "diverged", "local_missing"];
    expect(states).toHaveLength(4);
  });

  it("Mapping.kind accepts file and folder", () => {
    const kinds: Mapping["kind"][] = ["file", "folder"];
    expect(kinds).toHaveLength(2);
  });

  it("Mapping.sync_mode accepts manual and on_demand", () => {
    const modes: Mapping["sync_mode"][] = ["manual", "on_demand"];
    expect(modes).toHaveLength(2);
  });
});

describe("Gist value types (task 2.2)", () => {
  const ref: GistFileRef = {
    filename: "a.md",
    sizeBytes: 10,
    isBinary: false,
    truncated: false,
    rawUrl: "https://gist.githubusercontent.com/x/raw/a.md",
  };

  it("GistMeta carries core identity, visibility, revision, and file summaries", () => {
    const meta: GistMeta = {
      gistId: "abc",
      htmlUrl: "https://gist.github.com/abc",
      description: null,
      public: false,
      updatedAt: "2026-04-17T00:00:00Z",
      revision: "sha1",
      files: [ref],
    };
    expect(meta.public).toBe(false);
    expect(meta.files[0]?.filename).toBe("a.md");
  });

  it("GistFull extends meta with optional content per file (null when truncated)", () => {
    const full: GistFull = {
      gistId: "abc",
      htmlUrl: "https://gist.github.com/abc",
      description: "x",
      public: false,
      updatedAt: "2026-04-17T00:00:00Z",
      revision: "sha1",
      files: [
        { ...ref, content: "hi" },
        { ...ref, filename: "big.bin", truncated: true, content: null },
      ],
    };
    expect(full.files[0]?.content).toBe("hi");
    expect(full.files[1]?.content).toBeNull();
  });

  it("GistSummary exposes the lightweight list-shape", () => {
    const s: GistSummary = {
      gistId: "abc",
      htmlUrl: "https://gist.github.com/abc",
      description: null,
      public: true,
      updatedAt: "2026-04-17T00:00:00Z",
      filenames: ["a.md", "b.md"],
    };
    expect(s.filenames).toHaveLength(2);
  });

  it("GistAccessProbe carries login and the optional scopes header", () => {
    const p: GistAccessProbe = { login: "user", scopesHeader: "gist, repo" };
    const pf: GistAccessProbe = { login: "user", scopesHeader: null };
    expect(p.login).toBe("user");
    expect(pf.scopesHeader).toBeNull();
  });
});
