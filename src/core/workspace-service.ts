import path from "node:path";

import { createMappingId } from "../shared/id";
import type { FileSystemPort } from "../shared/ports/filesystem";
import type { LoadError, WorkspaceStorePort, WriteError } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";
import type { WorkspaceFile } from "../shared/workspace";

import { HARDENED_IGNORE_PATTERNS } from "./ignore-engine";

export type InitInput = {
  readonly scratchDir?: string;
  readonly commitMappings?: boolean;
};

export type GitignoreAction =
  | "appended"
  | "created"
  | "already_ignored"
  | "skipped_commit_mappings";

export type InitResult = {
  readonly workspacePath: string;
  readonly config: WorkspaceFile;
  readonly gitignore: {
    readonly action: GitignoreAction;
    readonly path: string;
    readonly advisory?: string;
  };
};

export type InitError =
  | { readonly code: "E_EXISTS"; readonly path: string }
  | { readonly code: "E_IO"; readonly path: string; readonly cause: string };

export type UpdateError = LoadError | WriteError;

export interface WorkspaceService {
  init(input?: InitInput): Promise<Result<InitResult, InitError>>;
  get(): Promise<Result<WorkspaceFile, LoadError>>;
  update(
    mutator: (workspace: WorkspaceFile) => WorkspaceFile,
  ): Promise<Result<WorkspaceFile, UpdateError>>;
}

export type CreateWorkspaceServiceOptions = {
  readonly fs: FileSystemPort;
  readonly store: WorkspaceStorePort;
  readonly workspaceRoot: string;
  readonly idGenerator?: () => string;
};

const WORKSPACE_FILE_NAME = ".gistjet.json";
const GITIGNORE_FILE_NAME = ".gitignore";
const DEFAULT_SCRATCH_DIR = "./scratch/";
const COMMIT_MAPPINGS_ADVISORY =
  "commitMappings=true: mapping contents will be committed to the repository; make sure you never store secret gist tokens in them.";

function buildDefaultWorkspace(workspaceId: string, scratchDir: string): WorkspaceFile {
  return {
    schema_version: 1,
    workspace_id: workspaceId,
    scratch_dir: scratchDir,
    defaults: { visibility: "secret" },
    ignore: {
      workspace_patterns: [...HARDENED_IGNORE_PATTERNS],
      respect_gitignore: false,
    },
    mappings: [],
  };
}

function hasGistjetEntry(contents: string): boolean {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === WORKSPACE_FILE_NAME);
}

export function createWorkspaceService(options: CreateWorkspaceServiceOptions): WorkspaceService {
  const { fs, store, workspaceRoot } = options;
  const idGenerator = options.idGenerator ?? createMappingId;
  const workspacePath = path.join(workspaceRoot, WORKSPACE_FILE_NAME);
  const gitignorePath = path.join(workspaceRoot, GITIGNORE_FILE_NAME);

  async function handleGitignore(
    commitMappings: boolean,
  ): Promise<Result<InitResult["gitignore"], InitError>> {
    if (commitMappings) {
      return ok({
        action: "skipped_commit_mappings",
        path: gitignorePath,
        advisory: COMMIT_MAPPINGS_ADVISORY,
      });
    }
    const read = await fs.read(gitignorePath);
    if (read.ok) {
      if (read.value.kind !== "text") {
        return err({
          code: "E_IO",
          path: gitignorePath,
          cause: "existing .gitignore is not UTF-8 text",
        });
      }
      if (hasGistjetEntry(read.value.value)) {
        return ok({ action: "already_ignored", path: gitignorePath });
      }
      const separator = read.value.value.endsWith("\n") ? "" : "\n";
      const next = `${read.value.value}${separator}${WORKSPACE_FILE_NAME}\n`;
      const write = await fs.writeAtomic(gitignorePath, next);
      if (!write.ok) {
        return err({ code: "E_IO", path: gitignorePath, cause: write.error.code });
      }
      return ok({ action: "appended", path: gitignorePath });
    }
    if (read.error.code !== "E_NOT_FOUND") {
      return err({ code: "E_IO", path: gitignorePath, cause: read.error.code });
    }
    const write = await fs.writeAtomic(gitignorePath, `${WORKSPACE_FILE_NAME}\n`);
    if (!write.ok) {
      return err({ code: "E_IO", path: gitignorePath, cause: write.error.code });
    }
    return ok({ action: "created", path: gitignorePath });
  }

  async function init(input: InitInput = {}): Promise<Result<InitResult, InitError>> {
    const existing = await fs.stat(workspacePath);
    if (existing.ok) {
      return err({ code: "E_EXISTS", path: workspacePath });
    }
    const config = buildDefaultWorkspace(idGenerator(), input.scratchDir ?? DEFAULT_SCRATCH_DIR);
    const writeResult = await store.withLock(workspaceRoot, () =>
      store.writeAtomic(workspaceRoot, config),
    );
    if (!writeResult.ok) {
      return err({ code: "E_IO", path: workspacePath, cause: writeResult.error.cause });
    }
    const gitignoreResult = await handleGitignore(input.commitMappings === true);
    if (!gitignoreResult.ok) return gitignoreResult;
    return ok({ workspacePath, config, gitignore: gitignoreResult.value });
  }

  async function get(): Promise<Result<WorkspaceFile, LoadError>> {
    return store.load(workspaceRoot);
  }

  async function update(
    mutator: (workspace: WorkspaceFile) => WorkspaceFile,
  ): Promise<Result<WorkspaceFile, UpdateError>> {
    return store.withLock<Result<WorkspaceFile, UpdateError>>(workspaceRoot, async () => {
      const current = await store.load(workspaceRoot);
      if (!current.ok) return current;
      const next = mutator(current.value);
      const write = await store.writeAtomic(workspaceRoot, next);
      if (!write.ok) return err(write.error);
      return ok(next);
    });
  }

  return { init, get, update };
}
