import { z } from "zod";

// Shared building blocks ---------------------------------------------------

const visibilityEnum = z.enum(["secret", "public"]);
const conflictStrategyEnum = z.enum(["prefer_local", "prefer_remote", "abort"]);
const syncDirectionEnum = z.enum(["push", "pull"]);
const mappingStatusEnum = z.enum(["active", "orphaned", "diverged", "local_missing"]);
const mappingKindEnum = z.enum(["file", "folder"]);
const syncClassificationEnum = z.enum([
  "in_sync",
  "local_ahead",
  "remote_ahead",
  "diverged",
  "orphaned",
  "local_missing",
]);
const fileChangeKindEnum = z.enum(["added", "modified", "renamed", "deleted", "unchanged"]);
const planKindEnum = z.enum(["added", "modified", "deleted"]);

const fileSnapshotSchema = z
  .object({
    gist_filename: z.string(),
    relative_path: z.string(),
    size_bytes: z.number().int().nonnegative(),
    is_binary: z.boolean(),
    local_hash: z.string(),
  })
  .strict();

const mappingSchema = z
  .object({
    id: z.string(),
    local_path: z.string(),
    gist_id: z.string(),
    kind: mappingKindEnum,
    visibility: visibilityEnum,
    sync_mode: z.enum(["manual", "on_demand"]),
    status: mappingStatusEnum,
    created_at: z.string(),
    last_synced_at: z.string().nullable(),
    last_remote_revision: z.string().nullable(),
    last_local_hash: z.string().nullable(),
    file_snapshots: z.array(fileSnapshotSchema),
  })
  .strict();

const workspaceFileSchema = z
  .object({
    schema_version: z.literal(1),
    workspace_id: z.string(),
    scratch_dir: z.string(),
    defaults: z
      .object({
        visibility: z.literal("secret"),
        description_prefix: z.string().optional(),
      })
      .strict(),
    ignore: z
      .object({
        workspace_patterns: z.array(z.string()),
        respect_gitignore: z.boolean(),
      })
      .strict(),
    mappings: z.array(mappingSchema),
  })
  .strict();

const publishWarningSchema = z
  .object({
    kind: z.literal("public_publish"),
    message: z.string(),
  })
  .strict();

const fileStatusSchema = z
  .object({
    filename: z.string(),
    change: fileChangeKindEnum,
    size_bytes: z.number().int().nonnegative(),
    is_binary: z.boolean(),
    diff: z.string().optional(),
    diff_truncated: z.boolean().optional(),
  })
  .strict();

const mappingStatusReportSchema = z
  .object({
    mapping_id: z.string(),
    classification: syncClassificationEnum,
    files: z.array(fileStatusSchema),
  })
  .strict();

const fileChangePlanItemSchema = z
  .object({
    filename: z.string(),
    kind: planKindEnum,
    size_bytes: z.number().int().nonnegative().optional(),
    previous_filename: z.string().optional(),
  })
  .strict();

const gistListItemSchema = z
  .object({
    gist_id: z.string(),
    html_url: z.string(),
    description: z.string().nullable(),
    public: z.boolean(),
    updated_at: z.string(),
    filenames: z.array(z.string()),
    is_mapped: z.boolean(),
    mapping_id: z.string().optional(),
  })
  .strict();

const gistFileViewSchema = z
  .object({
    filename: z.string(),
    size_bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    content: z.string().nullable(),
    encoding: z.enum(["utf8", "base64"]),
  })
  .strict();

// Tool shapes --------------------------------------------------------------

// init_workspace
export const initWorkspaceInputShape = {
  target_dir: z
    .string()
    .min(1)
    .describe(
      "Absolute or workspace-relative directory where the `.gistjet.json` workspace file will be created.",
    ),
  scratch_dir: z
    .string()
    .optional()
    .describe(
      "Optional default scratch workspace directory recorded in `.gistjet.json`. Defaults to `./scratch/` under the workspace root when omitted.",
    ),
  commit_mappings: z
    .boolean()
    .optional()
    .describe(
      "When true, skip adding `.gistjet.json` to `.gitignore` so mapping content is committed to the repository. Use only when you understand that secret gist URLs are not private.",
    ),
} as const;

export const initWorkspaceInputSchema = z.object(initWorkspaceInputShape);
export type InitWorkspaceInput = z.infer<typeof initWorkspaceInputSchema>;

export const initWorkspaceOutputShape = {
  workspace_path: z.string().describe("Absolute path to the created `.gistjet.json` file."),
  config: workspaceFileSchema.describe("The initialized workspace configuration."),
  gitignore: z
    .object({
      action: z.enum(["appended", "created", "already_ignored", "skipped_commit_mappings"]),
      path: z.string(),
      advisory: z.string().optional(),
    })
    .strict()
    .describe("Summary of what `init` did to the workspace's `.gitignore`."),
} as const;

