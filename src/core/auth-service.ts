import type { GitHubGistPort } from "../shared/ports/github-gist";
import type { Logger } from "../shared/ports/logger";
import { err, ok, type Result } from "../shared/result";

import type { Redactor } from "./redactor";

declare const tokenHandleBrand: unique symbol;
export type TokenHandle = string & { readonly [tokenHandleBrand]: "TokenHandle" };

export type TokenInfo = {
  readonly login: string;
  readonly tokenKind: "classic" | "fine_grained" | "unknown";
  readonly scopesReported: readonly string[] | null;
};

export type AuthError =
  | { readonly code: "E_AUTH"; readonly detail: "missing_permission" | "invalid_token" | "network" }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string };

export type ToolSurface = {
  readonly available: readonly string[];
  readonly disabled: readonly string[];
};

export interface AuthService {
  resolve(env: NodeJS.ProcessEnv): Result<TokenHandle | null, never>;
  verifyAccess(token: TokenHandle): Promise<Result<TokenInfo, AuthError>>;
  toolSurface(state: { hasToken: boolean }): ToolSurface;
}

export type CreateAuthServiceOptions = {
  readonly redactor: Redactor;
  readonly logger?: Logger;
  readonly portFactory: (token: TokenHandle) => GitHubGistPort;
};

export const READ_ONLY_TOOL_NAMES: readonly string[] = ["list_gists", "open_gist", "sync_status"];

export const WRITE_TOOL_NAMES: readonly string[] = [
  "init_workspace",
  "publish_path_to_gist",
  "publish_selection_to_gist",
  "sync_path_to_gist",
  "unlink_mapping",
];

export const MVP_TOOL_NAMES: readonly string[] = [...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES];

const TOKEN_ENV_KEYS: readonly string[] = ["GISTJET_GITHUB_TOKEN", "GITHUB_TOKEN"];

function parseScopes(header: string): readonly string[] {
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function createAuthService(options: CreateAuthServiceOptions): AuthService {
  const { redactor, logger, portFactory } = options;
  let readonlyEventEmitted = false;

  function resolve(env: NodeJS.ProcessEnv): Result<TokenHandle | null, never> {
    for (const key of TOKEN_ENV_KEYS) {
      const raw = env[key];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      redactor.registerTokenValue(trimmed);
      return ok(trimmed as TokenHandle);
    }
    return ok(null);
  }

  async function verifyAccess(token: TokenHandle): Promise<Result<TokenInfo, AuthError>> {
    const port = portFactory(token);
    const probe = await port.probeGistAccess();
    if (probe.ok) {
      const { login, scopesHeader } = probe.value;
      const tokenKind: TokenInfo["tokenKind"] = scopesHeader === null ? "fine_grained" : "classic";
      const scopesReported = scopesHeader === null ? null : parseScopes(scopesHeader);
      logger?.info("auth.verified", {
        login,
        token_kind: tokenKind,
        scopes_reported: scopesReported,
      });
      return ok({ login, tokenKind, scopesReported });
    }
    const ghError = probe.error;
    if (ghError.code === "E_AUTH") {
      logger?.warn("auth.failed", { detail: ghError.detail });
      return err({ code: "E_AUTH", detail: ghError.detail });
    }
    if (ghError.code === "E_RATE_LIMIT") {
      logger?.warn("auth.failed", { detail: "rate_limit", reset_at: ghError.resetAt });
      return err({ code: "E_RATE_LIMIT", resetAt: ghError.resetAt });
    }
    logger?.warn("auth.failed", { detail: "network", cause: ghError.code });
    return err({ code: "E_AUTH", detail: "network" });
  }

  function toolSurface(state: { hasToken: boolean }): ToolSurface {
    if (state.hasToken) {
      return { available: MVP_TOOL_NAMES, disabled: [] };
    }
    if (!readonlyEventEmitted) {
      logger?.info("auth.readonly_mode", { disabled_tools: WRITE_TOOL_NAMES });
      readonlyEventEmitted = true;
    }
    return { available: READ_ONLY_TOOL_NAMES, disabled: WRITE_TOOL_NAMES };
  }

  return { resolve, verifyAccess, toolSurface };
}
