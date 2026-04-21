import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  initWorkspaceInputSchema,
  initWorkspaceInputShape,
  initWorkspaceOutputSchema,
  listGistsInputSchema,
  listGistsInputShape,
  listGistsOutputSchema,
  openGistInputSchema,
  openGistInputShape,
  openGistOutputSchema,
  publishPathInputSchema,
  publishPathInputShape,
  publishPathOutputSchema,
  publishSelectionInputSchema,
  publishSelectionInputShape,
  publishSelectionOutputSchema,
  syncPathInputSchema,
  syncPathInputShape,
  syncPathOutputSchema,
  syncStatusInputSchema,
  syncStatusInputShape,
  syncStatusOutputSchema,
  toolSchemas,
  unlinkMappingInputSchema,
  unlinkMappingInputShape,
  unlinkMappingOutputSchema,
} from "../../src/facade/tool-schemas";

function hasDescription(shape: Record<string, z.ZodTypeAny>, field: string): boolean {
  const node = shape[field];
  if (!node) return false;
  const desc = node.description ?? (node._def as { description?: string }).description;
  return typeof desc === "string" && desc.length > 0;
}

describe("tool-schemas (task 9.1, req 16.3)", () => {
  describe("registry", () => {
    it("exposes all eight MVP tools", () => {
      const names = Object.keys(toolSchemas).sort();
      expect(names).toEqual(
        [
          "init_workspace",
          "list_gists",
          "open_gist",
          "publish_path_to_gist",
          "publish_selection_to_gist",
          "sync_path_to_gist",
          "sync_status",
          "unlink_mapping",
        ].sort(),
      );
    });

    it("each entry carries non-empty description, inputShape, input/output schemas", () => {
      for (const [name, entry] of Object.entries(toolSchemas)) {
        expect(entry.description.length, `${name} description`).toBeGreaterThan(0);
        expect(typeof entry.inputShape, `${name} inputShape`).toBe("object");
        expect(entry.inputSchema, `${name} inputSchema`).toBeDefined();
        expect(entry.outputSchema, `${name} outputSchema`).toBeDefined();
      }
    });
  });

  describe("init_workspace", () => {
    it("parses a minimal valid input with only target_dir", () => {
      const parsed = initWorkspaceInputSchema.parse({ target_dir: "/tmp/ws" });
      expect(parsed.target_dir).toBe("/tmp/ws");
    });

    it("accepts optional scratch_dir and commit_mappings flags", () => {
      const parsed = initWorkspaceInputSchema.parse({
        target_dir: "/tmp/ws",
        scratch_dir: "./scratch/",
        commit_mappings: true,
      });
      expect(parsed.scratch_dir).toBe("./scratch/");
      expect(parsed.commit_mappings).toBe(true);
    });

    it("rejects when target_dir is missing", () => {
      const result = initWorkspaceInputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects when commit_mappings is not a boolean", () => {
      const result = initWorkspaceInputSchema.safeParse({
        target_dir: "/tmp/ws",
        commit_mappings: "yes",
      });
      expect(result.success).toBe(false);
    });

    it("shape fields carry descriptive help text", () => {
      expect(hasDescription(initWorkspaceInputShape, "target_dir")).toBe(true);
      expect(hasDescription(initWorkspaceInputShape, "scratch_dir")).toBe(true);
      expect(hasDescription(initWorkspaceInputShape, "commit_mappings")).toBe(true);
    });

    it("output schema validates a successful init payload", () => {
      const parsed = initWorkspaceOutputSchema.parse({
        workspace_path: "/tmp/ws/.gistjet.json",
        config: {
          schema_version: 1,
          workspace_id: "ws-id",
          scratch_dir: "./scratch/",
          defaults: { visibility: "secret" },
          ignore: { workspace_patterns: [], respect_gitignore: false },
          mappings: [],
        },
        gitignore: {
          action: "appended",
          path: "/tmp/ws/.gitignore",
        },
      });
      expect(parsed.gitignore.action).toBe("appended");
    });
  });

  describe("publish_path_to_gist", () => {
    it("parses a minimal valid input", () => {
      const parsed = publishPathInputSchema.parse({ path: "/tmp/ws/notes.md" });
      expect(parsed.path).toBe("/tmp/ws/notes.md");
    });

    it("accepts every documented optional field", () => {
      const parsed = publishPathInputSchema.parse({
        path: "/tmp/ws/notes.md",
        description: "scratch",
        visibility: "public",
        confirm_public: true,
        acknowledge_findings: ["f1", "f2"],
        allow_binary: false,
      });
      expect(parsed.visibility).toBe("public");
      expect(parsed.confirm_public).toBe(true);
      expect(parsed.acknowledge_findings).toEqual(["f1", "f2"]);
    });

    it("rejects unknown visibility values", () => {
      const result = publishPathInputSchema.safeParse({
        path: "/tmp/ws/notes.md",
        visibility: "private",
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-array acknowledge_findings", () => {
      const result = publishPathInputSchema.safeParse({
        path: "/tmp/ws/notes.md",
        acknowledge_findings: "f1",
      });
      expect(result.success).toBe(false);
    });

    it("describes the confirm_public and allow_binary gating flags", () => {
      expect(hasDescription(publishPathInputShape, "confirm_public")).toBe(true);
      expect(hasDescription(publishPathInputShape, "allow_binary")).toBe(true);
      expect(hasDescription(publishPathInputShape, "acknowledge_findings")).toBe(true);
    });

    it("output schema validates a successful publish payload", () => {
      const parsed = publishPathOutputSchema.parse({
        gist_id: "g1",
        html_url: "https://gist.github.com/u/g1",
        visibility: "secret",
        mapping: {
          id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
          local_path: "notes.md",
          gist_id: "g1",
          kind: "file",
          visibility: "secret",
          sync_mode: "manual",
          status: "active",
          created_at: "2026-04-17T00:00:00Z",
          last_synced_at: "2026-04-17T00:00:00Z",
          last_remote_revision: "rev1",
          last_local_hash: "hash",
          file_snapshots: [],
        },
        ignored_files: [],
        warnings: [],
      });
      expect(parsed.gist_id).toBe("g1");
    });
  });

  describe("publish_selection_to_gist", () => {
    it("requires filename and content", () => {
      const a = publishSelectionInputSchema.safeParse({ content: "x" });
      const b = publishSelectionInputSchema.safeParse({ filename: "a.txt" });
      const c = publishSelectionInputSchema.safeParse({ filename: "a.txt", content: "x" });
      expect(a.success).toBe(false);
      expect(b.success).toBe(false);
      expect(c.success).toBe(true);
    });

    it("accepts confirm_public and visibility", () => {
      const parsed = publishSelectionInputSchema.parse({
        filename: "snippet.md",
        content: "# hi",
        visibility: "public",
        confirm_public: true,
      });
      expect(parsed.visibility).toBe("public");
    });

    it("describes the filename, content, and confirm_public fields", () => {
      expect(hasDescription(publishSelectionInputShape, "filename")).toBe(true);
      expect(hasDescription(publishSelectionInputShape, "content")).toBe(true);
      expect(hasDescription(publishSelectionInputShape, "confirm_public")).toBe(true);
    });

    it("output schema shares the publish output structure", () => {
      const parsed = publishSelectionOutputSchema.safeParse({
        gist_id: "g2",
        html_url: "https://gist.github.com/u/g2",
        visibility: "secret",
        mapping: {
          id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
          local_path: "snippet.md",
          gist_id: "g2",
          kind: "file",
          visibility: "secret",
          sync_mode: "manual",
          status: "active",
          created_at: "2026-04-17T00:00:00Z",
          last_synced_at: null,
          last_remote_revision: null,
          last_local_hash: null,
          file_snapshots: [],
        },
        ignored_files: [],
        warnings: [],
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("sync_path_to_gist", () => {
    it("accepts a mapping_id selector", () => {
      const parsed = syncPathInputSchema.parse({ mapping_id: "abc" });
      expect(parsed.mapping_id).toBe("abc");
    });

    it("accepts a path selector", () => {
      const parsed = syncPathInputSchema.parse({ path: "notes.md" });
      expect(parsed.path).toBe("notes.md");
    });

    it("rejects inputs with neither mapping_id nor path", () => {
      const result = syncPathInputSchema.safeParse({ dry_run: true });
      expect(result.success).toBe(false);
    });

    it("accepts all on_conflict strategies", () => {
      for (const s of ["prefer_local", "prefer_remote", "abort"] as const) {
        const parsed = syncPathInputSchema.safeParse({
          mapping_id: "abc",
          on_conflict: s,
        });
        expect(parsed.success, s).toBe(true);
      }
    });

    it("rejects unknown on_conflict values", () => {
      const result = syncPathInputSchema.safeParse({
        mapping_id: "abc",
        on_conflict: "merge",
      });
      expect(result.success).toBe(false);
    });

    it("accepts sync_direction push and pull", () => {
      expect(
        syncPathInputSchema.safeParse({ mapping_id: "abc", sync_direction: "push" }).success,
      ).toBe(true);
      expect(
        syncPathInputSchema.safeParse({ mapping_id: "abc", sync_direction: "pull" }).success,
      ).toBe(true);
      expect(
        syncPathInputSchema.safeParse({ mapping_id: "abc", sync_direction: "sideways" }).success,
      ).toBe(false);
    });

    it("describes dry_run, on_conflict, sync_direction, and confirm_overwrite_local", () => {
      expect(hasDescription(syncPathInputShape, "dry_run")).toBe(true);
      expect(hasDescription(syncPathInputShape, "on_conflict")).toBe(true);
      expect(hasDescription(syncPathInputShape, "sync_direction")).toBe(true);
      expect(hasDescription(syncPathInputShape, "confirm_overwrite_local")).toBe(true);
    });

    it("output schema validates a successful sync payload", () => {
      const parsed = syncPathOutputSchema.parse({
        classification: "local_ahead",
        plan: [
          {
            filename: "notes.md",
            kind: "modified",
            size_bytes: 10,
          },
        ],
        applied: true,
        new_mapping_state: {
          id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
          local_path: "notes.md",
          gist_id: "g1",
          kind: "file",
          visibility: "secret",
          sync_mode: "manual",
          status: "active",
          created_at: "2026-04-17T00:00:00Z",
          last_synced_at: "2026-04-17T00:00:00Z",
          last_remote_revision: "rev2",
          last_local_hash: "hash2",
          file_snapshots: [],
        },
      });
      expect(parsed.applied).toBe(true);
    });
  });

  describe("sync_status", () => {
    it("accepts empty input (aggregate status)", () => {
      const parsed = syncStatusInputSchema.parse({});
      expect(parsed).toEqual({});
    });

    it("accepts mapping_id and include_diffs", () => {
      const parsed = syncStatusInputSchema.parse({
        mapping_id: "abc",
        include_diffs: true,
      });
      expect(parsed.include_diffs).toBe(true);
    });

    it("describes include_diffs", () => {
      expect(hasDescription(syncStatusInputShape, "include_diffs")).toBe(true);
    });

    it("output schema validates an entries array", () => {
      const parsed = syncStatusOutputSchema.parse({
        entries: [
          {
            mapping_id: "abc",
            classification: "in_sync",
            files: [],
          },
        ],
      });
      expect(parsed.entries).toHaveLength(1);
    });
  });

  describe("list_gists", () => {
    it("accepts empty input", () => {
      expect(listGistsInputSchema.safeParse({}).success).toBe(true);
    });

    it("accepts a filter with visibility and query", () => {
      const parsed = listGistsInputSchema.parse({
        filter: { visibility: "secret", query: "notes" },
        cursor: "page-2",
      });
      expect(parsed.filter?.visibility).toBe("secret");
    });

    it("rejects unknown visibility filter values", () => {
      const result = listGistsInputSchema.safeParse({
        filter: { visibility: "unknown" },
      });
      expect(result.success).toBe(false);
    });

    it("describes filter and cursor", () => {
      expect(hasDescription(listGistsInputShape, "filter")).toBe(true);
      expect(hasDescription(listGistsInputShape, "cursor")).toBe(true);
    });

    it("output schema validates paginated listing", () => {
      const parsed = listGistsOutputSchema.parse({
        items: [
          {
            gist_id: "g1",
            html_url: "https://gist.github.com/u/g1",
            description: null,
            public: false,
            updated_at: "2026-04-17T00:00:00Z",
            filenames: ["notes.md"],
            is_mapped: false,
          },
        ],
        next_cursor: "page-3",
      });
      expect(parsed.items[0]?.gist_id).toBe("g1");
    });
  });

  describe("open_gist", () => {
    it("requires gist_id", () => {
      expect(openGistInputSchema.safeParse({}).success).toBe(false);
    });

    it("accepts include_binary as a boolean", () => {
      const parsed = openGistInputSchema.parse({ gist_id: "g1", include_binary: true });
      expect(parsed.include_binary).toBe(true);
    });

    it("describes gist_id and include_binary", () => {
      expect(hasDescription(openGistInputShape, "gist_id")).toBe(true);
      expect(hasDescription(openGistInputShape, "include_binary")).toBe(true);
    });

    it("output schema validates a gist view", () => {
      const parsed = openGistOutputSchema.parse({
        gist_id: "g1",
        html_url: "https://gist.github.com/u/g1",
        description: "scratch",
        public: false,
        updated_at: "2026-04-17T00:00:00Z",
        revision: "rev1",
        files: [
          {
            filename: "notes.md",
            size_bytes: 12,
            truncated: false,
            content: "hello",
            encoding: "utf8",
          },
        ],
        is_mapped: false,
      });
      expect(parsed.files).toHaveLength(1);
    });
  });

  describe("unlink_mapping", () => {
    it("requires mapping_id or gist_id", () => {
      expect(unlinkMappingInputSchema.safeParse({}).success).toBe(false);
    });

    it("accepts a mapping_id selector", () => {
      const parsed = unlinkMappingInputSchema.parse({ mapping_id: "abc" });
      expect(parsed.mapping_id).toBe("abc");
    });

    it("accepts a gist_id selector", () => {
      const parsed = unlinkMappingInputSchema.parse({ gist_id: "g1" });
      expect(parsed.gist_id).toBe("g1");
    });

    it("accepts delete_remote_gist and confirm_delete booleans", () => {
      const parsed = unlinkMappingInputSchema.parse({
        mapping_id: "abc",
        delete_remote_gist: true,
        confirm_delete: true,
      });
      expect(parsed.delete_remote_gist).toBe(true);
      expect(parsed.confirm_delete).toBe(true);
    });

    it("describes delete_remote_gist and confirm_delete", () => {
      expect(hasDescription(unlinkMappingInputShape, "delete_remote_gist")).toBe(true);
      expect(hasDescription(unlinkMappingInputShape, "confirm_delete")).toBe(true);
    });

    it("output schema validates an unlink response", () => {
      const parsed = unlinkMappingOutputSchema.parse({
        removed_mapping: {
          id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
          local_path: "notes.md",
          gist_id: "g1",
          kind: "file",
          visibility: "secret",
          sync_mode: "manual",
          status: "active",
          created_at: "2026-04-17T00:00:00Z",
          last_synced_at: null,
          last_remote_revision: null,
          last_local_hash: null,
          file_snapshots: [],
        },
        deleted_remote: false,
      });
      expect(parsed.deleted_remote).toBe(false);
    });
  });
});
