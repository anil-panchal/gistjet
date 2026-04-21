import { createHash } from "node:crypto";
import path from "node:path";

import type { FileSystemPort } from "../shared/ports/filesystem";
import type { GhError, GitHubGistPort } from "../shared/ports/github-gist";
import type { LoadError, WorkspaceStorePort } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";
import type { Mapping, WorkspaceFile } from "../shared/workspace";

import type { ConflictResolver } from "./conflict-resolver";
import type { DiffService } from "./diff-service";

export type StatusClassification =
  | "in_sync"
  | "local_ahead"
  | "remote_ahead"
  | "diverged"
  | "orphaned"
  | "local_missing";

export type FileChangeKind = "added" | "modified" | "renamed" | "deleted" | "unchanged";

export type FileStatus = {
  readonly filename: string;
  readonly change: FileChangeKind;
  readonly sizeBytes: number;
  readonly isBinary: boolean;
  readonly diff?: string;
  readonly diffTruncated?: boolean;
};

export type MappingStatus = {
  readonly mappingId: string;
  readonly classification: StatusClassification;
  readonly files: readonly FileStatus[];
};

export type StatusOptions = {
  readonly includeDiffs?: boolean;
  readonly diffSizeLimitBytes?: number;
};

export type StatusError =
  | { readonly code: "E_NOT_FOUND"; readonly mappingId: string }
  | { readonly code: "E_AUTH"; readonly detail: "invalid_token" | "missing_permission" | "network" }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | { readonly code: "E_IO"; readonly cause: string }
  | LoadError;

export interface StatusService {
  forMapping(mappingId: string, opts?: StatusOptions): Promise<Result<MappingStatus, StatusError>>;
  forAll(opts?: StatusOptions): Promise<Result<readonly MappingStatus[], StatusError>>;
}

export type CreateStatusServiceOptions = {
  readonly fs: FileSystemPort;
  readonly store: WorkspaceStorePort;
  readonly gistPort: GitHubGistPort;
  readonly conflictResolver: ConflictResolver;
  readonly diffService: DiffService;
  readonly workspaceRoot: string;
};

const DEFAULT_DIFF_SIZE_LIMIT = 8 * 1024;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function aggregateHash(files: Array<{ relativePath: string; contentSha: string }>): string {
  return sha256(
    files
      .slice()
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((f) => `${f.relativePath}:${f.contentSha}`)
      .join("|"),
  );
}

function mapGhError(e: GhError): StatusError {
  if (e.code === "E_AUTH") return { code: "E_AUTH", detail: e.detail };
  if (e.code === "E_RATE_LIMIT") return { code: "E_RATE_LIMIT", resetAt: e.resetAt };
  return { code: "E_IO", cause: e.code };
}

type LocalFile = { filename: string; content: string; contentSha: string; sizeBytes: number };
type RemoteFile = { filename: string; content: string; contentSha: string; sizeBytes: number };

