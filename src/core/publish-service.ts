import { createHash } from "node:crypto";
import path from "node:path";

import type { RedactedFinding } from "../shared/finding";
import { createMappingId } from "../shared/id";
import type { FileSystemPort } from "../shared/ports/filesystem";
import type { GhError, GitHubGistPort } from "../shared/ports/github-gist";
import type { Logger } from "../shared/ports/logger";
import type { LoadError, WorkspaceStorePort, WriteError } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";
import type { FileSnapshot, Mapping, WorkspaceFile } from "../shared/workspace";

import type { FilenameFlattener } from "./filename-flattener";
import type { IgnoreEngine } from "./ignore-engine";
import type { SecretScanner } from "./secret-scanner";
import type { VisibilityGuard } from "./visibility-guard";

export type PublishPathRequest = {
  readonly path: string;
  readonly description?: string;
  readonly visibility?: "secret" | "public";
  readonly confirmPublic?: boolean;
  readonly acknowledgeFindings?: readonly string[];
  readonly allowBinary?: boolean;
};

export type PublishSelectionRequest = {
  readonly filename: string;
  readonly content: string;
  readonly description?: string;
  readonly visibility?: "secret" | "public";
  readonly confirmPublic?: boolean;
};

export type PublishWarning = { readonly kind: "public_publish"; readonly message: string };

export type PublishResult = {
  readonly gistId: string;
  readonly htmlUrl: string;
  readonly visibility: "secret" | "public";
  readonly mapping: Mapping;
  readonly ignoredFiles: readonly string[];
  readonly warnings: readonly PublishWarning[];
};

export type PublishError =
  | { readonly code: "E_NOT_FOUND"; readonly path: string }
  | { readonly code: "E_SECRET_DETECTED"; readonly findings: readonly RedactedFinding[] }
  | { readonly code: "E_VISIBILITY_CONFIRM" }
  | {
      readonly code: "E_TOO_LARGE";
      readonly file: string;
      readonly sizeBytes: number;
      readonly limit: number;
    }
  | { readonly code: "E_BINARY"; readonly file: string }
  | { readonly code: "E_TOO_MANY_FILES"; readonly count: number; readonly limit: number }
  | {
      readonly code: "E_FILENAME_COLLISION";
      readonly groups: ReadonlyArray<{
        readonly flattened: string;
        readonly sources: readonly string[];
      }>;
    }
  | {
      readonly code: "E_POST_PUBLISH_MISMATCH";
      readonly gistId: string;
      readonly htmlUrl: string;
      readonly mismatched: readonly string[];
    }
  | { readonly code: "E_AUTH"; readonly detail: "invalid_token" | "missing_permission" | "network" }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | { readonly code: "E_IO"; readonly cause: string }
  | LoadError;

export interface PublishService {
  publishPath(req: PublishPathRequest): Promise<Result<PublishResult, PublishError>>;
  publishSelection(req: PublishSelectionRequest): Promise<Result<PublishResult, PublishError>>;
}

export type PublishLimits = {
  readonly perFileSizeBytes?: number;
  readonly aggregateSizeBytes?: number;
  readonly maxFiles?: number;
};

export type CreatePublishServiceOptions = {
  readonly fs: FileSystemPort;
  readonly store: WorkspaceStorePort;
  readonly gistPort: GitHubGistPort;
  readonly ignoreEngine: IgnoreEngine;
  readonly secretScanner: SecretScanner;
  readonly visibilityGuard: VisibilityGuard;
  readonly filenameFlattener: FilenameFlattener;
  readonly workspaceRoot: string;
  readonly idGenerator?: () => string;
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly limits?: PublishLimits;
};

const DEFAULT_PER_FILE_SIZE = 1_000_000;
const DEFAULT_AGGREGATE_SIZE = 10_000_000;
const DEFAULT_MAX_FILES = 300;

type CandidateFile = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
  readonly isBinary: boolean;
  readonly sizeBytes: number;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function mapGhError(error: GhError): PublishError {
  if (error.code === "E_AUTH") return { code: "E_AUTH", detail: error.detail };
  if (error.code === "E_RATE_LIMIT") return { code: "E_RATE_LIMIT", resetAt: error.resetAt };
  if (error.code === "E_NOT_FOUND")
    return { code: "E_IO", cause: `gist not found: ${error.resource}` };
  if (error.code === "E_INPUT") return { code: "E_IO", cause: error.issues.join("; ") };
  if (error.code === "E_TOO_LARGE") {
    return {
      code: "E_TOO_LARGE",
      file: error.file,
      sizeBytes: error.sizeBytes,
      limit: error.limit,
    };
  }
  return { code: "E_IO", cause: error.cause };
}

