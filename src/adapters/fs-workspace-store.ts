import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { isMappingId } from "../shared/id";
import type { FileSystemPort } from "../shared/ports/filesystem";
import type { LoadError, WorkspaceStorePort, WriteError } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";
import type { WorkspaceFile } from "../shared/workspace";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const WORKSPACE_FILE_NAME = ".gistjet.json";
export const LOCK_FILE_NAME = ".gistjet.lock";
export const STALE_LOCK_MS = 60_000;

export type LockHolder = {
  readonly pid: number;
  readonly createdAt: string;
  readonly hostname: string;
};

export class LockContentionError extends Error {
  readonly lockPath: string;
  readonly holder: LockHolder;
  constructor(lockPath: string, holder: LockHolder) {
    super(
      `workspace lock held by pid ${holder.pid} on ${holder.hostname} since ${holder.createdAt} (${lockPath})`,
    );
    this.name = "LockContentionError";
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

const lockPayloadSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    created_at: z.string(),
    hostname: z.string(),
  })
  .passthrough();

const mappingIdSchema = z.string().refine((v): v is string => isMappingId(v), {
  message: "expected a 26-char Crockford base32 ULID",
});

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
    id: mappingIdSchema,
    local_path: z.string(),
    gist_id: z.string(),
    kind: z.enum(["file", "folder"]),
    visibility: z.enum(["secret", "public"]),
    sync_mode: z.enum(["manual", "on_demand"]),
    status: z.enum(["active", "orphaned", "diverged", "local_missing"]),
    created_at: z.string(),
    last_synced_at: z.string().nullable(),
    last_remote_revision: z.string().nullable(),
    last_local_hash: z.string().nullable(),
    file_snapshots: z.array(fileSnapshotSchema),
  })
  .strict();

const workspaceStrictSchema = z
  .object({
    schema_version: z.literal(SUPPORTED_SCHEMA_VERSION),
    workspace_id: z.string().min(1),
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

function coerceWorkspace(parsed: z.infer<typeof workspaceStrictSchema>): WorkspaceFile {
  const { description_prefix, ...rest } = parsed.defaults;
  const defaults: WorkspaceFile["defaults"] =
    description_prefix !== undefined ? { ...rest, description_prefix } : rest;
  return { ...parsed, defaults };
}

const versionProbeSchema = z
  .object({
    schema_version: z.number().int(),
  })
  .passthrough();

export type CreateFsWorkspaceStoreOptions = {
  readonly fs: FileSystemPort;
  readonly now?: () => number;
};

export function createFsWorkspaceStore(options: CreateFsWorkspaceStoreOptions): WorkspaceStorePort {
  const { fs } = options;
  const now = options.now ?? (() => Date.now());
  const locks = new Map<string, Promise<unknown>>();

  function workspaceFilePath(root: string): string {
    return path.join(root, WORKSPACE_FILE_NAME);
  }

  function lockFilePath(root: string): string {
    return path.join(root, LOCK_FILE_NAME);
  }

  function lockKey(root: string): string {
    return path.resolve(root);
  }

  async function writeLockExclusive(lockPath: string): Promise<void> {
    const payload = JSON.stringify({
      pid: process.pid,
      created_at: new Date(now()).toISOString(),
      hostname: os.hostname(),
    });
    const handle = await fsPromises.open(lockPath, "wx");
    try {
      await handle.writeFile(payload);
    } finally {
      await handle.close();
    }
  }

  async function readExistingHolder(lockPath: string): Promise<LockHolder> {
    try {
      const raw = await fsPromises.readFile(lockPath, "utf8");
      const parsed = lockPayloadSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        return { pid: 0, createdAt: new Date(0).toISOString(), hostname: "" };
      }
      return {
        pid: parsed.data.pid,
        createdAt: parsed.data.created_at,
        hostname: parsed.data.hostname,
      };
    } catch {
      return { pid: 0, createdAt: new Date(0).toISOString(), hostname: "" };
    }
  }

  function errnoCode(value: unknown): string | undefined {
    if (value && typeof value === "object" && "code" in value) {
      const raw = (value as { code: unknown }).code;
      return typeof raw === "string" ? raw : undefined;
    }
    return undefined;
  }

  async function acquireFileLock(lockPath: string): Promise<void> {
    try {
      await writeLockExclusive(lockPath);
      return;
    } catch (cause) {
      if (errnoCode(cause) !== "EEXIST") throw cause;
    }
    const holder = await readExistingHolder(lockPath);
    const holderMs = Date.parse(holder.createdAt);
    const ageMs = Number.isFinite(holderMs) ? now() - holderMs : Number.POSITIVE_INFINITY;
    if (ageMs > STALE_LOCK_MS) {
      try {
        await fsPromises.unlink(lockPath);
      } catch {
        // best effort
      }
      try {
        await writeLockExclusive(lockPath);
        return;
      } catch (cause) {
        if (errnoCode(cause) !== "EEXIST") throw cause;
        throw new LockContentionError(lockPath, await readExistingHolder(lockPath));
      }
    }
    throw new LockContentionError(lockPath, holder);
  }

  async function releaseFileLock(lockPath: string): Promise<void> {
    try {
      await fsPromises.unlink(lockPath);
    } catch {
      // best effort — either already gone or a contention error left the foreign lock in place
    }
  }

  async function load(root: string): Promise<Result<WorkspaceFile, LoadError>> {
    const target = workspaceFilePath(root);
    const readRes = await fs.read(target);
    if (!readRes.ok) {
      if (readRes.error.code === "E_NOT_FOUND") {
        return err({ code: "E_NOT_INITIALIZED" });
      }
      return err({ code: "E_PARSE", cause: `read failed: ${readRes.error.code}` });
    }
    if (readRes.value.kind !== "text") {
      return err({ code: "E_PARSE", cause: "workspace file is not UTF-8 text" });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readRes.value.value);
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      return err({ code: "E_PARSE", cause: msg });
    }
    const probe = versionProbeSchema.safeParse(parsed);
    if (probe.success && probe.data.schema_version > SUPPORTED_SCHEMA_VERSION) {
      return err({
        code: "E_SCHEMA_NEWER",
        required: SUPPORTED_SCHEMA_VERSION,
        found: probe.data.schema_version,
      });
    }
    const strict = workspaceStrictSchema.safeParse(parsed);
    if (!strict.success) {
      return err({ code: "E_PARSE", cause: strict.error.message });
    }
    return ok(coerceWorkspace(strict.data));
  }

  async function writeAtomic(root: string, next: WorkspaceFile): Promise<Result<void, WriteError>> {
    const validated = workspaceStrictSchema.safeParse(next);
    if (!validated.success) {
      return err({ code: "E_IO", cause: `invalid workspace shape: ${validated.error.message}` });
    }
    const target = workspaceFilePath(root);
    const payload = `${JSON.stringify(coerceWorkspace(validated.data), null, 2)}\n`;
    const writeRes = await fs.writeAtomic(target, payload);
    if (!writeRes.ok) {
      return err({ code: "E_IO", cause: writeRes.error.code });
    }
    return ok(undefined);
  }

  async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(root);
    const prior = locks.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(key, gate);
    try {
      if (prior) await prior;
      const lockPath = lockFilePath(root);
      await acquireFileLock(lockPath);
      try {
        return await fn();
      } finally {
        await releaseFileLock(lockPath);
      }
    } finally {
      release();
      if (locks.get(key) === gate) {
        locks.delete(key);
      }
    }
  }

  return { load, writeAtomic, withLock };
}
