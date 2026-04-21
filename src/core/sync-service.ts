import { createHash } from "node:crypto";
import path from "node:path";

import type { ConflictReport } from "../shared/conflict";
import type { FileSystemPort } from "../shared/ports/filesystem";
import type { GhError, GitHubGistPort } from "../shared/ports/github-gist";
import type { Logger } from "../shared/ports/logger";
import type { LoadError, WorkspaceStorePort } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";
import type { FileSnapshot, Mapping, WorkspaceFile } from "../shared/workspace";

import type { ConflictResolver, FileChange } from "./conflict-resolver";
import type { IgnoreEngine } from "./ignore-engine";
import type { LocalOverwriteGate, PlannedWrite } from "./local-overwrite-gate";

export type SyncSelector = { readonly mappingId: string } | { readonly path: string };

export type SyncRequest = {
  readonly selector: SyncSelector;
  readonly dryRun?: boolean;
  readonly onConflict?: "prefer_local" | "prefer_remote" | "abort";
  readonly syncDirection?: "push" | "pull";
  readonly confirmOverwriteLocal?: boolean;
};

export type SyncClassification =
  | "in_sync"
  | "local_ahead"
  | "remote_ahead"
  | "diverged"
  | "local_missing";

export type SyncResult = {
  readonly classification: SyncClassification;
  readonly plan: readonly FileChange[];
  readonly applied: boolean;
  readonly newMappingState: Mapping;
  readonly ignoredOnPull?: readonly string[];
};

export type SyncError =
  | { readonly code: "E_NOT_FOUND"; readonly selector: SyncSelector }
  | {
      readonly code: "E_CONFLICT";
      readonly classification: "diverged";
      readonly report: ConflictReport;
    }
  | { readonly code: "E_ORPHANED"; readonly mappingId: string }
  | { readonly code: "E_LOCAL_MISSING"; readonly mappingId: string; readonly path: string }
  | {
      readonly code: "E_LOCAL_OVERWRITE_CONFIRM";
      readonly files: ReadonlyArray<{ readonly path: string; readonly sizeBytes: number }>;
    }
  | { readonly code: "E_VISIBILITY_CHANGE_REFUSED" }
  | { readonly code: "E_AUTH"; readonly detail: "invalid_token" | "missing_permission" | "network" }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | { readonly code: "E_IO"; readonly cause: string }
  | LoadError;

export interface SyncService {
  sync(req: SyncRequest): Promise<Result<SyncResult, SyncError>>;
}

