import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { ulid } from "ulid";

import type { GistAccessProbe, GistFileRef, GistFull, GistMeta, GistSummary } from "../shared/gist";
import type {
  CreateGistInput,
  GhError,
  GitHubGistPort,
  ListResult,
  UpdateGistInput,
} from "../shared/ports/github-gist";
import type { Logger } from "../shared/ports/logger";
import { err, ok, type Result } from "../shared/result";

export const MAX_FILES_PER_GIST = 300;
export const DEFAULT_GIST_PAGE_SIZE = 30;
export const MAX_RAW_FETCH_BYTES = 10 * 1024 * 1024;

const ThrottledOctokit = Octokit.plugin(throttling);

export type CreateOctokitGistAdapterOptions = {
  readonly auth?: string;
  readonly octokit?: Octokit;
  readonly pageSize?: number;
  readonly logger?: Logger;
  readonly throttleId?: string;
};

type OctokitHttpErrorShape = {
  status?: number;
  request?: { method?: string; url?: string };
  response?: {
    headers?: Record<string, string | number | undefined>;
    data?: unknown;
    url?: string;
  };
};

type Github422Issue = {
  resource?: string;
  field?: string;
  code?: string;
  message?: string;
};

function headerValue(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return String(direct);
  const lower = headers[name.toLowerCase()];
  return lower !== undefined ? String(lower) : undefined;
}

function extractRateLimit(cause: unknown, now: () => number): { resetAt: string } | null {
  if (!cause || typeof cause !== "object") return null;
  const { status, response } = cause as OctokitHttpErrorShape;
  if (status !== 403 && status !== 429) return null;
  const headers = response?.headers;
  const resetUnix = headerValue(headers, "x-ratelimit-reset");
  const retryAfter = headerValue(headers, "retry-after");
  if (!resetUnix && !retryAfter) return null;
  if (resetUnix) {
    const seconds = Number(resetUnix);
    if (Number.isFinite(seconds)) {
      return { resetAt: new Date(seconds * 1000).toISOString() };
    }
  }
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const offsetMs = Number.isFinite(seconds) ? seconds * 1000 : 60_000;
    return { resetAt: new Date(now() + offsetMs).toISOString() };
  }
  return null;
}

type ApiFile = {
  filename?: string;
  type?: string;
  raw_url?: string;
  size?: number;
  truncated?: boolean;
  content?: string | null;
};

type ApiGist = {
  id: string;
  html_url: string;
  description: string | null;
  public: boolean;
  updated_at: string;
  files: Record<string, ApiFile | null>;
  history?: Array<{ version?: string }>;
};

type ApiGistWithOwner = ApiGist & {
  owner?: { login?: string };
};

function fileRefFrom(name: string, file: ApiFile | null | undefined): GistFileRef {
  return {
    filename: file?.filename ?? name,
    sizeBytes: file?.size ?? 0,
    isBinary: false,
    truncated: file?.truncated ?? false,
    rawUrl: file?.raw_url ?? null,
  };
}

function toMeta(gist: ApiGist): GistMeta {
  const files = Object.entries(gist.files ?? {})
    .filter((entry): entry is [string, ApiFile] => entry[1] !== null)
    .map(([name, file]) => fileRefFrom(name, file));
  return {
    gistId: gist.id,
    htmlUrl: gist.html_url,
    description: gist.description ?? null,
    public: gist.public,
    updatedAt: gist.updated_at,
    revision: gist.history?.[0]?.version ?? "",
    files,
  };
}

function toFull(gist: ApiGist): GistFull {
  const files = Object.entries(gist.files ?? {})
    .filter((entry): entry is [string, ApiFile] => entry[1] !== null)
    .map(([name, file]) => ({
      ...fileRefFrom(name, file),
      content: file.content ?? null,
    }));
  return {
    gistId: gist.id,
    htmlUrl: gist.html_url,
    description: gist.description ?? null,
    public: gist.public,
    updatedAt: gist.updated_at,
    revision: gist.history?.[0]?.version ?? "",
    files,
  };
}

function toSummary(gist: ApiGist): GistSummary {
  return {
    gistId: gist.id,
    htmlUrl: gist.html_url,
    description: gist.description ?? null,
    public: gist.public,
    updatedAt: gist.updated_at,
    filenames: Object.keys(gist.files ?? {}),
  };
}

function mapUnknownError(cause: unknown): GhError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: "E_INTERNAL", cause: message };
}

