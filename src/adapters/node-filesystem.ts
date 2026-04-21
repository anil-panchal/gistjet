import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

import type {
  FileContent,
  FileInfo,
  FileSystemPort,
  ReadError,
  StatError,
  WriteError,
} from "../shared/ports/filesystem";
import { err, ok, type Result } from "../shared/result";

const BINARY_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bin",
  "bmp",
  "bz2",
  "class",
  "dll",
  "dylib",
  "eot",
  "exe",
  "gif",
  "gz",
  "ico",
  "jar",
  "jpeg",
  "jpg",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "odt",
  "ogg",
  "otf",
  "pdf",
  "png",
  "rar",
  "so",
  "tar",
  "tiff",
  "ttf",
  "wasm",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xz",
  "zip",
]);

const BINARY_SNIFF_BYTES = 8192;
const NON_TEXT_RATIO_THRESHOLD = 0.3;

export type CreateNodeFileSystemOptions = {
  readonly workspaceRoot?: string;
};

function toAbsolute(target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(target);
}

function toForwardSlash(p: string): string {
  return p.split(path.sep).join("/");
}

function extensionOf(absolutePath: string): string {
  const raw = path.extname(absolutePath);
  return raw ? raw.slice(1).toLowerCase() : "";
}

function hasBinaryExtension(absolutePath: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(absolutePath));
}

function sniffBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const limit = Math.min(BINARY_SNIFF_BYTES, buf.length);
  let nonText = 0;
  for (let i = 0; i < limit; i++) {
    const byte = buf[i]!;
    if (byte === 0) return true;
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 0x7f) nonText++;
  }
  return nonText / limit > NON_TEXT_RATIO_THRESHOLD;
}

function relativeFromRoot(absolutePath: string, root: string | undefined): string {
  if (!root) return toForwardSlash(path.basename(absolutePath));
  const rel = path.relative(root, absolutePath);
  if (rel === "") return ".";
  return toForwardSlash(rel);
}

function buildFileInfo(
  absolutePath: string,
  stats: { size: number; isDirectory(): boolean; mtimeMs: number },
  root: string | undefined,
): FileInfo {
  const isDirectory = stats.isDirectory();
  return {
    absolutePath,
    relativePath: relativeFromRoot(absolutePath, root),
    sizeBytes: stats.size,
    isDirectory,
    isBinaryHint: !isDirectory && hasBinaryExtension(absolutePath),
    mtimeMs: stats.mtimeMs,
  };
}

function errnoCode(value: unknown): string | undefined {
  if (value && typeof value === "object" && "code" in value) {
    const raw = (value as { code: unknown }).code;
    return typeof raw === "string" ? raw : undefined;
  }
  return undefined;
}

function tempSiblingPath(target: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return `${target}.${suffix}.gistjet-tmp`;
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // best effort — ignore
  }
}

export function createNodeFileSystem(options: CreateNodeFileSystemOptions = {}): FileSystemPort {
  const workspaceRoot = options.workspaceRoot ? toAbsolute(options.workspaceRoot) : undefined;

  async function stat(target: string): Promise<Result<FileInfo, StatError>> {
    const abs = toAbsolute(target);
    try {
      const s = await fs.stat(abs);
      return ok(buildFileInfo(abs, s, workspaceRoot));
    } catch {
      return err({ code: "E_NOT_FOUND" });
    }
  }

  async function read(
    target: string,
    opts?: { readonly asBuffer?: boolean },
  ): Promise<Result<FileContent, ReadError>> {
    const abs = toAbsolute(target);
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch (cause) {
      const code = errnoCode(cause);
      if (code === "ENOENT") return err({ code: "E_NOT_FOUND" });
      return err({ code: "E_IO" });
    }
    if (opts?.asBuffer === true) {
      return ok({ kind: "binary", value: new Uint8Array(buf) });
    }
    if (hasBinaryExtension(abs) || sniffBinary(buf)) {
      return ok({ kind: "binary", value: new Uint8Array(buf) });
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      return ok({ kind: "text", value: text, encoding: "utf8" });
    } catch {
      return ok({ kind: "binary", value: new Uint8Array(buf) });
    }
  }

  async function writeAtomic(
    target: string,
    content: string | Uint8Array,
  ): Promise<Result<void, WriteError>> {
    const abs = toAbsolute(target);
    const dir = path.dirname(abs);
    const tmp = tempSiblingPath(abs);
    try {
      await fs.mkdir(dir, { recursive: true });
      const payload: Buffer =
        typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      const handle = await fs.open(tmp, "wx");
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(tmp, abs);
      } catch (renameCause) {
        const code = errnoCode(renameCause);
        if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
          await removeQuietly(abs);
          await fs.rename(tmp, abs);
        } else {
          throw renameCause;
        }
      }
      return ok(undefined);
    } catch {
      await removeQuietly(tmp);
      return err({ code: "E_IO" });
    }
  }

  async function* enumerate(root: string): AsyncIterable<FileInfo> {
    const absRoot = toAbsolute(root);
    const relativeBase = workspaceRoot ?? absRoot;

    async function* walk(dir: string): AsyncIterable<FileInfo> {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childAbs = path.join(dir, entry.name);
        let childStat;
        try {
          childStat = await fs.stat(childAbs);
        } catch {
          continue;
        }
        yield buildFileInfo(childAbs, childStat, relativeBase);
        if (childStat.isDirectory()) {
          yield* walk(childAbs);
        }
      }
    }

    yield* walk(absRoot);
  }

  return { stat, read, writeAtomic, enumerate };
}