export const initWorkspaceOutputSchema = z.object(initWorkspaceOutputShape);
export type InitWorkspaceOutput = z.infer<typeof initWorkspaceOutputSchema>;

// publish_path_to_gist
export const publishPathInputShape = {
  path: z
    .string()
    .min(1)
    .describe(
      "Workspace-relative or absolute path to a file or folder. Folders publish as a multi-file gist with deterministic flattened filenames.",
    ),
  description: z.string().optional().describe("Optional gist description."),
  visibility: visibilityEnum
    .optional()
    .describe(
      "`secret` (default) keeps the gist unlisted. `public` requires `confirm_public: true` in the same call.",
    ),
  confirm_public: z
    .boolean()
    .optional()
    .describe(
      'Must be `true` when `visibility: "public"` is requested. Without it the call is rejected with `E_VISIBILITY_CONFIRM`.',
    ),
  acknowledge_findings: z
    .array(z.string())
    .optional()
    .describe(
      "List of finding ids to acknowledge so that medium- or low-confidence secret-scan matches no longer block the publish. High-confidence findings remain blocking regardless.",
    ),
  allow_binary: z
    .boolean()
    .optional()
    .describe(
      "When `true`, binary files are base64-encoded and uploaded. Without it, binary content is refused with `E_BINARY`.",
    ),
} as const;

export const publishPathInputSchema = z.object(publishPathInputShape);
export type PublishPathInput = z.infer<typeof publishPathInputSchema>;

const publishOutputShapeBase = {
  gist_id: z.string().describe("Newly created gist's id."),
  html_url: z.string().describe("Canonical HTML URL of the created gist."),
  visibility: visibilityEnum.describe("Resolved visibility of the created gist."),
  mapping: mappingSchema.describe("Persisted local-path ↔ gist mapping entry."),
  ignored_files: z
    .array(z.string())
    .describe("Relative paths filtered out by ignore rules before publish."),
  warnings: z.array(publishWarningSchema).describe("Non-fatal advisories emitted by the pipeline."),
} as const;

export const publishPathOutputShape = publishOutputShapeBase;
export const publishPathOutputSchema = z.object(publishPathOutputShape);
export type PublishPathOutput = z.infer<typeof publishPathOutputSchema>;

// publish_selection_to_gist
export const publishSelectionInputShape = {
  filename: z
    .string()
    .min(1)
    .describe("Gist-visible filename for the buffer content (no directory separators)."),
  content: z.string().describe("Text content to publish. Line endings are normalized to LF."),
  description: z.string().optional().describe("Optional gist description."),
  visibility: visibilityEnum
    .optional()
    .describe(
      "`secret` (default) keeps the gist unlisted. `public` requires `confirm_public: true` in the same call.",
    ),
  confirm_public: z
    .boolean()
    .optional()
    .describe(
      'Must be `true` when `visibility: "public"` is requested. Without it the call is rejected with `E_VISIBILITY_CONFIRM`.',
    ),
  acknowledge_findings: z
    .array(z.string())
    .optional()
    .describe(
      "List of finding ids to acknowledge for medium- or low-confidence secret-scan matches. High-confidence findings remain blocking regardless.",
    ),
} as const;

export const publishSelectionInputSchema = z.object(publishSelectionInputShape);
export type PublishSelectionInput = z.infer<typeof publishSelectionInputSchema>;

export const publishSelectionOutputShape = publishOutputShapeBase;
export const publishSelectionOutputSchema = z.object(publishSelectionOutputShape);
export type PublishSelectionOutput = z.infer<typeof publishSelectionOutputSchema>;

