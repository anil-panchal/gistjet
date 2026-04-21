import type { Result } from "../result";
import type { WorkspaceFile } from "../workspace";

export type LoadError =
  | { readonly code: "E_NOT_INITIALIZED" }
  | { readonly code: "E_SCHEMA_NEWER"; readonly required: number; readonly found: number }
  | { readonly code: "E_PARSE"; readonly cause: string };

export type WriteError = { readonly code: "E_IO"; readonly cause: string };

export interface WorkspaceStorePort {
  load(root: string): Promise<Result<WorkspaceFile, LoadError>>;
  writeAtomic(root: string, next: WorkspaceFile): Promise<Result<void, WriteError>>;
  withLock<T>(root: string, fn: () => Promise<T>): Promise<T>;
}
