import type { GistAccessProbe, GistFull, GistMeta, GistSummary } from "../gist";
import type { Result } from "../result";

export type CreateGistInput = {
  readonly description?: string;
  readonly public: boolean;
  readonly files: Readonly<Record<string, { readonly content: string }>>;
};

export type UpdateGistInput = {
  readonly gistId: string;
  readonly description?: string;
  readonly files: Readonly<
    Record<string, { readonly content?: string; readonly filename?: string } | null>
  >;
};

export type GhError =
  | { readonly code: "E_AUTH"; readonly detail: "invalid_token" | "missing_permission" }
  | { readonly code: "E_NOT_FOUND"; readonly resource: string }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | { readonly code: "E_INPUT"; readonly issues: readonly string[] }
  | {
      readonly code: "E_TOO_LARGE";
      readonly file: string;
      readonly sizeBytes: number;
      readonly limit: number;
    }
  | { readonly code: "E_INTERNAL"; readonly cause: string };

export type ListResult = {
  readonly items: readonly GistSummary[];
  readonly nextCursor?: string;
};

export interface GitHubGistPort {
  create(input: CreateGistInput): Promise<Result<GistMeta, GhError>>;
  update(input: UpdateGistInput): Promise<Result<GistMeta, GhError>>;
  get(gistId: string): Promise<Result<GistFull, GhError>>;
  list(cursor?: string): Promise<Result<ListResult, GhError>>;
  delete(gistId: string): Promise<Result<void, GhError>>;
  fetchRaw(rawUrl: string): Promise<Result<string, GhError>>;
  probeGistAccess(): Promise<Result<GistAccessProbe, GhError>>;
}