// sync_path_to_gist
export const syncPathInputShape = {
  mapping_id: z
    .string()
    .optional()
    .describe("Mapping id to sync. Either `mapping_id` or `path` must be supplied."),
  path: z
    .string()
    .optional()
    .describe(
      "Workspace-relative path of the mapping to sync. Either `mapping_id` or `path` must be supplied.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe("When `true`, compute the plan without making any GitHub or local writes."),
  on_conflict: conflictStrategyEnum
    .optional()
    .describe(
      "How to resolve a diverged mapping. `prefer_local` overwrites the remote gist; `prefer_remote` pulls remote content into local files (subject to `confirm_overwrite_local`); `abort` (default) returns a conflict report without changes.",
    ),
  sync_direction: syncDirectionEnum
    .optional()
    .describe(
      "`push` (default) writes local changes to the remote gist; `pull` writes remote files into local disk and requires `confirm_overwrite_local: true`.",
    ),
  confirm_overwrite_local: z
    .boolean()
    .optional()
    .describe(
      'Required to be `true` for any remote → local write path (`sync_direction: "pull"` or `on_conflict: "prefer_remote"` on a diverged mapping). Without it the call is rejected with `E_LOCAL_OVERWRITE_CONFIRM`.',
    ),
} as const;

export const syncPathInputSchema = z
  .object(syncPathInputShape)
  .refine((value) => typeof value.mapping_id === "string" || typeof value.path === "string", {
    message: "Either mapping_id or path must be supplied.",
  });
export type SyncPathInput = z.infer<typeof syncPathInputSchema>;

export const syncPathOutputShape = {
  classification: z
    .enum(["in_sync", "local_ahead", "remote_ahead", "diverged", "local_missing"])
    .describe("Final classification computed for this mapping."),
  plan: z
    .array(fileChangePlanItemSchema)
    .describe("Ordered set of file changes the sync would apply or did apply."),
  applied: z
    .boolean()
    .describe("True when the sync performed writes. False on `dry_run` or short-circuit paths."),
  new_mapping_state: mappingSchema.describe(
    "Mapping entry after the sync (hashes, revision, and status updated).",
  ),
  ignored_on_pull: z
    .array(z.string())
    .optional()
    .describe(
      "Planned remote → local writes skipped by the ignore engine (e.g., hardened `.env*`, `.git/`).",
    ),
} as const;

export const syncPathOutputSchema = z.object(syncPathOutputShape);
export type SyncPathOutput = z.infer<typeof syncPathOutputSchema>;

// sync_status
export const syncStatusInputShape = {
  mapping_id: z
    .string()
    .optional()
    .describe("Optional mapping id. When omitted, returns status for every mapping."),
  include_diffs: z
    .boolean()
    .optional()
    .describe(
      "When `true`, include per-file unified diffs in the response subject to the configured diff-size limit.",
    ),
} as const;

export const syncStatusInputSchema = z.object(syncStatusInputShape);
export type SyncStatusInput = z.infer<typeof syncStatusInputSchema>;

export const syncStatusOutputShape = {
  entries: z
    .array(mappingStatusReportSchema)
    .describe("One status report per mapping covered by the request."),
} as const;

export const syncStatusOutputSchema = z.object(syncStatusOutputShape);
export type SyncStatusOutput = z.infer<typeof syncStatusOutputSchema>;

// list_gists
export const listGistsInputShape = {
  filter: z
    .object({
      visibility: z.enum(["all", "public", "secret"]).optional(),
      query: z.string().optional(),
    })
    .strict()
    .optional()
    .describe(
      "Optional visibility filter (`all` | `public` | `secret`) plus a description/filename substring match.",
    ),
  cursor: z
    .string()
    .optional()
    .describe("Opaque pagination cursor returned by a previous `list_gists` call."),
} as const;

export const listGistsInputSchema = z.object(listGistsInputShape);
export type ListGistsInput = z.infer<typeof listGistsInputSchema>;

export const listGistsOutputShape = {
  items: z
    .array(gistListItemSchema)
    .describe(
      "Page of gists. `is_mapped` reflects whether the current workspace already tracks the gist.",
    ),
  next_cursor: z
    .string()
    .optional()
    .describe("Cursor for the next page, or absent when the current page is the last one."),
} as const;

export const listGistsOutputSchema = z.object(listGistsOutputShape);
export type ListGistsOutput = z.infer<typeof listGistsOutputSchema>;

// open_gist
export const openGistInputShape = {
  gist_id: z.string().min(1).describe("Id of the remote gist to open."),
  include_binary: z
    .boolean()
    .optional()
    .describe(
      "When `true`, include binary file contents base64-encoded. Without it, binary files return `null` content.",
    ),
} as const;

export const openGistInputSchema = z.object(openGistInputShape);
export type OpenGistInput = z.infer<typeof openGistInputSchema>;

export const openGistOutputShape = {
  gist_id: z.string(),
  html_url: z.string(),
  description: z.string().nullable(),
  public: z.boolean(),
  updated_at: z.string(),
  revision: z.string(),
  files: z.array(gistFileViewSchema),
  is_mapped: z.boolean(),
  mapping_id: z.string().optional(),
} as const;

export const openGistOutputSchema = z.object(openGistOutputShape);
export type OpenGistOutput = z.infer<typeof openGistOutputSchema>;

// unlink_mapping
export const unlinkMappingInputShape = {
  mapping_id: z
    .string()
    .optional()
    .describe("Mapping id to unlink. Either `mapping_id` or `gist_id` must be supplied."),
  gist_id: z
    .string()
    .optional()
    .describe(
      "Gist id whose mapping should be unlinked. Either `mapping_id` or `gist_id` must be supplied.",
    ),
  delete_remote_gist: z
    .boolean()
    .optional()
    .describe(
      "When `true`, also delete the gist on GitHub. Requires `confirm_delete: true` in the same call.",
    ),
  confirm_delete: z
    .boolean()
    .optional()
    .describe(
      "Must be `true` when `delete_remote_gist: true`. Without it the call is rejected and no remote deletion happens.",
    ),
} as const;

export const unlinkMappingInputSchema = z
  .object(unlinkMappingInputShape)
  .refine((value) => typeof value.mapping_id === "string" || typeof value.gist_id === "string", {
    message: "Either mapping_id or gist_id must be supplied.",
  });
export type UnlinkMappingInput = z.infer<typeof unlinkMappingInputSchema>;

export const unlinkMappingOutputShape = {
  removed_mapping: mappingSchema.describe("The mapping entry removed from `.gistjet.json`."),
  deleted_remote: z
    .boolean()
    .describe(
      "True when the underlying gist was deleted on GitHub (requires `delete_remote_gist: true` and `confirm_delete: true`).",
    ),
} as const;

export const unlinkMappingOutputSchema = z.object(unlinkMappingOutputShape);
export type UnlinkMappingOutput = z.infer<typeof unlinkMappingOutputSchema>;

// Registry -----------------------------------------------------------------

export type ToolSchemaEntry = {
  readonly name: string;
  readonly description: string;
  readonly inputShape: Readonly<Record<string, z.ZodTypeAny>>;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputShape: Readonly<Record<string, z.ZodTypeAny>>;
  readonly outputSchema: z.ZodTypeAny;
};

export const toolSchemas = {
  init_workspace: {
    name: "init_workspace",
    description:
      "Initialize a GistJet workspace by creating `.gistjet.json` and, unless `commit_mappings: true`, adding it to `.gitignore`.",
    inputShape: initWorkspaceInputShape,
    inputSchema: initWorkspaceInputSchema,
    outputShape: initWorkspaceOutputShape,
    outputSchema: initWorkspaceOutputSchema,
  },
  publish_path_to_gist: {
    name: "publish_path_to_gist",
    description:
      "Publish a local file or folder as a new GitHub gist, enforcing ignore rules, size limits, secret-scan, and visibility defaults.",
    inputShape: publishPathInputShape,
    inputSchema: publishPathInputSchema,
    outputShape: publishPathOutputShape,
    outputSchema: publishPathOutputSchema,
  },
  publish_selection_to_gist: {
    name: "publish_selection_to_gist",
    description: "Publish an in-memory content buffer as a new GitHub gist without touching disk.",
    inputShape: publishSelectionInputShape,
    inputSchema: publishSelectionInputSchema,
    outputShape: publishSelectionOutputShape,
    outputSchema: publishSelectionOutputSchema,
  },
  sync_path_to_gist: {
    name: "sync_path_to_gist",
    description:
      "Sync a mapped local path with its linked gist. Push local changes by default; pull remote into local only with `confirm_overwrite_local: true`.",
    inputShape: syncPathInputShape,
    inputSchema: syncPathInputSchema,
    outputShape: syncPathOutputShape,
    outputSchema: syncPathOutputSchema,
  },
  sync_status: {
    name: "sync_status",
    description:
      "Classify one mapping (or every mapping when `mapping_id` is omitted) as `in_sync`, `local_ahead`, `remote_ahead`, `diverged`, `orphaned`, or `local_missing` without writes.",
    inputShape: syncStatusInputShape,
    inputSchema: syncStatusInputSchema,
    outputShape: syncStatusOutputShape,
    outputSchema: syncStatusOutputSchema,
  },
  list_gists: {
    name: "list_gists",
    description:
      "Paginate the authenticated user's gists with optional visibility and substring filters; each item reports whether it is already mapped locally.",
    inputShape: listGistsInputShape,
    inputSchema: listGistsInputSchema,
    outputShape: listGistsOutputShape,
    outputSchema: listGistsOutputSchema,
  },
  open_gist: {
    name: "open_gist",
    description:
      "Open a remote gist with its metadata and file contents (binary files require `include_binary: true`).",
    inputShape: openGistInputShape,
    inputSchema: openGistInputSchema,
    outputShape: openGistOutputShape,
    outputSchema: openGistOutputSchema,
  },
  unlink_mapping: {
    name: "unlink_mapping",
    description:
      "Remove a mapping from `.gistjet.json`. Optionally delete the remote gist when both `delete_remote_gist: true` and `confirm_delete: true` are set.",
    inputShape: unlinkMappingInputShape,
    inputSchema: unlinkMappingInputSchema,
    outputShape: unlinkMappingOutputShape,
    outputSchema: unlinkMappingOutputSchema,
  },
} as const satisfies Record<string, ToolSchemaEntry>;

export type ToolName = keyof typeof toolSchemas;
