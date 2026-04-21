import type { GhError, GitHubGistPort } from "../shared/ports/github-gist";
import type { Logger } from "../shared/ports/logger";
import type { LoadError, WorkspaceStorePort, WriteError } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";
import type { Mapping, WorkspaceFile } from "../shared/workspace";

export type MappingSelector = { readonly mappingId: string } | { readonly gistId: string };

export type UnlinkRequest = {
  readonly selector: MappingSelector;
  readonly deleteRemoteGist?: boolean;
  readonly confirmDelete?: boolean;
};

export type UnlinkResult = {
  readonly removedMapping: Mapping;
  readonly deletedRemote: boolean;
};

export type UnlinkError =
  | { readonly code: "E_NOT_FOUND"; readonly selector: MappingSelector }
  | { readonly code: "E_INPUT"; readonly message: string }
  | { readonly code: "E_AUTH"; readonly detail: "invalid_token" | "missing_permission" | "network" }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | { readonly code: "E_IO"; readonly cause: string }
  | LoadError;

export type GetError = { readonly code: "E_NOT_FOUND"; readonly mappingId: string } | LoadError;

export interface MappingService {
  list(): Promise<Result<readonly Mapping[], LoadError>>;
  get(mappingId: string): Promise<Result<Mapping, GetError>>;
  unlink(req: UnlinkRequest): Promise<Result<UnlinkResult, UnlinkError>>;
}

export type CreateMappingServiceOptions = {
  readonly store: WorkspaceStorePort;
  readonly gistPort: GitHubGistPort;
  readonly workspaceRoot: string;
  readonly logger?: Logger;
};

function findMapping(workspace: WorkspaceFile, selector: MappingSelector): Mapping | undefined {
  if ("mappingId" in selector) {
    return workspace.mappings.find((m) => m.id === selector.mappingId);
  }
  return workspace.mappings.find((m) => m.gist_id === selector.gistId);
}

function mapGhError(gh: GhError): UnlinkError {
  if (gh.code === "E_AUTH") return { code: "E_AUTH", detail: gh.detail };
  if (gh.code === "E_RATE_LIMIT") return { code: "E_RATE_LIMIT", resetAt: gh.resetAt };
  if (gh.code === "E_NOT_FOUND") return { code: "E_NOT_FOUND", selector: { gistId: gh.resource } };
  if (gh.code === "E_INPUT") return { code: "E_INPUT", message: gh.issues.join("; ") };
  if (gh.code === "E_INTERNAL") return { code: "E_IO", cause: gh.cause };
  return { code: "E_IO", cause: "unexpected gist error" };
}

function mapWriteError(e: WriteError): UnlinkError {
  return { code: "E_IO", cause: e.cause };
}

export function createMappingService(options: CreateMappingServiceOptions): MappingService {
  const { store, gistPort, workspaceRoot, logger } = options;

  async function list(): Promise<Result<readonly Mapping[], LoadError>> {
    const loaded = await store.load(workspaceRoot);
    if (!loaded.ok) return loaded;
    return ok(loaded.value.mappings);
  }

  async function get(mappingId: string): Promise<Result<Mapping, GetError>> {
    const loaded = await store.load(workspaceRoot);
    if (!loaded.ok) return loaded;
    const mapping = loaded.value.mappings.find((m) => m.id === mappingId);
    if (!mapping) return err({ code: "E_NOT_FOUND", mappingId });
    return ok(mapping);
  }

  async function unlink(req: UnlinkRequest): Promise<Result<UnlinkResult, UnlinkError>> {
    const deleteRemote = req.deleteRemoteGist === true;
    if (deleteRemote && req.confirmDelete !== true) {
      const message = "confirm_delete=true is required when delete_remote_gist=true";
      logger?.warn("mapping.unlink_rejected", { reason: "confirm_delete_missing" });
      return err({ code: "E_INPUT", message });
    }
    return store.withLock<Result<UnlinkResult, UnlinkError>>(workspaceRoot, async () => {
      const loaded = await store.load(workspaceRoot);
      if (!loaded.ok) return loaded;
      const mapping = findMapping(loaded.value, req.selector);
      if (!mapping) {
        logger?.warn("mapping.unlink_not_found", { selector: req.selector });
        return err({ code: "E_NOT_FOUND", selector: req.selector });
      }
      let deletedRemote = false;
      if (deleteRemote) {
        const del = await gistPort.delete(mapping.gist_id);
        if (!del.ok) {
          logger?.warn("mapping.remote_delete_failed", {
            mapping_id: mapping.id,
            gist_id: mapping.gist_id,
            cause: del.error.code,
          });
          return err(mapGhError(del.error));
        }
        deletedRemote = true;
        logger?.info("mapping.remote_deleted", {
          mapping_id: mapping.id,
          gist_id: mapping.gist_id,
        });
      }
      const nextWorkspace: WorkspaceFile = {
        ...loaded.value,
        mappings: loaded.value.mappings.filter((m) => m.id !== mapping.id),
      };
      const write = await store.writeAtomic(workspaceRoot, nextWorkspace);
      if (!write.ok) return err(mapWriteError(write.error));
      logger?.info("mapping.unlinked", {
        mapping_id: mapping.id,
        gist_id: mapping.gist_id,
        deleted_remote: deletedRemote,
      });
      return ok({ removedMapping: mapping, deletedRemote });
    });
  }

  return { list, get, unlink };
}
