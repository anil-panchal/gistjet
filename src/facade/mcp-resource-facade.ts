import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Redactor } from "../core/redactor";
import type { Logger } from "../shared/ports/logger";
import { type Result } from "../shared/result";
import type { Mapping, WorkspaceFile } from "../shared/workspace";

// Service shapes consumed by the resource facade. Kept narrow and
// structurally typed so tests can substitute in-memory doubles.

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

export type ResourceServices = {
  readonly workspace: {
    get(): Promise<Result<WorkspaceFile, unknown>>;
  };
  readonly mapping: {
    list(): Promise<Result<readonly Mapping[], unknown>>;
    get(mappingId: string): Promise<Result<Mapping, unknown>>;
  };
  readonly status: {
    forMapping(
      mappingId: string,
      opts?: { includeDiffs?: boolean },
    ): Promise<Result<MappingStatusLike, unknown>>;
  };
  readonly browser: {
    open(
      gistId: string,
      opts?: { includeBinary?: boolean },
    ): Promise<Result<GistViewLike, unknown>>;
  };
};

type ReadResourceContents = {
  readonly contents: ReadonlyArray<{
    readonly uri: string;
    readonly mimeType?: string;
    readonly text: string;
  }>;
};

type ReadCallback = (
  uri: URL,
  variables: Record<string, string | string[]>,
  extra: Record<string, unknown>,
) => Promise<ReadResourceContents>;

type ResourceMetadata = {
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

export type ResourceRegistrar = {
  registerResource(
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    config: ResourceMetadata,
    readCallback: ReadCallback,
  ): unknown;
};

export type McpResourceFacade = {
  registerAll(server: ResourceRegistrar, services: ResourceServices): void;
};

export type CreateMcpResourceFacadeOptions = {
  readonly redactor: Redactor;
  readonly logger?: Logger;
};

export type RequestMemo<K, V> = {
  get(key: K, fetch: () => Promise<V>): Promise<V>;
};

export function createRequestMemo<K, V>(): RequestMemo<K, V> {
  const cache = new Map<K, Promise<V>>();
  return {
    get(key, fetch) {
      const cached = cache.get(key);
      if (cached) return cached;
      const promise = fetch();
      cache.set(key, promise);
      return promise;
    },
  };
}

const MAPPING_ID = z.string().min(1, "mapping_id is required");
const GIST_ID = z.string().min(1, "gist_id is required");
const FILENAME = z.string().min(1, "filename is required");

function firstVariable(
  variables: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const value = variables[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function jsonPayload(uri: URL, payload: unknown): ReadResourceContents {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(payload),
      },
    ],
  };
}

function describeServiceError(raw: unknown): { code: string; message: string } {
  if (typeof raw === "object" && raw !== null && "code" in raw) {
    const code = String((raw as { code: unknown }).code ?? "E_INTERNAL");
    const detail =
      "message" in raw && typeof (raw as { message: unknown }).message === "string"
        ? (raw as { message: string }).message
        : code;
    return { code, message: detail };
  }
  return { code: "E_INTERNAL", message: "Unexpected error" };
}

function throwServiceError(raw: unknown, redactor: Redactor): never {
  const { code, message } = describeServiceError(raw);
  const redacted = redactor.redactString(`${code}: ${message}`);
  throw new Error(redacted);
}

function toWorkspaceResource(config: WorkspaceFile): Record<string, unknown> {
  const { mappings, ...rest } = config;
  return { ...rest, mapping_count: mappings.length };
}

function toMappingsResource(mappings: readonly Mapping[]): Record<string, unknown> {
  return {
    mappings: mappings.map((m) => ({
      id: m.id,
      local_path: m.local_path,
      gist_id: m.gist_id,
      kind: m.kind,
      visibility: m.visibility,
      status: m.status,
      sync_mode: m.sync_mode,
      created_at: m.created_at,
      last_synced_at: m.last_synced_at,
      last_remote_revision: m.last_remote_revision,
    })),
  };
}

