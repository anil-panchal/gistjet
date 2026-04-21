import type { Result } from "../result";

export type FileInfo = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly isDirectory: boolean;
  readonly isBinaryHint: boolean;
  readonly mtimeMs: number;
};

export type FileContent =
  | { readonly kind: "text"; readonly value: string; readonly encoding: "utf8" }
  | { readonly kind: "binary"; readonly value: Uint8Array };

export type ReadError = { readonly code: "E_NOT_FOUND" | "E_IO" };
export type StatError = { readonly code: "E_NOT_FOUND" };
export type WriteError = { readonly code: "E_IO" };

export interface FileSystemPort {
  stat(path: string): Promise<Result<FileInfo, StatError>>;
  read(
    path: string,
    opts?: { readonly asBuffer?: boolean },
  ): Promise<Result<FileContent, ReadError>>;
  writeAtomic(path: string, content: string | Uint8Array): Promise<Result<void, WriteError>>;
  enumerate(root: string): AsyncIterable<FileInfo>;
}
