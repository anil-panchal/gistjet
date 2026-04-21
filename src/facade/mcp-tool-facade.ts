import { AsyncLocalStorage } from "node:async_hooks";

import { ulid } from "ulid";

import { catchUnexpected, toMcp } from "../core/error-mapper";
import type { Redactor } from "../core/redactor";
import type { DomainError, McpToolError } from "../shared/error";
import type { Logger } from "../shared/ports/logger";
import type { Result } from "../shared/result";

import { toolSchemas } from "./tool-schemas";

// Minimal service surface consumed by the façade. Shapes match each domain
// service's public interface without importing their full TS modules — keeps
// compilation decoupled and testability cheap.

export type DomainServices = {
  readonly workspace: {
    init(input?: { scratchDir?: string; commitMappings?: boolean }): Promise<
      Result<
        {
          workspacePath: string;
          config: unknown;
          gitignore: { action: string; path: string; advisory?: string };
        },
        unknown
      >
    >;
    get(): Promise<Result<unknown, unknown>>;
    update(mutator: (workspace: unknown) => unknown): Promise<Result<unknown, unknown>>;
  };
  readonly publish: {
    publishPath(req: {
      path: string;
      description?: string;
      visibility?: "secret" | "public";
      confirmPublic?: boolean;
      acknowledgeFindings?: readonly string[];
      allowBinary?: boolean;
    }): Promise<Result<PublishResultLike, unknown>>;
    publishSelection(req: {
      filename: string;
      content: string;
      description?: string;
      visibility?: "secret" | "public";
      confirmPublic?: boolean;
    }): Promise<Result<PublishResultLike, unknown>>;
  };
  readonly sync: {
    sync(req: SyncRequestLike): Promise<Result<SyncResultLike, unknown>>;
  };
  readonly status: {
    forMapping(
      mappingId: string,
      opts?: { includeDiffs?: boolean },
    ): Promise<Result<MappingStatusLike, unknown>>;
    forAll(opts?: {
      includeDiffs?: boolean;
    }): Promise<Result<readonly MappingStatusLike[], unknown>>;
  };
  readonly mapping: {
    list(): Promise<Result<readonly unknown[], unknown>>;
    get(mappingId: string): Promise<Result<unknown, unknown>>;
    unlink(req: {
      selector: { mappingId: string } | { gistId: string };
      deleteRemoteGist?: boolean;
      confirmDelete?: boolean;
    }): Promise<Result<UnlinkResultLike, unknown>>;
  };
  readonly browser: {
    list(req?: {
      filter?: { visibility?: "all" | "public" | "secret"; query?: string };
      cursor?: string;
    }): Promise<Result<ListResultLike, unknown>>;
    open(
      gistId: string,
      opts?: { includeBinary?: boolean },
    ): Promise<Result<GistViewLike, unknown>>;
  };
};

type PublishResultLike = {
  readonly gistId: string;
  readonly htmlUrl: string;
  readonly visibility: "secret" | "public";
  readonly mapping: unknown;
  readonly ignoredFiles: readonly string[];
  readonly warnings: ReadonlyArray<{ readonly kind: string; readonly message: string }>;
};

type SyncRequestLike = {
  readonly selector: { mappingId: string } | { path: string };
  readonly dryRun?: boolean;
  readonly onConflict?: "prefer_local" | "prefer_remote" | "abort";
  readonly syncDirection?: "push" | "pull";
  readonly confirmOverwriteLocal?: boolean;
};

type SyncResultLike = {
  readonly classification:
    | "in_sync"
    | "local_ahead"
    | "remote_ahead"
    | "diverged"
    | "local_missing";
  readonly plan: ReadonlyArray<{
    readonly filename: string;
    readonly kind: "added" | "modified" | "deleted";
    readonly sizeBytes?: number;
  }>;
  readonly applied: boolean;
  readonly newMappingState: unknown;
  readonly ignoredOnPull?: readonly string[];
};