function extractValidationIssues(data: unknown): string[] {
  if (!data || typeof data !== "object") return ["validation failed"];
  const message = (data as { message?: unknown }).message;
  const rawErrors = (data as { errors?: unknown }).errors;
  const errors = Array.isArray(rawErrors) ? (rawErrors as Github422Issue[]) : [];
  if (errors.length === 0) {
    return [typeof message === "string" ? message : "validation failed"];
  }
  return errors.map((issue) => {
    const fieldPart = issue.field ? `${issue.field}: ` : "";
    const codePart = issue.code ? `[${issue.code}] ` : "";
    const msgPart = issue.message ?? "";
    const combined = `${fieldPart}${codePart}${msgPart}`.trim();
    if (combined.length > 0) return combined;
    return issue.field ?? issue.code ?? "validation failed";
  });
}

function fileNameFromRawUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    return last && last.length > 0 ? decodeURIComponent(last) : rawUrl;
  } catch {
    return rawUrl;
  }
}

export function createOctokitGistAdapter(
  options: CreateOctokitGistAdapterOptions = {},
): GitHubGistPort {
  const { logger } = options;
  const now = (): number => Date.now();

  function logRateLimit(
    kind: "primary" | "secondary",
    retryAfter: number,
    method: string,
    url: string,
    retryCount: number,
  ): void {
    logger?.warn("github.rate_limit", {
      kind,
      method,
      url,
      retry_after_seconds: retryAfter,
      retry_count: retryCount,
    });
  }

  const throttleConfig = {
    throttle: {
      id: options.throttleId ?? `gistjet-${ulid()}`,
      onRateLimit: (
        retryAfter: number,
        requestOptions: { method: string; url: string },
        _ok: unknown,
        retryCount: number,
      ): boolean => {
        logRateLimit("primary", retryAfter, requestOptions.method, requestOptions.url, retryCount);
        return false;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        requestOptions: { method: string; url: string },
        _ok: unknown,
        retryCount: number,
      ): boolean => {
        logRateLimit(
          "secondary",
          retryAfter,
          requestOptions.method,
          requestOptions.url,
          retryCount,
        );
        return false;
      },
    },
  };

  const octokit =
    options.octokit ??
    (options.auth
      ? new ThrottledOctokit({ auth: options.auth, ...throttleConfig })
      : new ThrottledOctokit(throttleConfig));
  const pageSize = options.pageSize ?? DEFAULT_GIST_PAGE_SIZE;

  function mapError(cause: unknown): GhError {
    const rl = extractRateLimit(cause, now);
    if (rl) return { code: "E_RATE_LIMIT", resetAt: rl.resetAt };
    if (cause && typeof cause === "object" && "status" in cause) {
      const shape = cause as OctokitHttpErrorShape;
      const status = shape.status ?? 0;
      if (status === 401) {
        return { code: "E_AUTH", detail: "invalid_token" };
      }
      if (status === 403) {
        return { code: "E_AUTH", detail: "missing_permission" };
      }
      if (status === 404) {
        const resource = shape.request?.url ?? shape.response?.url ?? "github gist resource";
        return { code: "E_NOT_FOUND", resource };
      }
      if (status === 422) {
        return { code: "E_INPUT", issues: extractValidationIssues(shape.response?.data) };
      }
      if (status >= 500 && status < 600) {
        return {
          code: "E_INTERNAL",
          cause: `github returned ${status}${shape.request?.url ? ` for ${shape.request.url}` : ""}`,
        };
      }
    }
    return mapUnknownError(cause);
  }

  async function create(input: CreateGistInput): Promise<Result<GistMeta, GhError>> {
    const fileCount = Object.keys(input.files).length;
    if (fileCount > MAX_FILES_PER_GIST) {
      return err({
        code: "E_INPUT",
        issues: [`file count ${fileCount} exceeds maximum ${MAX_FILES_PER_GIST}`],
      });
    }
    try {
      const response = await octokit.request("POST /gists", {
        ...(input.description !== undefined ? { description: input.description } : {}),
        public: input.public,
        files: input.files,
      });
      return ok(toMeta(response.data as ApiGist));
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async function update(input: UpdateGistInput): Promise<Result<GistMeta, GhError>> {
    try {
      const response = await octokit.request("PATCH /gists/{gist_id}", {
        gist_id: input.gistId,
        ...(input.description !== undefined ? { description: input.description } : {}),
        // GitHub accepts `files[name] = null` to delete; Octokit's generated
        // types don't model that, so we erase the field type here.
        files: input.files as unknown as Record<string, { content?: string; filename?: string }>,
      });
      return ok(toMeta(response.data as ApiGist));
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async function get(gistId: string): Promise<Result<GistFull, GhError>> {
    try {
      const response = await octokit.request("GET /gists/{gist_id}", { gist_id: gistId });
      const full = toFull(response.data as ApiGist);
      const filled = await fillTruncated(full);
      return filled;
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async function fillTruncated(full: GistFull): Promise<Result<GistFull, GhError>> {
    const needsFetch = full.files.filter(
      (file) => file.truncated && file.content === null && file.rawUrl,
    );
    if (needsFetch.length === 0) return ok(full);
    const contentByName = new Map<string, string>();
    for (const file of needsFetch) {
      const rawRes = await fetchRaw(file.rawUrl as string);
      if (!rawRes.ok) return err(rawRes.error);
      contentByName.set(file.filename, rawRes.value);
    }
    const files = full.files.map((file) => {
      const filled = contentByName.get(file.filename);
      return filled !== undefined ? { ...file, content: filled } : file;
    });
    return ok({ ...full, files });
  }

  async function list(cursor?: string): Promise<Result<ListResult, GhError>> {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isInteger(page) || page < 1) {
      return err({ code: "E_INPUT", issues: [`invalid cursor: ${cursor ?? ""}`] });
    }
    try {
      const response = await octokit.request("GET /gists", { per_page: pageSize, page });
      const items = (response.data as ApiGist[]).map(toSummary);
      const result: ListResult =
        items.length === pageSize ? { items, nextCursor: String(page + 1) } : { items };
      return ok(result);
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async function deleteGist(gistId: string): Promise<Result<void, GhError>> {
    try {
      await octokit.request("DELETE /gists/{gist_id}", { gist_id: gistId });
      return ok(undefined);
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  async function fetchRaw(rawUrl: string): Promise<Result<string, GhError>> {
    const file = fileNameFromRawUrl(rawUrl);
    try {
      const response = await fetch(rawUrl);
      if (response.status === 404) {
        return err({ code: "E_NOT_FOUND", resource: rawUrl });
      }
      if (!response.ok) {
        return err({
          code: "E_INTERNAL",
          cause: `raw fetch ${rawUrl} returned ${response.status}`,
        });
      }
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const declared = Number(contentLengthHeader);
        if (Number.isFinite(declared) && declared > MAX_RAW_FETCH_BYTES) {
          return err({
            code: "E_TOO_LARGE",
            file,
            sizeBytes: declared,
            limit: MAX_RAW_FETCH_BYTES,
          });
        }
      }
      const body = await response.text();
      const size = Buffer.byteLength(body, "utf8");
      if (size > MAX_RAW_FETCH_BYTES) {
        return err({
          code: "E_TOO_LARGE",
          file,
          sizeBytes: size,
          limit: MAX_RAW_FETCH_BYTES,
        });
      }
      return ok(body);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return err({ code: "E_INTERNAL", cause: message });
    }
  }

  async function probeGistAccess(): Promise<Result<GistAccessProbe, GhError>> {
    try {
      const response = await octokit.request("GET /gists", { per_page: 1 });
      const scopesHeader =
        typeof response.headers["x-oauth-scopes"] === "string"
          ? response.headers["x-oauth-scopes"]
          : null;
      const first = (response.data as ApiGistWithOwner[])[0];
      if (first?.owner?.login) {
        return ok({ login: first.owner.login, scopesHeader });
      }
      try {
        const userResponse = await octokit.request("GET /user");
        const login = (userResponse.data as { login?: string }).login;
        if (!login) {
          return err({ code: "E_INTERNAL", cause: "probe: /user returned no login" });
        }
        return ok({ login, scopesHeader });
      } catch (cause) {
        const mapped = mapError(cause);
        if (mapped.code === "E_RATE_LIMIT") return err(mapped);
        const message = cause instanceof Error ? cause.message : String(cause);
        return err({ code: "E_INTERNAL", cause: `probe /user fallback: ${message}` });
      }
    } catch (cause) {
      return err(mapError(cause));
    }
  }

  return {
    create,
    update,
    get,
    list,
    delete: deleteGist,
    fetchRaw,
    probeGistAccess,
  };
}