export type CreateSyncServiceOptions = {
  readonly fs: FileSystemPort;
  readonly store: WorkspaceStorePort;
  readonly gistPort: GitHubGistPort;
  readonly conflictResolver: ConflictResolver;
  readonly localOverwriteGate: LocalOverwriteGate;
  readonly ignoreEngine: IgnoreEngine;
  readonly workspaceRoot: string;
  readonly clock?: () => Date;
  readonly logger?: Logger;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeLineEndings(text: string): string {
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

function mapGhError(e: GhError): SyncError {
  if (e.code === "E_AUTH") return { code: "E_AUTH", detail: e.detail };
  if (e.code === "E_RATE_LIMIT") return { code: "E_RATE_LIMIT", resetAt: e.resetAt };
  return { code: "E_IO", cause: e.code };
}

function findMapping(ws: WorkspaceFile, selector: SyncSelector): Mapping | undefined {
  if ("mappingId" in selector) {
    return ws.mappings.find((m) => m.id === selector.mappingId);
  }
  return ws.mappings.find((m) => m.local_path === selector.path);
}

function replaceMapping(ws: WorkspaceFile, next: Mapping): WorkspaceFile {
  return { ...ws, mappings: ws.mappings.map((m) => (m.id === next.id ? next : m)) };
}

type LocalFile = {
  readonly relativePath: string;
  readonly gistFilename: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly contentSha: string;
  readonly sizeBytes: number;
};

type RemoteFile = {
  readonly filename: string;
  readonly content: string;
  readonly contentSha: string;
  readonly sizeBytes: number;
};

export function createSyncService(options: CreateSyncServiceOptions): SyncService {
  const { fs, store, gistPort, conflictResolver, localOverwriteGate, workspaceRoot, logger } =
    options;
  const clock = options.clock ?? (() => new Date());

  async function readLocalFiles(mapping: Mapping): Promise<Result<LocalFile[], SyncError>> {
    const files: LocalFile[] = [];
    for (const snap of mapping.file_snapshots) {
      const absolutePath =
        mapping.kind === "file"
          ? mapping.local_path
          : path.join(mapping.local_path, snap.relative_path);
      const readRes = await fs.read(absolutePath);
      if (!readRes.ok) {
        return err({ code: "E_LOCAL_MISSING", mappingId: mapping.id, path: absolutePath });
      }
      const textValue = readRes.value.kind === "text" ? readRes.value.value : "";
      const content = normalizeLineEndings(textValue);
      files.push({
        relativePath: snap.relative_path,
        gistFilename: snap.gist_filename,
        absolutePath,
        content,
        contentSha: sha256(content),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      });
    }
    return ok(files);
  }

  async function persistMappingStatus(
    ws: WorkspaceFile,
    mapping: Mapping,
    status: Mapping["status"],
  ): Promise<void> {
    const next = replaceMapping(ws, { ...mapping, status });
    await store.withLock(workspaceRoot, async () => {
      await store.writeAtomic(workspaceRoot, next);
    });
  }

  async function sync(req: SyncRequest): Promise<Result<SyncResult, SyncError>> {
    const wsLoad = await store.load(workspaceRoot);
    if (!wsLoad.ok) return err(wsLoad.error);
    const workspace = wsLoad.value;

    const mapping = findMapping(workspace, req.selector);
    if (!mapping) return err({ code: "E_NOT_FOUND", selector: req.selector });

    // Stat local
    const statRes = await fs.stat(mapping.local_path);
    if (!statRes.ok) {
      await persistMappingStatus(workspace, mapping, "local_missing");
      return err({ code: "E_LOCAL_MISSING", mappingId: mapping.id, path: mapping.local_path });
    }

    // Fetch remote
    const remoteRes = await gistPort.get(mapping.gist_id);
    if (!remoteRes.ok) {
      if (remoteRes.error.code === "E_NOT_FOUND") {
        await persistMappingStatus(workspace, mapping, "orphaned");
        return err({ code: "E_ORPHANED", mappingId: mapping.id });
      }
      return err(mapGhError(remoteRes.error));
    }
    const remote = remoteRes.value;

    // Visibility drift
    const mappedPublic = mapping.visibility === "public";
    if (remote.public !== mappedPublic) {
      return err({ code: "E_VISIBILITY_CHANGE_REFUSED" });
    }

    // Read local files per mapping snapshots
    const localRes = await readLocalFiles(mapping);
    if (!localRes.ok) {
      await persistMappingStatus(workspace, mapping, "local_missing");
      return err(localRes.error);
    }
    const localFiles = localRes.value;

    // Build remote file list with hashes. `GistFull.content` is guaranteed to be
    // filled (truncated files are re-fetched in the Octokit adapter), but treat
    // null defensively as empty.
    const remoteFiles: RemoteFile[] = remote.files.map((f) => {
      const raw = f.content === null ? "" : f.content;
      const content = normalizeLineEndings(raw);
      return {
        filename: f.filename,
        content,
        contentSha: sha256(content),
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    });

    // Compute aggregate hashes
    const currentLocalHash = aggregateHash(
      localFiles.map((f) => ({ relativePath: f.relativePath, contentSha: f.contentSha })),
    );
    const currentRemoteRevision = remote.revision;

    const classification = conflictResolver.classify({
      current: { localHash: currentLocalHash, remoteRevision: currentRemoteRevision },
      lastKnown: {
        localHash: mapping.last_local_hash,
        remoteRevision: mapping.last_remote_revision,
      },
    });

    // Build changes. For simplicity: push = every local file; pull = every remote file.
    const localChanges: FileChange[] = localFiles.map((f) => ({
      filename: f.gistFilename,
      kind: "modified",
      sizeBytes: f.sizeBytes,
    }));
    const remoteChanges: FileChange[] = remoteFiles.map((f) => ({
      filename: f.filename,
      kind: "modified",
      sizeBytes: f.sizeBytes,
    }));

    // Default strategy: "abort" only when the mapping is diverged (req 12.5).
    // For non-diverged classifications, follow the natural direction so a plain
    // `sync` request applies local→remote or remote→local without extra flags.
    const strategy = req.onConflict ?? (classification === "diverged" ? "abort" : "prefer_local");
    const resolved = conflictResolver.resolve({
      classification,
      strategy,
      localChanges,
      remoteChanges,
      classifyInput: {
        current: { localHash: currentLocalHash, remoteRevision: currentRemoteRevision },
        lastKnown: {
          localHash: mapping.last_local_hash,
          remoteRevision: mapping.last_remote_revision,
        },
      },
    });
    if (!resolved.ok) {
      return err({ code: "E_CONFLICT", classification: "diverged", report: resolved.error.report });
    }

    const plan: FileChange[] =
      resolved.value.direction === "push"
        ? [...resolved.value.filesToWriteRemote]
        : resolved.value.direction === "pull"
          ? [...resolved.value.filesToWriteLocal]
          : [];

    if (req.dryRun) {
      return ok({
        classification,
        plan,
        applied: false,
        newMappingState: mapping,
      });
    }

    const now = clock().toISOString();

    if (resolved.value.direction === "noop") {
      // Touch last_synced_at to reflect the check occurred.
      const next: Mapping = { ...mapping, last_synced_at: now, status: "active" };
      await store.withLock(workspaceRoot, async () => {
        await store.writeAtomic(workspaceRoot, replaceMapping(workspace, next));
      });
      return ok({ classification, plan: [], applied: true, newMappingState: next });
    }

    if (resolved.value.direction === "push") {
      const filesPayload: Record<string, { content: string }> = {};
      for (const f of localFiles) filesPayload[f.gistFilename] = { content: f.content };
      const upd = await gistPort.update({ gistId: mapping.gist_id, files: filesPayload });
      if (!upd.ok) return err(mapGhError(upd.error));
      const newSnaps: FileSnapshot[] = localFiles.map((f) => ({
        gist_filename: f.gistFilename,
        relative_path: f.relativePath,
        size_bytes: f.sizeBytes,
        is_binary: false,
        local_hash: f.contentSha,
      }));
      const nextMapping: Mapping = {
        ...mapping,
        last_synced_at: now,
        last_local_hash: currentLocalHash,
        last_remote_revision: upd.value.revision || currentRemoteRevision,
        status: "active",
        file_snapshots: newSnaps,
      };
      await store.withLock(workspaceRoot, async () => {
        await store.writeAtomic(workspaceRoot, replaceMapping(workspace, nextMapping));
      });
      logger?.info("sync.pushed", {
        mapping_id: mapping.id,
        file_count: localFiles.length,
      });
      return ok({ classification, plan, applied: true, newMappingState: nextMapping });
    }

    // direction === "pull"
    const matcher = options.ignoreEngine.build({
      workspaceRoot,
      workspacePatterns: workspace.ignore.workspace_patterns,
      respectGitignore: workspace.ignore.respect_gitignore,
    });
    const planned: PlannedWrite[] = remoteFiles.map((f) => {
      const relativePath = mapping.kind === "file" ? path.basename(mapping.local_path) : f.filename;
      return { relativePath, sizeBytes: f.sizeBytes };
    });
    const gateResult = localOverwriteGate.authorize({
      plannedWrites: planned,
      ...(req.confirmOverwriteLocal !== undefined
        ? { confirmOverwriteLocal: req.confirmOverwriteLocal }
        : {}),
      ignoreMatcher: matcher,
    });
    if (!gateResult.ok) {
      return err({
        code: "E_LOCAL_OVERWRITE_CONFIRM",
        files: gateResult.error.files.map((f) => ({
          path: f.relativePath,
          sizeBytes: f.sizeBytes,
        })),
      });
    }
    const approved = gateResult.value.approved;
    const newSnaps: FileSnapshot[] = [];
    for (const p of approved) {
      const remoteFile = remoteFiles.find((f) => {
        if (mapping.kind === "file") return true;
        return f.filename === p.relativePath;
      });
      if (!remoteFile) continue;
      const absolutePath =
        mapping.kind === "file"
          ? mapping.local_path
          : path.join(mapping.local_path, p.relativePath);
      const w = await fs.writeAtomic(absolutePath, remoteFile.content);
      if (!w.ok) return err({ code: "E_IO", cause: `fs.writeAtomic ${absolutePath}` });
      logger?.info("sync.local_write", {
        mapping_id: mapping.id,
        file: p.relativePath,
        size_bytes: p.sizeBytes,
      });
      newSnaps.push({
        gist_filename: remoteFile.filename,
        relative_path: p.relativePath,
        size_bytes: remoteFile.sizeBytes,
        is_binary: false,
        local_hash: remoteFile.contentSha,
      });
    }
    const nextMapping: Mapping = {
      ...mapping,
      last_synced_at: now,
      last_local_hash: aggregateHash(
        newSnaps.map((s) => ({ relativePath: s.relative_path, contentSha: s.local_hash })),
      ),
      last_remote_revision: currentRemoteRevision,
      status: "active",
      file_snapshots: newSnaps,
    };
    await store.withLock(workspaceRoot, async () => {
      await store.writeAtomic(workspaceRoot, replaceMapping(workspace, nextMapping));
    });
    return ok({
      classification,
      plan,
      applied: true,
      newMappingState: nextMapping,
      ...(gateResult.value.ignoredOnPull.length > 0
        ? { ignoredOnPull: gateResult.value.ignoredOnPull }
        : {}),
    });
  }

  return { sync };
}