type MappingStatusLike = {
  readonly mappingId: string;
  readonly classification: string;
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly change: string;
    readonly sizeBytes: number;
    readonly isBinary: boolean;
    readonly diff?: string;
    readonly diffTruncated?: boolean;
  }>;
};

type ListResultLike = {
  readonly items: ReadonlyArray<{
    readonly gistId: string;
    readonly htmlUrl: string;
    readonly description: string | null;
    readonly public: boolean;
    readonly updatedAt: string;
    readonly filenames: readonly string[];
    readonly isMapped: boolean;
    readonly mappingId?: string;
  }>;
  readonly nextCursor?: string;
};

type GistViewLike = {
  readonly gistId: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly public: boolean;
  readonly updatedAt: string;
  readonly revision: string;
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly sizeBytes: number;
    readonly truncated: boolean;
    readonly content: string | null;
    readonly encoding: "utf8" | "base64";
  }>;
  readonly isMapped: boolean;
  readonly mappingId?: string;
};

type UnlinkResultLike = {
  readonly removedMapping: unknown;
  readonly deletedRemote: boolean;
};

// The subset of the MCP SDK McpServer surface the façade actually uses.
export type ToolRegistrar = {
  registerTool(
    name: string,
    config: {
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
    },
    handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>,
  ): unknown;
};

type ToolResponse = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
};

export type RegisterAllOptions = {
  readonly allowedTools?: readonly string[];
};

export type McpToolFacade = {
  registerAll(server: ToolRegistrar, services: DomainServices, options?: RegisterAllOptions): void;
  getCurrentRequestId(): string | undefined;
};

export type CreateMcpToolFacadeOptions = {
  readonly redactor: Redactor;
  readonly logger?: Logger;
  readonly idGenerator?: () => string;
};