export function createStatusService(options: CreateStatusServiceOptions): StatusService {
  const { fs, store, gistPort, conflictResolver, diffService, workspaceRoot } = options;

  async function readLocal(mapping: Mapping): Promise<LocalFile[] | null> {
    const out: LocalFile[] = [];
    for (const snap of mapping.file_snapshots) {
      const absolutePath =
        mapping.kind === "file"
          ? mapping.local_path
          : path.join(mapping.local_path, snap.relative_path);
      const read = await fs.read(absolutePath);
      if (!read.ok) return null;
      const content = normalize(read.value.kind === "text" ? read.value.value : "");
      out.push({
        filename: snap.gist_filename,
        content,
        contentSha: sha256(content),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      });
    }
    return out;
  }

  function buildFileStatuses(
    localFiles: readonly LocalFile[],
    remoteFiles: readonly RemoteFile[],
    opts: StatusOptions,
  ): FileStatus[] {
    const includeDiffs = opts.includeDiffs === true;
    const limit = opts.diffSizeLimitBytes ?? DEFAULT_DIFF_SIZE_LIMIT;
    const localByName = new Map(localFiles.map((f) => [f.filename, f]));
    const remoteByName = new Map(remoteFiles.map((f) => [f.filename, f]));
    const allNames = new Set<string>([
      ...localFiles.map((f) => f.filename),
      ...remoteFiles.map((f) => f.filename),
    ]);
    const statuses: FileStatus[] = [];
    for (const name of allNames) {
      const local = localByName.get(name);
      const remote = remoteByName.get(name);
      let change: FileChangeKind;
      let sizeBytes: number;
      if (local && !remote) {
        change = "deleted";
        sizeBytes = local.sizeBytes;
      } else if (remote && !local) {
        change = "added";
        sizeBytes = remote.sizeBytes;
      } else if (local && remote) {
        change = local.contentSha === remote.contentSha ? "unchanged" : "modified";
        sizeBytes = Math.max(local.sizeBytes, remote.sizeBytes);
      } else {
        continue;
      }
      const base: FileStatus = { filename: name, change, sizeBytes, isBinary: false };
      if (!includeDiffs || change === "unchanged") {
        statuses.push(base);
        continue;
      }
      const diffResult = diffService.diff({
        filename: name,
        local: local?.content ?? "",
        remote: remote?.content ?? "",
        limitBytes: limit,
      });
      if (diffResult.kind === "diff") {
        statuses.push({ ...base, diff: diffResult.unified });
      } else {
        const summaryBytes = Math.max(diffResult.localSize, diffResult.remoteSize);
        statuses.push({
          ...base,
          sizeBytes: summaryBytes,
          isBinary: diffResult.reason === "binary",
          diffTruncated: true,
        });
      }
    }
    statuses.sort((a, b) => a.filename.localeCompare(b.filename));
    return statuses;
  }

  async function statusForMapping(
    workspace: WorkspaceFile,
    mapping: Mapping,
    opts: StatusOptions,
  ): Promise<Result<MappingStatus, StatusError>> {
    void workspace;
    // Check local existence first (req 4.6)
    const stat = await fs.stat(mapping.local_path);
    if (!stat.ok) {
      return ok({
        mappingId: mapping.id,
        classification: "local_missing",
        files: [],
      });
    }
    // Fetch remote
    const remoteRes = await gistPort.get(mapping.gist_id);
    if (!remoteRes.ok) {
      if (remoteRes.error.code === "E_NOT_FOUND") {
        return ok({ mappingId: mapping.id, classification: "orphaned", files: [] });
      }
      return err(mapGhError(remoteRes.error));
    }
    const remote = remoteRes.value;
    const localFiles = await readLocal(mapping);
    if (localFiles === null) {
      return ok({ mappingId: mapping.id, classification: "local_missing", files: [] });
    }
    const remoteFiles: RemoteFile[] = remote.files.map((f) => {
      const raw = f.content === null ? "" : f.content;
      const content = normalize(raw);
      return {
        filename: f.filename,
        content,
        contentSha: sha256(content),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    });

    const currentLocalHash = aggregateHash(
      localFiles.map((f) => ({ relativePath: f.filename, contentSha: f.contentSha })),
    );
    const classification = conflictResolver.classify({
      current: { localHash: currentLocalHash, remoteRevision: remote.revision },
      lastKnown: {
        localHash: mapping.last_local_hash,
        remoteRevision: mapping.last_remote_revision,
      },
    });
    const files = buildFileStatuses(localFiles, remoteFiles, opts);
    return ok({ mappingId: mapping.id, classification, files });
  }

  async function forMapping(
    mappingId: string,
    opts: StatusOptions = {},
  ): Promise<Result<MappingStatus, StatusError>> {
    const wsLoad = await store.load(workspaceRoot);
    if (!wsLoad.ok) return err(wsLoad.error);
    const mapping = wsLoad.value.mappings.find((m) => m.id === mappingId);
    if (!mapping) return err({ code: "E_NOT_FOUND", mappingId });
    return statusForMapping(wsLoad.value, mapping, opts);
  }

  async function forAll(
    opts: StatusOptions = {},
  ): Promise<Result<readonly MappingStatus[], StatusError>> {
    const wsLoad = await store.load(workspaceRoot);
    if (!wsLoad.ok) return err(wsLoad.error);
    const out: MappingStatus[] = [];
    for (const mapping of wsLoad.value.mappings) {
      const one = await statusForMapping(wsLoad.value, mapping, opts);
      if (!one.ok) return err(one.error);
      out.push(one.value);
    }
    return ok(out);
  }

  return { forMapping, forAll };
}
