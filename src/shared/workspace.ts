// Serialized (on-disk) shape of `.gistjet.json`. Fields use snake_case to match
// the JSON stored at the workspace root — adapters translate to/from camelCase
// at the I/O boundary.

export type FileSnapshot = {
  readonly gist_filename: string;
  readonly relative_path: string;
  readonly size_bytes: number;
  readonly is_binary: boolean;
  readonly local_hash: string;
};

export type Mapping = {
  readonly id: string;
  readonly local_path: string;
  readonly gist_id: string;
  readonly kind: "file" | "folder";
  readonly visibility: "secret" | "public";
  readonly sync_mode: "manual" | "on_demand";
  readonly status: "active" | "orphaned" | "diverged" | "local_missing";
  readonly created_at: string;
  readonly last_synced_at: string | null;
  readonly last_remote_revision: string | null;
  readonly last_local_hash: string | null;
  readonly file_snapshots: readonly FileSnapshot[];
};

export type WorkspaceFile = {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly scratch_dir: string;
  readonly defaults: {
    readonly visibility: "secret";
    readonly description_prefix?: string;
  };
  readonly ignore: {
    readonly workspace_patterns: readonly string[];
    readonly respect_gitignore: boolean;
  };
  readonly mappings: readonly Mapping[];
};
