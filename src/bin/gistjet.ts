// Entry point for the gistjet stdio MCP server. Composes adapters and core
// services, hands them to the bootstrapper, and connects a `StdioServerTransport`.
//
// Workspace root defaults to `process.cwd()`; override with
// `GISTJET_WORKSPACE_ROOT` when running from outside the target directory.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createFsWorkspaceStore } from "../adapters/fs-workspace-store";
import { createNodeFileSystem } from "../adapters/node-filesystem";
import { createOctokitGistAdapter } from "../adapters/octokit-gist";
import { createLogger } from "../adapters/pino-logger";
import { createAuthService } from "../core/auth-service";
import { createConflictResolver } from "../core/conflict-resolver";
import { createDiffService } from "../core/diff-service";
import { createFilenameFlattener } from "../core/filename-flattener";
import { createGistBrowserService } from "../core/gist-browser-service";
import { createIgnoreEngine } from "../core/ignore-engine";
import { createLocalOverwriteGate } from "../core/local-overwrite-gate";
import { createMappingService } from "../core/mapping-service";
import { createPublishService } from "../core/publish-service";
import { createRedactor } from "../core/redactor";
import { createSecretScanner, registerScannerRulesWithRedactor } from "../core/secret-scanner";
import { createStatusService } from "../core/status-service";
import { createSyncService } from "../core/sync-service";
import { createVisibilityGuard } from "../core/visibility-guard";
import { createWorkspaceService } from "../core/workspace-service";
import { createBootstrapper, type McpServerLike, type TransportLike } from "../facade/bootstrapper";
import type { ResourceServices } from "../facade/mcp-resource-facade";
import type { DomainServices } from "../facade/mcp-tool-facade";

import { parseCliArgs } from "./cli-args.js";
import { formatHelp, formatTtyBanner, formatVersion } from "./cli-messages.js";
import { GISTJET_VERSION } from "./version.js";

async function main(): Promise<void> {
  const workspaceRoot = process.env.GISTJET_WORKSPACE_ROOT ?? process.cwd();

  const redactor = createRedactor();
  registerScannerRulesWithRedactor(redactor);
  const logger = createLogger({ redactor });

  const fs = createNodeFileSystem({ workspaceRoot });
  const store = createFsWorkspaceStore({ fs });
  const envToken = process.env.GISTJET_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? undefined;
  const gistPort = createOctokitGistAdapter({
    ...(envToken ? { auth: envToken } : {}),
    logger,
  });

  const services: DomainServices & ResourceServices = {
    workspace: createWorkspaceService({ fs, store, workspaceRoot }),
    publish: createPublishService({
      fs,
      store,
      gistPort,
      ignoreEngine: createIgnoreEngine(),
      secretScanner: createSecretScanner(),
      visibilityGuard: createVisibilityGuard(),
      filenameFlattener: createFilenameFlattener(),
      workspaceRoot,
      logger,
    }),
    sync: createSyncService({
      fs,
      store,
      gistPort,
      conflictResolver: createConflictResolver(),
      localOverwriteGate: createLocalOverwriteGate(),
      ignoreEngine: createIgnoreEngine(),
      workspaceRoot,
      logger,
    }),
    status: createStatusService({
      fs,
      store,
      gistPort,
      conflictResolver: createConflictResolver(),
      diffService: createDiffService(),
      workspaceRoot,
    }),
    mapping: createMappingService({ store, gistPort, workspaceRoot, logger }),
    browser: createGistBrowserService({ store, gistPort, workspaceRoot }),
  };

  const authService = createAuthService({
    redactor,
    logger,
    portFactory: () => gistPort,
  });

  const mcpServer = new McpServer({ name: "gistjet", version: GISTJET_VERSION });
  const transport = new StdioServerTransport();

  const bootstrapper = createBootstrapper({
    workspaceRoot,
    redactor,
    logger,
    authService,
    services,
    mcpServer: mcpServer as unknown as McpServerLike,
    transport: transport as unknown as TransportLike,
  });

  const started = await bootstrapper.start(process.env);
  if (started.status === "auth_failed") {
    logger.error("bootstrap.auth_failed", {
      code: started.authError?.code ?? "E_AUTH",
      detail:
        started.authError && "detail" in started.authError ? started.authError.detail : undefined,
    });
    process.exit(1);
  }

  bootstrapper.installProcessHandlers(process, started);
}

const cliCommand = parseCliArgs(process.argv, process.stdin.isTTY);
if (cliCommand.kind === "version") {
  process.stdout.write(formatVersion(GISTJET_VERSION));
  process.exit(0);
}
if (cliCommand.kind === "help") {
  process.stdout.write(formatHelp(GISTJET_VERSION));
  process.exit(0);
}
if (cliCommand.kind === "tty-banner") {
  process.stdout.write(formatTtyBanner(GISTJET_VERSION));
  process.exit(0);
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`gistjet: fatal startup error: ${message}\n`);
  process.exit(1);
});
