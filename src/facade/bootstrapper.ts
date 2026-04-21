import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuthError, AuthService, TokenInfo, ToolSurface } from "../core/auth-service";
import type { Redactor } from "../core/redactor";
import type { Logger } from "../shared/ports/logger";

import { createMcpResourceFacade, type ResourceServices } from "./mcp-resource-facade";
import { createMcpToolFacade, type DomainServices } from "./mcp-tool-facade";

// Minimal subsets of the MCP SDK surface used here — typed structurally so
// tests can pass in fakes without constructing real SDK instances.

type ToolRegistration = (
  name: string,
  config: { description?: string; inputSchema?: unknown; outputSchema?: unknown },
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>,
) => unknown;

type ResourceRegistration = (
  name: string,
  uriOrTemplate: string | ResourceTemplate,
  config: { title?: string; description?: string; mimeType?: string },
  readCallback: (
    uri: URL,
    variables: Record<string, string | string[]>,
    extra: Record<string, unknown>,
  ) => Promise<{ contents: ReadonlyArray<{ uri: string; mimeType?: string; text: string }> }>,
) => unknown;

export type McpServerLike = {
  registerTool: ToolRegistration;
  registerResource: ResourceRegistration;
  connect(transport: TransportLike): Promise<void>;
  close(): Promise<void>;
};

export type TransportLike = {
  start?: () => Promise<void>;
  close?: () => Promise<void>;
  onclose?: () => void;
};

export type ProcessLike = {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  exit(code: number): void;
};

export type BootstrapDeps = {
  readonly workspaceRoot: string;
  readonly redactor: Redactor;
  readonly logger: Logger;
  readonly authService: AuthService;
  readonly services: DomainServices & ResourceServices;
  readonly mcpServer: McpServerLike;
  readonly transport: TransportLike;
};

export type StartResult = {
  readonly status: "running" | "auth_failed";
  readonly toolSurface: ToolSurface;
  readonly tokenInfo: TokenInfo | null;
  readonly authError?: AuthError;
  readonly stop: () => Promise<void>;
};

export type Bootstrapper = {
  start(env: NodeJS.ProcessEnv): Promise<StartResult>;
  installProcessHandlers(proc: ProcessLike, started: StartResult): () => void;
};

export function createBootstrapper(deps: BootstrapDeps): Bootstrapper {
  const { logger, redactor, authService, services, mcpServer, transport } = deps;

  async function start(env: NodeJS.ProcessEnv): Promise<StartResult> {
    logger.info("bootstrap.started", { workspace_root: deps.workspaceRoot });
    const resolved = authService.resolve(env);
    const token = resolved.ok ? resolved.value : null;
    let tokenInfo: TokenInfo | null = null;

    if (token !== null) {
      const verified = await authService.verifyAccess(token);
      if (!verified.ok) {
        logger.warn("auth.verification_failed", { code: verified.error.code });
        return {
          status: "auth_failed",
          toolSurface: { available: [], disabled: [] },
          tokenInfo: null,
          authError: verified.error,
          async stop() {
            // Nothing started — no-op.
          },
        };
      }
      tokenInfo = verified.value;
    }

    const surface = authService.toolSurface({ hasToken: token !== null });
    logger.info("bootstrap.tool_surface", {
      available: surface.available,
      disabled: surface.disabled,
    });

    const toolFacade = createMcpToolFacade({ redactor, logger });
    const resourceFacade = createMcpResourceFacade({ redactor, logger });

    toolFacade.registerAll(mcpServer, services, { allowedTools: surface.available });
    resourceFacade.registerAll(mcpServer, services);

    await mcpServer.connect(transport);
    logger.info("bootstrap.transport_connected", {});

    let stopped = false;
    async function stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      logger.info("bootstrap.shutdown.started", {});
      try {
        if (transport.close) await transport.close();
      } catch (cause) {
        logger.warn("bootstrap.shutdown.transport_close_failed", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      try {
        await mcpServer.close();
      } catch (cause) {
        logger.warn("bootstrap.shutdown.server_close_failed", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      logger.info("bootstrap.shutdown.completed", {});
    }

    return {
      status: "running",
      toolSurface: surface,
      tokenInfo,
      stop,
    };
  }

  function installProcessHandlers(proc: ProcessLike, started: StartResult): () => void {
    function causeToPayload(cause: unknown): Record<string, unknown> {
      if (cause instanceof Error) {
        return { name: cause.name, message: cause.message };
      }
      return { value: String(cause) };
    }

    const onSignal = async (...args: unknown[]): Promise<void> => {
      const signal = typeof args[0] === "string" ? args[0] : "UNKNOWN";
      logger.info("bootstrap.signal_received", { signal });
      await started.stop();
      proc.exit(0);
    };

    const onUncaught = (...args: unknown[]): void => {
      const cause = args[0];
      logger.error("mcp.uncaught_exception", {
        code: "E_INTERNAL",
        cause: causeToPayload(cause),
      });
    };

    const onUnhandledRejection = (...args: unknown[]): void => {
      const reason = args[0];
      logger.error("mcp.unhandled_rejection", {
        code: "E_INTERNAL",
        cause: causeToPayload(reason),
      });
    };

    const onTransportClose = (): void => {
      logger.info("bootstrap.transport_closed", {});
      void started.stop().finally(() => proc.exit(0));
    };

    proc.on("SIGINT", onSignal);
    proc.on("SIGTERM", onSignal);
    proc.on("uncaughtException", onUncaught);
    proc.on("unhandledRejection", onUnhandledRejection);
    transport.onclose = onTransportClose;

    return () => {
      proc.off("SIGINT", onSignal);
      proc.off("SIGTERM", onSignal);
      proc.off("uncaughtException", onUncaught);
      proc.off("unhandledRejection", onUnhandledRejection);
      if (transport.onclose === onTransportClose) {
        delete transport.onclose;
      }
    };
  }

  return { start, installProcessHandlers };
}