function mapWriteError(e: WriteError): PublishError {
  return { code: "E_IO", cause: e.cause };
}

export function createPublishService(options: CreatePublishServiceOptions): PublishService {
  const {
    fs,
    store,
    gistPort,
    ignoreEngine,
    secretScanner,
    visibilityGuard,
    filenameFlattener,
    workspaceRoot,
    logger,
  } = options;
  const idGenerator = options.idGenerator ?? createMappingId;
  const clock = options.clock ?? (() => new Date());
  const perFileLimit = options.limits?.perFileSizeBytes ?? DEFAULT_PER_FILE_SIZE;
  const aggregateLimit = options.limits?.aggregateSizeBytes ?? DEFAULT_AGGREGATE_SIZE;
  const maxFiles = options.limits?.maxFiles ?? DEFAULT_MAX_FILES;

  async function readCandidate(
    absolutePath: string,
    relativePath: string,
    allowBinary: boolean,
  ): Promise<Result<CandidateFile, PublishError>> {
    const readRes = await fs.read(absolutePath);
    if (!readRes.ok) {
      if (readRes.error.code === "E_NOT_FOUND") {
        return err({ code: "E_NOT_FOUND", path: absolutePath });
      }
      return err({ code: "E_IO", cause: readRes.error.code });
    }
    if (readRes.value.kind === "binary") {
      if (!allowBinary) return err({ code: "E_BINARY", file: relativePath });
      const base64 = Buffer.from(readRes.value.value).toString("base64");
      return ok({
        absolutePath,
        relativePath,
        content: base64,
        isBinary: true,
        sizeBytes: readRes.value.value.byteLength,
      });
    }
    const normalized = normalizeLineEndings(readRes.value.value);
    const sizeBytes = Buffer.byteLength(normalized, "utf8");
    return ok({
      absolutePath,
      relativePath,
      content: normalized,
      isBinary: false,
      sizeBytes,
    });
  }

  async function collectFolder(
    dirPath: string,
    matcher: ReturnType<IgnoreEngine["build"]>,
    allowBinary: boolean,
  ): Promise<Result<{ files: CandidateFile[]; ignored: string[] }, PublishError>> {
    const files: CandidateFile[] = [];
    const ignored: string[] = [];
    let aggregate = 0;
    let total = 0;
    for await (const info of fs.enumerate(dirPath)) {
      if (info.isDirectory) continue;
      const relativePath = path.relative(dirPath, info.absolutePath).replace(/\\/g, "/");
      if (matcher.isIgnored(relativePath)) {
        ignored.push(relativePath);
        continue;
      }
      total += 1;
      if (total > maxFiles) {
        return err({ code: "E_TOO_MANY_FILES", count: total, limit: maxFiles });
      }
      const candidate = await readCandidate(info.absolutePath, relativePath, allowBinary);
      if (!candidate.ok) return candidate;
      if (candidate.value.sizeBytes > perFileLimit) {
        return err({
          code: "E_TOO_LARGE",
          file: relativePath,
          sizeBytes: candidate.value.sizeBytes,
          limit: perFileLimit,
        });
      }
      aggregate += candidate.value.sizeBytes;
      if (aggregate > aggregateLimit) {
        return err({
          code: "E_TOO_LARGE",
          file: relativePath,
          sizeBytes: aggregate,
          limit: aggregateLimit,
        });
      }
      files.push(candidate.value);
    }
    return ok({ files, ignored });
  }

  async function runPipeline(input: {
    readonly kind: "file" | "folder";
    readonly localPath: string;
    readonly candidates: CandidateFile[];
    readonly ignoredFiles: readonly string[];
    readonly visibility: "secret" | "public";
    readonly description?: string;
    readonly acknowledgeFindings?: readonly string[];
  }): Promise<Result<PublishResult, PublishError>> {
    const scan = await secretScanner.scan(
      input.candidates.map((c) => ({ filename: c.relativePath, content: c.content })),
      ...(input.acknowledgeFindings !== undefined
        ? [{ acknowledgeFindings: input.acknowledgeFindings }]
        : []),
    );
    if (scan.blocking.length > 0) {
      logger?.warn("publish.blocked.secret", { count: scan.blocking.length });
      return err({ code: "E_SECRET_DETECTED", findings: scan.blocking });
    }

    let gistFiles: Record<string, { content: string }> = {};
    const snapshotMeta: Array<{
      relativePath: string;
      flattened: string;
      sizeBytes: number;
      contentSha: string;
      isBinary: boolean;
    }> = [];

    if (input.kind === "folder") {
      const flat = filenameFlattener.flatten(
        input.candidates.map((c) => ({ relativePath: c.relativePath, sizeBytes: c.sizeBytes })),
      );
      if (!flat.ok) return err(flat.error);
      for (const entry of flat.value.files) {
        const candidate = input.candidates.find((c) => c.relativePath === entry.relativePath);
        if (!candidate) continue;
        gistFiles[entry.flattenedFilename] = { content: candidate.content };
        snapshotMeta.push({
          relativePath: candidate.relativePath,
          flattened: entry.flattenedFilename,
          sizeBytes: candidate.sizeBytes,
          contentSha: sha256(candidate.content),
          isBinary: candidate.isBinary,
        });
      }
    } else {
      const candidate = input.candidates[0];
      if (!candidate) return err({ code: "E_IO", cause: "no candidate files" });
      const filename = path.basename(candidate.relativePath);
      gistFiles[filename] = { content: candidate.content };
      snapshotMeta.push({
        relativePath: candidate.relativePath,
        flattened: filename,
        sizeBytes: candidate.sizeBytes,
        contentSha: sha256(candidate.content),
        isBinary: candidate.isBinary,
      });
    }

    logger?.info("publish.started", { file_count: Object.keys(gistFiles).length });

    const createInput = {
      public: input.visibility === "public",
      files: gistFiles,
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    const created = await gistPort.create(createInput);
    if (!created.ok) return err(mapGhError(created.error));

    // Post-publish verification
    const remote = await gistPort.get(created.value.gistId);
    if (!remote.ok) return err(mapGhError(remote.error));
    const mismatched: string[] = [];
    const remoteNames = new Set(remote.value.files.map((f) => f.filename));
    if (remoteNames.size !== snapshotMeta.length) {
      mismatched.push(...snapshotMeta.map((s) => s.flattened).filter((n) => !remoteNames.has(n)));
    }
    for (const snap of snapshotMeta) {
      const remoteFile = remote.value.files.find((f) => f.filename === snap.flattened);
      if (!remoteFile) {
        if (!mismatched.includes(snap.flattened)) mismatched.push(snap.flattened);
        continue;
      }
      const remoteSha = sha256(remoteFile.content ?? "");
      if (remoteSha !== snap.contentSha) mismatched.push(snap.flattened);
    }
    if (mismatched.length > 0) {
      logger?.warn("publish.post_verify_failed", {
        gist_id: created.value.gistId,
        mismatched,
      });
      return err({
        code: "E_POST_PUBLISH_MISMATCH",
        gistId: created.value.gistId,
        htmlUrl: created.value.htmlUrl,
        mismatched,
      });
    }

    // Persist mapping
    const now = clock().toISOString();
    const aggregateSha = sha256(
      snapshotMeta
        .slice()
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        .map((s) => `${s.relativePath}:${s.contentSha}`)
        .join("|"),
    );
    const snapshots: FileSnapshot[] = snapshotMeta.map((s) => ({
      gist_filename: s.flattened,
      relative_path: s.relativePath,
      size_bytes: s.sizeBytes,
      is_binary: s.isBinary,
      local_hash: s.contentSha,
    }));
    const mapping: Mapping = {
      id: idGenerator(),
      local_path: input.localPath,
      gist_id: created.value.gistId,
      kind: input.kind,
      visibility: input.visibility,
      sync_mode: "manual",
      status: "active",
      created_at: now,
      last_synced_at: now,
      last_remote_revision: created.value.revision || null,
      last_local_hash: aggregateSha,
      file_snapshots: snapshots,
    };

    const upserted = await store.withLock<Result<WorkspaceFile, PublishError>>(
      workspaceRoot,
      async () => {
        const loaded = await store.load(workspaceRoot);
        if (!loaded.ok) return loaded;
        const next: WorkspaceFile = {
          ...loaded.value,
          mappings: [...loaded.value.mappings, mapping],
        };
        const write = await store.writeAtomic(workspaceRoot, next);
        if (!write.ok) return err(mapWriteError(write.error));
        return ok(next);
      },
    );
    if (!upserted.ok) return err(upserted.error);

    logger?.info("publish.succeeded", {
      gist_id: created.value.gistId,
      mapping_id: mapping.id,
      file_count: snapshotMeta.length,
    });

    const warnings: PublishWarning[] = [];
    if (input.visibility === "public") {
      warnings.push({
        kind: "public_publish",
        message: "Gist created as public: contents are discoverable on the open web.",
      });
    }
    return ok({
      gistId: created.value.gistId,
      htmlUrl: created.value.htmlUrl,
      visibility: input.visibility,
      mapping,
      ignoredFiles: input.ignoredFiles,
      warnings,
    });
  }

  async function publishPath(
    req: PublishPathRequest,
  ): Promise<Result<PublishResult, PublishError>> {
    const workspace = await store.load(workspaceRoot);
    if (!workspace.ok) return err(workspace.error);
    const visibility = visibilityGuard.decide({
      ...(req.visibility !== undefined ? { requested: req.visibility } : {}),
      ...(req.confirmPublic !== undefined ? { confirmPublic: req.confirmPublic } : {}),
    });
    if (!visibility.ok) return err({ code: "E_VISIBILITY_CONFIRM" });
    const stat = await fs.stat(req.path);
    if (!stat.ok) return err({ code: "E_NOT_FOUND", path: req.path });
    const matcher = ignoreEngine.build({
      workspaceRoot,
      workspacePatterns: workspace.value.ignore.workspace_patterns,
      respectGitignore: workspace.value.ignore.respect_gitignore,
    });
    const allowBinary = req.allowBinary === true;
    let candidates: CandidateFile[];
    let ignoredFiles: string[] = [];
    let kind: "file" | "folder";
    if (stat.value.isDirectory) {
      kind = "folder";
      const collected = await collectFolder(req.path, matcher, allowBinary);
      if (!collected.ok) return collected;
      candidates = collected.value.files;
      ignoredFiles = collected.value.ignored;
    } else {
      kind = "file";
      const relativePath = path.basename(req.path);
      const candidate = await readCandidate(req.path, relativePath, allowBinary);
      if (!candidate.ok) return candidate;
      if (candidate.value.sizeBytes > perFileLimit) {
        return err({
          code: "E_TOO_LARGE",
          file: relativePath,
          sizeBytes: candidate.value.sizeBytes,
          limit: perFileLimit,
        });
      }
      candidates = [candidate.value];
    }
    if (candidates.length === 0) {
      return err({ code: "E_IO", cause: "no files to publish after filtering" });
    }
    return runPipeline({
      kind,
      localPath: req.path,
      candidates,
      ignoredFiles,
      visibility: visibility.value,
      ...(req.description !== undefined ? { description: req.description } : {}),
      ...(req.acknowledgeFindings !== undefined
        ? { acknowledgeFindings: req.acknowledgeFindings }
        : {}),
    });
  }

  async function publishSelection(
    req: PublishSelectionRequest,
  ): Promise<Result<PublishResult, PublishError>> {
    const workspace = await store.load(workspaceRoot);
    if (!workspace.ok) return err(workspace.error);
    const visibility = visibilityGuard.decide({
      ...(req.visibility !== undefined ? { requested: req.visibility } : {}),
      ...(req.confirmPublic !== undefined ? { confirmPublic: req.confirmPublic } : {}),
    });
    if (!visibility.ok) return err({ code: "E_VISIBILITY_CONFIRM" });
    const normalized = normalizeLineEndings(req.content);
    const sizeBytes = Buffer.byteLength(normalized, "utf8");
    if (sizeBytes > perFileLimit) {
      return err({
        code: "E_TOO_LARGE",
        file: req.filename,
        sizeBytes,
        limit: perFileLimit,
      });
    }
    const candidate: CandidateFile = {
      absolutePath: req.filename,
      relativePath: req.filename,
      content: normalized,
      isBinary: false,
      sizeBytes,
    };
    return runPipeline({
      kind: "file",
      localPath: req.filename,
      candidates: [candidate],
      ignoredFiles: [],
      visibility: visibility.value,
      ...(req.description !== undefined ? { description: req.description } : {}),
    });
  }

  return { publishPath, publishSelection };
}
