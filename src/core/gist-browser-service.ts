import type { GistSummary } from "../shared/gist";
import type { GhError, GitHubGistPort } from "../shared/ports/github-gist";
import type { LoadError, WorkspaceStorePort } from "../shared/ports/workspace-store";
import { err, ok, type Result } from "../shared/result";

export type VisibilityFilter = "all" | "public" | "secret";

export type ListRequest = {
  readonly filter?: {
    readonly visibility?: VisibilityFilter;
    readonly query?: string;
  };
  readonly cursor?: string;
};

export type GistListItem = GistSummary & { readonly isMapped: boolean };

export type ListResult = {
  readonly items: readonly GistListItem[];
  readonly nextCursor?: string;
};

export type OpenOptions = {
  readonly includeBinary?: boolean;
};

export type GistFileView = {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly content: string | null;
  readonly encoding: "utf8" | "base64";
};

export type GistView = {
  readonly gistId: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly public: boolean;
  readonly updatedAt: string;
  readonly revision: string;
  readonly files: readonly GistFileView[];
  readonly isMapped: boolean;
};

export type BrowserError =
  | { readonly code: "E_NOT_FOUND"; readonly gistId: string }
  | { readonly code: "E_AUTH"; readonly detail: "invalid_token" | "missing_permission" | "network" }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | { readonly code: "E_IO"; readonly cause: string }
  | LoadError;

export interface GistBrowserService {
  list(req?: ListRequest): Promise<Result<ListResult, BrowserError>>;
  open(gistId: string, opts?: OpenOptions): Promise<Result<GistView, BrowserError>>;
}

export type CreateGistBrowserServiceOptions = {
  readonly store: WorkspaceStorePort;
  readonly gistPort: GitHubGistPort;
  readonly workspaceRoot: string;
};

function mapGhError(e: GhError, gistId?: string): BrowserError {
  if (e.code === "E_AUTH") return { code: "E_AUTH", detail: e.detail };
  if (e.code === "E_RATE_LIMIT") return { code: "E_RATE_LIMIT", resetAt: e.resetAt };
  if (e.code === "E_NOT_FOUND") {
    return { code: "E_NOT_FOUND", gistId: gistId ?? e.resource };
  }
  return { code: "E_IO", cause: e.code };
}

function looksBinary(value: string | null): boolean {
  if (value === null) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0) return true;
  }
  return false;
}

export function createGistBrowserService(
  options: CreateGistBrowserServiceOptions,
): GistBrowserService {
  const { store, gistPort, workspaceRoot } = options;

  async function loadMappedGistIds(): Promise<Result<Set<string>, LoadError>> {
    const loaded = await store.load(workspaceRoot);
    if (!loaded.ok) return err(loaded.error);
    return ok(new Set(loaded.value.mappings.map((m) => m.gist_id)));
  }

  async function list(req: ListRequest = {}): Promise<Result<ListResult, BrowserError>> {
    const mappedIds = await loadMappedGistIds();
    if (!mappedIds.ok) return err(mappedIds.error);
    const page = await gistPort.list(req.cursor);
    if (!page.ok) return err(mapGhError(page.error));
    const visibility = req.filter?.visibility ?? "all";
    const queryLower = req.filter?.query?.toLowerCase();
    const filtered = page.value.items.filter((item) => {
      if (visibility === "public" && !item.public) return false;
      if (visibility === "secret" && item.public) return false;
      if (queryLower !== undefined) {
        const inDescription =
          item.description !== null && item.description.toLowerCase().includes(queryLower);
        const inFilename = item.filenames.some((fn) => fn.toLowerCase().includes(queryLower));
        if (!inDescription && !inFilename) return false;
      }
      return true;
    });
    const items = filtered.map((item) => ({
      ...item,
      isMapped: mappedIds.value.has(item.gistId),
    }));
    return ok({
      items,
      ...(page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
    });
  }

  async function open(
    gistId: string,
    opts: OpenOptions = {},
  ): Promise<Result<GistView, BrowserError>> {
    const mappedIds = await loadMappedGistIds();
    if (!mappedIds.ok) return err(mappedIds.error);
    const remote = await gistPort.get(gistId);
    if (!remote.ok) return err(mapGhError(remote.error, gistId));
    const includeBinary = opts.includeBinary === true;
    const files: GistFileView[] = remote.value.files.map((f) => {
      const binary = looksBinary(f.content);
      if (binary) {
        if (includeBinary && f.content !== null) {
          return {
            filename: f.filename,
            sizeBytes: f.sizeBytes,
            truncated: f.truncated,
            content: Buffer.from(f.content, "utf8").toString("base64"),
            encoding: "base64",
          };
        }
        return {
          filename: f.filename,
          sizeBytes: f.sizeBytes,
          truncated: f.truncated,
          content: null,
          encoding: "utf8",
        };
      }
      return {
        filename: f.filename,
        sizeBytes: f.sizeBytes,
        truncated: f.truncated,
        content: f.content,
        encoding: "utf8",
      };
    });
    return ok({
      gistId: remote.value.gistId,
      htmlUrl: remote.value.htmlUrl,
      description: remote.value.description,
      public: remote.value.public,
      updatedAt: remote.value.updatedAt,
      revision: remote.value.revision,
      files,
      isMapped: mappedIds.value.has(remote.value.gistId),
    });
  }

  return { list, open };
}