function toMappingStatusResource(status: MappingStatusLike): Record<string, unknown> {
  return {
    mapping_id: status.mappingId,
    classification: status.classification,
    files: status.files.map((f) => {
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
  };
}

function toGistResource(view: GistViewLike): Record<string, unknown> {
  const out: Record<string, unknown> = {
    gist_id: view.gistId,
    html_url: view.htmlUrl,
    description: view.description,
    visibility: view.public ? "public" : "secret",
    public: view.public,
    updated_at: view.updatedAt,
    revision: view.revision,
    files: view.files.map((f) => ({
      filename: f.filename,
      size_bytes: f.sizeBytes,
      truncated: f.truncated,
      encoding: f.encoding,
    })),
    is_mapped: view.isMapped,
  };
  if (view.mappingId !== undefined) out.mapping_id = view.mappingId;
  return out;
}

function toGistFileResource(view: GistViewLike, filename: string): Record<string, unknown> | null {
  const file = view.files.find((f) => f.filename === filename);
  if (!file) return null;
  return {
    gist_id: view.gistId,
    filename: file.filename,
    size_bytes: file.sizeBytes,
    truncated: file.truncated,
    content: file.content,
    encoding: file.encoding,
  };
}

export function createMcpResourceFacade(
  options: CreateMcpResourceFacadeOptions,
): McpResourceFacade {
  const { redactor } = options;
  const logger = options.logger;

  function wrap(
    name: string,
    handler: (
      uri: URL,
      variables: Record<string, string | string[]>,
      memo: RequestMemo<string, GistViewLike>,
    ) => Promise<Record<string, unknown>>,
  ): ReadCallback {
    return async (uri, variables) => {
      const memo = createRequestMemo<string, GistViewLike>();
      logger?.debug("mcp.resource.read.started", { resource: name, uri: uri.href });
      try {
        const payload = await handler(uri, variables, memo);
        const redacted = redactor.redactPayload(payload);
        logger?.debug("mcp.resource.read.succeeded", { resource: name, uri: uri.href });
        return jsonPayload(uri, redacted);
      } catch (error) {
        logger?.warn("mcp.resource.read.failed", {
          resource: name,
          uri: uri.href,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
  }

  function validateMappingId(variables: Record<string, string | string[]>): string {
    const raw = firstVariable(variables, "mapping_id");
    const parsed = MAPPING_ID.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `E_INPUT: invalid mapping_id (${parsed.error.issues[0]?.message ?? "invalid"}).`,
      );
    }
    return parsed.data;
  }

  function validateGistId(variables: Record<string, string | string[]>): string {
    const raw = firstVariable(variables, "gist_id");
    const parsed = GIST_ID.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `E_INPUT: invalid gist_id (${parsed.error.issues[0]?.message ?? "invalid"}).`,
      );
    }
    return parsed.data;
  }

  function validateFilename(variables: Record<string, string | string[]>): string {
    const raw = firstVariable(variables, "filename");
    const parsed = FILENAME.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `E_INPUT: invalid filename (${parsed.error.issues[0]?.message ?? "invalid"}).`,
      );
    }
    return parsed.data;
  }

  async function fetchGist(
    services: ResourceServices,
    gistId: string,
    memo: RequestMemo<string, GistViewLike>,
  ): Promise<GistViewLike> {
    return memo.get(gistId, async () => {
      const result = await services.browser.open(gistId);
      if (!result.ok) throwServiceError(result.error, redactor);
      return result.value;
    });
  }

  function registerAll(server: ResourceRegistrar, services: ResourceServices): void {
    // gistjet://workspace
    server.registerResource(
      "workspace",
      "gistjet://workspace",
      {
        description: "Active workspace configuration with mapping_count.",
        mimeType: "application/json",
      },
      wrap("workspace", async () => {
        const loaded = await services.workspace.get();
        if (!loaded.ok) throwServiceError(loaded.error, redactor);
        return toWorkspaceResource(loaded.value);
      }),
    );

    // gistjet://mappings (list)
    server.registerResource(
      "mappings",
      "gistjet://mappings",
      {
        description: "List of mappings in the active workspace.",
        mimeType: "application/json",
      },
      wrap("mappings", async () => {
        const result = await services.mapping.list();
        if (!result.ok) throwServiceError(result.error, redactor);
        return toMappingsResource(result.value);
      }),
    );

    // gistjet://mappings/{mapping_id}
    server.registerResource(
      "mapping",
      new ResourceTemplate("gistjet://mappings/{mapping_id}", { list: undefined }),
      {
        description: "Full mapping entry by id.",
        mimeType: "application/json",
      },
      wrap("mapping", async (_uri, variables) => {
        const mappingId = validateMappingId(variables);
        const result = await services.mapping.get(mappingId);
        if (!result.ok) throwServiceError(result.error, redactor);
        return { ...result.value };
      }),
    );

    // gistjet://mappings/{mapping_id}/status
    server.registerResource(
      "mapping_status",
      new ResourceTemplate("gistjet://mappings/{mapping_id}/status", { list: undefined }),
      {
        description: "Sync classification and per-file status for a single mapping.",
        mimeType: "application/json",
      },
      wrap("mapping_status", async (_uri, variables) => {
        const mappingId = validateMappingId(variables);
        const result = await services.status.forMapping(mappingId);
        if (!result.ok) throwServiceError(result.error, redactor);
        return toMappingStatusResource(result.value);
      }),
    );

    // gistjet://gists/{gist_id}
    server.registerResource(
      "gist",
      new ResourceTemplate("gistjet://gists/{gist_id}", { list: undefined }),
      {
        description: "Remote gist metadata (file list, visibility, revision).",
        mimeType: "application/json",
      },
      wrap("gist", async (_uri, variables, memo) => {
        const gistId = validateGistId(variables);
        const view = await fetchGist(services, gistId, memo);
        return toGistResource(view);
      }),
    );

    // gistjet://gists/{gist_id}/files/{filename}
    server.registerResource(
      "gist_file",
      new ResourceTemplate("gistjet://gists/{gist_id}/files/{filename}", { list: undefined }),
      {
        description:
          "Text or base64 content for a single file inside a remote gist (subject to truncation rules).",
        mimeType: "application/json",
      },
      wrap("gist_file", async (_uri, variables, memo) => {
        const gistId = validateGistId(variables);
        const filename = validateFilename(variables);
        const view = await fetchGist(services, gistId, memo);
        const file = toGistFileResource(view, filename);
        if (!file) {
          throw new Error(`E_NOT_FOUND: file ${filename} not found in gist ${gistId}.`);
        }
        return file;
      }),
    );
  }

  return { registerAll };
}