export function createMcpToolFacade(options: CreateMcpToolFacadeOptions): McpToolFacade {
  const { redactor } = options;
  const logger = options.logger;
  const generateRequestId = options.idGenerator ?? (() => ulid());
  const requestStorage = new AsyncLocalStorage<{ readonly requestId: string }>();

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function asStr(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  function successResponse(payload: Record<string, unknown>): ToolResponse {
    const redacted = redactor.redactPayload(payload);
    return {
      content: [{ type: "text", text: JSON.stringify(redacted) }],
      structuredContent: redacted,
    };
  }

  function errorResponse(error: DomainError, requestId: string): ToolResponse {
    const mcpError = toMcp(error, requestId);
    const redacted = redactor.redactPayload(mcpError) as unknown as McpToolError &
      Record<string, unknown>;
    // Error envelopes are emitted only via `content`: the MCP client validates
    // `structuredContent` against the success `outputSchema` whenever it is present,
    // regardless of `isError`, so attaching the error payload there would make the
    // client reject the response with a JSON-RPC -32602.
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(redacted) }],
    };
  }

  function normalizeNotFound(
    e: Record<string, unknown>,
  ): Extract<DomainError, { code: "E_NOT_FOUND" }> {
    const mappingId = asStr(e.mappingId);
    if (mappingId !== undefined) {
      return { code: "E_NOT_FOUND", resource: "mapping", identifier: mappingId };
    }
    const gistId = asStr(e.gistId);
    if (gistId !== undefined) {
      return { code: "E_NOT_FOUND", resource: "gist", identifier: gistId };
    }
    const path = asStr(e.path);
    if (path !== undefined) {
      return { code: "E_NOT_FOUND", resource: "path", identifier: path };
    }
    const selector = e.selector;
    if (isRecord(selector)) {
      const smid = asStr(selector.mappingId);
      if (smid !== undefined) return { code: "E_NOT_FOUND", resource: "mapping", identifier: smid };
      const sgid = asStr(selector.gistId);
      if (sgid !== undefined) return { code: "E_NOT_FOUND", resource: "gist", identifier: sgid };
      const spath = asStr(selector.path);
      if (spath !== undefined) return { code: "E_NOT_FOUND", resource: "path", identifier: spath };
    }
    return { code: "E_NOT_FOUND", resource: "unknown" };
  }

  function toDomainError(raw: unknown): DomainError {
    if (!isRecord(raw) || typeof raw.code !== "string") {
      return catchUnexpected(raw);
    }
    switch (raw.code) {
      case "E_NOT_FOUND":
        return normalizeNotFound(raw);
      case "E_NOT_INITIALIZED":
        return { code: "E_NOT_FOUND", resource: "workspace" };
      case "E_IO":
        return {
          code: "E_IO",
          path: asStr(raw.path) ?? "(unknown)",
          cause: asStr(raw.cause) ?? JSON.stringify(raw.cause ?? null),
        };
      case "E_INPUT":
      case "E_EXISTS":
      case "E_AUTH":
      case "E_RATE_LIMIT":
      case "E_CONFLICT":
      case "E_ORPHANED":
      case "E_LOCAL_MISSING":
      case "E_LOCAL_OVERWRITE_CONFIRM":
      case "E_SECRET_DETECTED":
      case "E_VISIBILITY_CONFIRM":
      case "E_VISIBILITY_CHANGE_REFUSED":
      case "E_TOO_LARGE":
      case "E_TOO_MANY_FILES":
      case "E_BINARY":
      case "E_FILENAME_COLLISION":
      case "E_POST_PUBLISH_MISMATCH":
      case "E_SCHEMA_NEWER":
      case "E_PARSE":
      case "E_INTERNAL":
        return raw as unknown as DomainError;
      default:
        return catchUnexpected(raw);
    }
  }

  // Camel-case → snake-case shape mappers for handler outputs.

  function mapPublishOutput(res: PublishResultLike): Record<string, unknown> {
    return {
      gist_id: res.gistId,
      html_url: res.htmlUrl,
      visibility: res.visibility,
      mapping: res.mapping,
      ignored_files: res.ignoredFiles,
      warnings: res.warnings,
    };
  }

  function mapInitOutput(res: {
    workspacePath: string;
    config: unknown;
    gitignore: { action: string; path: string; advisory?: string };
  }): Record<string, unknown> {
    return {
      workspace_path: res.workspacePath,
      config: res.config,
      gitignore: res.gitignore,
    };
  }

  function mapSyncOutput(res: SyncResultLike): Record<string, unknown> {
    const plan = res.plan.map((p) => ({
      filename: p.filename,
      kind: p.kind,
      ...(p.sizeBytes !== undefined ? { size_bytes: p.sizeBytes } : {}),
    }));
    const base: Record<string, unknown> = {
      classification: res.classification,
      plan,
      applied: res.applied,
      new_mapping_state: res.newMappingState,
    };
    if (res.ignoredOnPull !== undefined) base.ignored_on_pull = res.ignoredOnPull;
    return base;
  }

  function mapStatusOutput(entries: readonly MappingStatusLike[]): Record<string, unknown> {
    return {
      entries: entries.map((entry) => ({
        mapping_id: entry.mappingId,
        classification: entry.classification,
        files: entry.files.map((f) => {
          const out: Record<string, unknown> = {
            filename: f.filename,
            change: f.change,
            size_bytes: f.sizeBytes,
            is_binary: f.isBinary,
          };
          if (f.diff !== undefined) out.diff = f.diff;
          if (f.diffTruncated !== undefined) out.diff_truncated = f.diffTruncated;
          return out;
        }),
      })),
    };
  }

  function mapListOutput(res: ListResultLike): Record<string, unknown> {
    const base: Record<string, unknown> = {
      items: res.items.map((item) => {
        const out: Record<string, unknown> = {
          gist_id: item.gistId,
          html_url: item.htmlUrl,
          description: item.description,
          public: item.public,
          updated_at: item.updatedAt,
          filenames: item.filenames,
          is_mapped: item.isMapped,
        };
        if (item.mappingId !== undefined) out.mapping_id = item.mappingId;
        return out;
      }),
    };
    if (res.nextCursor !== undefined) base.next_cursor = res.nextCursor;
    return base;
  }

  function mapGistView(res: GistViewLike): Record<string, unknown> {
    const out: Record<string, unknown> = {
      gist_id: res.gistId,
      html_url: res.htmlUrl,
      description: res.description,
      public: res.public,
      updated_at: res.updatedAt,
      revision: res.revision,
      files: res.files.map((f) => ({
        filename: f.filename,
        size_bytes: f.sizeBytes,
        truncated: f.truncated,
        content: f.content,
        encoding: f.encoding,
      })),
      is_mapped: res.isMapped,
    };
    if (res.mappingId !== undefined) out.mapping_id = res.mappingId;
    return out;
  }

  function mapUnlinkOutput(res: UnlinkResultLike): Record<string, unknown> {
    return {
      removed_mapping: res.removedMapping,
      deleted_remote: res.deletedRemote,
    };
  }

  type Handler = (args: Record<string, unknown>) => Promise<Record<string, unknown> | DomainError>;

  function runWithinContext<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    return requestStorage.run({ requestId }, fn);
  }

  function wrapHandler(name: string, handler: Handler) {
    return async (
      args: Record<string, unknown>,
      _extra: Record<string, unknown>,
    ): Promise<ToolResponse> => {
      const requestId = generateRequestId();
      logger?.debug("mcp.request.received", { tool: name, request_id: requestId });
      try {
        return await runWithinContext(requestId, async () => {
          try {
            const outcome = await handler(args ?? {});
            if (isDomainError(outcome)) {
              logger?.warn("mcp.response.error", {
                tool: name,
                request_id: requestId,
                code: outcome.code,
              });
              return errorResponse(outcome, requestId);
            }
            logger?.debug("mcp.response.sent", { tool: name, request_id: requestId });
            return successResponse(outcome);
          } catch (cause) {
            logger?.error("mcp.response.exception", {
              tool: name,
              request_id: requestId,
              cause: cause instanceof Error ? cause.message : String(cause),
            });
            return errorResponse(catchUnexpected(cause), requestId);
          }
        });
      } catch (cause) {
        return errorResponse(catchUnexpected(cause), requestId);
      }
    };
  }

  function isDomainError(value: unknown): value is DomainError {
    if (!isRecord(value)) return false;
    return typeof value.code === "string" && value.code.startsWith("E_");
  }

  function syncSelectorFromArgs(
    args: Record<string, unknown>,
  ): { mappingId: string } | { path: string } | DomainError {
    const mid = asStr(args.mapping_id);
    if (mid !== undefined) return { mappingId: mid };
    const path = asStr(args.path);
    if (path !== undefined) return { path };
    return {
      code: "E_INPUT",
      message: "Either mapping_id or path must be supplied.",
    };
  }

  function unlinkSelectorFromArgs(
    args: Record<string, unknown>,
  ): { mappingId: string } | { gistId: string } | DomainError {
    const mid = asStr(args.mapping_id);
    if (mid !== undefined) return { mappingId: mid };
    const gid = asStr(args.gist_id);
    if (gid !== undefined) return { gistId: gid };
    return {
      code: "E_INPUT",
      message: "Either mapping_id or gist_id must be supplied.",
    };
  }

  function registerAll(
    server: ToolRegistrar,
    services: DomainServices,
    options: RegisterAllOptions = {},
  ): void {
    const allowed = options.allowedTools === undefined ? null : new Set(options.allowedTools);
    const shouldRegister = (name: string): boolean => allowed === null || allowed.has(name);

    function register(
      name: string,
      config: { description?: string; inputSchema?: unknown; outputSchema?: unknown },
      handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>,
    ): void {
      if (!shouldRegister(name)) return;
      server.registerTool(name, config, handler);
    }

    // init_workspace
    register(
      toolSchemas.init_workspace.name,
      {
        description: toolSchemas.init_workspace.description,
        inputSchema: toolSchemas.init_workspace.inputShape,
        outputSchema: toolSchemas.init_workspace.outputShape,
      },
      wrapHandler("init_workspace", async (args) => {
        const scratchDir = asStr(args.scratch_dir);
        const commitMappings =
          typeof args.commit_mappings === "boolean" ? args.commit_mappings : undefined;
        const input: { scratchDir?: string; commitMappings?: boolean } = {};
        if (scratchDir !== undefined) input.scratchDir = scratchDir;
        if (commitMappings !== undefined) input.commitMappings = commitMappings;
        const result = await services.workspace.init(input);
        if (!result.ok) return toDomainError(result.error);
        return mapInitOutput(result.value);
      }),
    );

    // publish_path_to_gist
    register(
      toolSchemas.publish_path_to_gist.name,
      {
        description: toolSchemas.publish_path_to_gist.description,
        inputSchema: toolSchemas.publish_path_to_gist.inputShape,
        outputSchema: toolSchemas.publish_path_to_gist.outputShape,
      },
      wrapHandler("publish_path_to_gist", async (args) => {
        const path = asStr(args.path);
        if (path === undefined) {
          return { code: "E_INPUT", message: "path is required." };
        }
        const req: Parameters<DomainServices["publish"]["publishPath"]>[0] = { path };
        const description = asStr(args.description);
        if (description !== undefined) req.description = description;
        const visibility = asStr(args.visibility);
        if (visibility === "secret" || visibility === "public") req.visibility = visibility;
        if (typeof args.confirm_public === "boolean") req.confirmPublic = args.confirm_public;
        if (Array.isArray(args.acknowledge_findings)) {
          req.acknowledgeFindings = args.acknowledge_findings.filter(
            (x): x is string => typeof x === "string",
          );
        }
        if (typeof args.allow_binary === "boolean") req.allowBinary = args.allow_binary;
        const result = await services.publish.publishPath(req);
        if (!result.ok) return toDomainError(result.error);
        return mapPublishOutput(result.value);
      }),
    );

    // publish_selection_to_gist
    register(
      toolSchemas.publish_selection_to_gist.name,
      {
        description: toolSchemas.publish_selection_to_gist.description,
        inputSchema: toolSchemas.publish_selection_to_gist.inputShape,
        outputSchema: toolSchemas.publish_selection_to_gist.outputShape,
      },
      wrapHandler("publish_selection_to_gist", async (args) => {
        const filename = asStr(args.filename);
        const content = asStr(args.content);
        if (filename === undefined || content === undefined) {
          return {
            code: "E_INPUT",
            message: "filename and content are required.",
          };
        }
        const req: Parameters<DomainServices["publish"]["publishSelection"]>[0] = {
          filename,
          content,
        };
        const description = asStr(args.description);
        if (description !== undefined) req.description = description;
        const visibility = asStr(args.visibility);
        if (visibility === "secret" || visibility === "public") req.visibility = visibility;
        if (typeof args.confirm_public === "boolean") req.confirmPublic = args.confirm_public;
        const result = await services.publish.publishSelection(req);
        if (!result.ok) return toDomainError(result.error);
        return mapPublishOutput(result.value);
      }),
    );

    // sync_path_to_gist
    register(
      toolSchemas.sync_path_to_gist.name,
      {
        description: toolSchemas.sync_path_to_gist.description,
        inputSchema: toolSchemas.sync_path_to_gist.inputShape,
        outputSchema: toolSchemas.sync_path_to_gist.outputShape,
      },
      wrapHandler("sync_path_to_gist", async (args) => {
        const selector = syncSelectorFromArgs(args);
        if (isDomainError(selector)) return selector;
        const req: SyncRequestLike = { selector };
        const patch: Record<string, unknown> = {};
        if (typeof args.dry_run === "boolean") patch.dryRun = args.dry_run;
        const onConflict = asStr(args.on_conflict);
        if (
          onConflict === "prefer_local" ||
          onConflict === "prefer_remote" ||
          onConflict === "abort"
        ) {
          patch.onConflict = onConflict;
        }
        const syncDirection = asStr(args.sync_direction);
        if (syncDirection === "push" || syncDirection === "pull") {
          patch.syncDirection = syncDirection;
        }
        if (typeof args.confirm_overwrite_local === "boolean") {
          patch.confirmOverwriteLocal = args.confirm_overwrite_local;
        }
        const result = await services.sync.sync({ ...req, ...patch });
        if (!result.ok) return toDomainError(result.error);
        return mapSyncOutput(result.value);
      }),
    );

    // sync_status
    register(
      toolSchemas.sync_status.name,
      {
        description: toolSchemas.sync_status.description,
        inputSchema: toolSchemas.sync_status.inputShape,
        outputSchema: toolSchemas.sync_status.outputShape,
      },
      wrapHandler("sync_status", async (args) => {
        const mappingId = asStr(args.mapping_id);
        const includeDiffs =
          typeof args.include_diffs === "boolean" ? args.include_diffs : undefined;
        const opts: { includeDiffs?: boolean } = includeDiffs === undefined ? {} : { includeDiffs };
        if (mappingId !== undefined) {
          const result = await services.status.forMapping(mappingId, opts);
          if (!result.ok) return toDomainError(result.error);
          return mapStatusOutput([result.value]);
        }
        const result = await services.status.forAll(opts);
        if (!result.ok) return toDomainError(result.error);
        return mapStatusOutput(result.value);
      }),
    );

    // list_gists
    register(
      toolSchemas.list_gists.name,
      {
        description: toolSchemas.list_gists.description,
        inputSchema: toolSchemas.list_gists.inputShape,
        outputSchema: toolSchemas.list_gists.outputShape,
      },
      wrapHandler("list_gists", async (args) => {
        const req: {
          filter?: { visibility?: "all" | "public" | "secret"; query?: string };
          cursor?: string;
        } = {};
        if (isRecord(args.filter)) {
          const filter: { visibility?: "all" | "public" | "secret"; query?: string } = {};
          const visibility = asStr(args.filter.visibility);
          if (visibility === "all" || visibility === "public" || visibility === "secret") {
            filter.visibility = visibility;
          }
          const query = asStr(args.filter.query);
          if (query !== undefined) filter.query = query;
          if (Object.keys(filter).length > 0) req.filter = filter;
        }
        const cursor = asStr(args.cursor);
        if (cursor !== undefined) req.cursor = cursor;
        const result = await services.browser.list(req);
        if (!result.ok) return toDomainError(result.error);
        return mapListOutput(result.value);
      }),
    );

    // open_gist
    register(
      toolSchemas.open_gist.name,
      {
        description: toolSchemas.open_gist.description,
        inputSchema: toolSchemas.open_gist.inputShape,
        outputSchema: toolSchemas.open_gist.outputShape,
      },
      wrapHandler("open_gist", async (args) => {
        const gistId = asStr(args.gist_id);
        if (gistId === undefined) {
          return { code: "E_INPUT", message: "gist_id is required." };
        }
        const opts: { includeBinary?: boolean } = {};
        if (typeof args.include_binary === "boolean") opts.includeBinary = args.include_binary;
        const result = await services.browser.open(gistId, opts);
        if (!result.ok) return toDomainError(result.error);
        return mapGistView(result.value);
      }),
    );

    // unlink_mapping
    register(
      toolSchemas.unlink_mapping.name,
      {
        description: toolSchemas.unlink_mapping.description,
        inputSchema: toolSchemas.unlink_mapping.inputShape,
        outputSchema: toolSchemas.unlink_mapping.outputShape,
      },
      wrapHandler("unlink_mapping", async (args) => {
        const selector = unlinkSelectorFromArgs(args);
        if (isDomainError(selector)) return selector;
        const req: Parameters<DomainServices["mapping"]["unlink"]>[0] = { selector };
        if (typeof args.delete_remote_gist === "boolean") {
          req.deleteRemoteGist = args.delete_remote_gist;
        }
        if (typeof args.confirm_delete === "boolean") {
          req.confirmDelete = args.confirm_delete;
        }
        const result = await services.mapping.unlink(req);
        if (!result.ok) return toDomainError(result.error);
        return mapUnlinkOutput(result.value);
      }),
    );
  }

  function getCurrentRequestId(): string | undefined {
    return requestStorage.getStore()?.requestId;
  }

  return { registerAll, getCurrentRequestId };
}
