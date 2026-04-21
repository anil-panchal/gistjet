// Task 10.5: env-gated live smoke test. Executes the MVP loop
// (init → publish → list → sync → unlink) against a real GitHub account
// only when `GISTJET_LIVE_TOKEN` is set. When absent, the suite is skipped
// so CI and local runs default to offline mode.
//
// **Run locally** with:
//   GISTJET_LIVE_TOKEN=ghp_xxx npx vitest run tests/e2e/live-sandbox.spec.ts
//
// Use a disposable test account — this test creates and then deletes a
// secret gist, but any hiccup in teardown leaves a stray gist behind.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createFsWorkspaceStore } from "../../src/adapters/fs-workspace-store";
import { createNodeFileSystem } from "../../src/adapters/node-filesystem";
import { createOctokitGistAdapter } from "../../src/adapters/octokit-gist";
import { createAuthService } from "../../src/core/auth-service";
import { createConflictResolver } from "../../src/core/conflict-resolver";
import { createDiffService } from "../../src/core/diff-service";
import { createFilenameFlattener } from "../../src/core/filename-flattener";
import { createGistBrowserService } from "../../src/core/gist-browser-service";
import { createIgnoreEngine } from "../../src/core/ignore-engine";
import { createLocalOverwriteGate } from "../../src/core/local-overwrite-gate";
import { createMappingService } from "../../src/core/mapping-service";
import { createPublishService } from "../../src/core/publish-service";
import { createRedactor } from "../../src/core/redactor";
import { createSecretScanner } from "../../src/core/secret-scanner";
import { createStatusService } from "../../src/core/status-service";
import { createSyncService } from "../../src/core/sync-service";
import { createVisibilityGuard } from "../../src/core/visibility-guard";
import { createWorkspaceService } from "../../src/core/workspace-service";
import {
  createMcpResourceFacade,
  type ResourceRegistrar,
  type ResourceServices,
} from "../../src/facade/mcp-resource-facade";
import {
  createMcpToolFacade,
  type DomainServices,
  type ToolRegistrar,
} from "../../src/facade/mcp-tool-facade";
import type { Logger } from "../../src/shared/ports/logger";
import { server as mswServer } from "../msw/server";

const LIVE_TOKEN = process.env.GISTJET_LIVE_TOKEN;
const skipLive = !LIVE_TOKEN;

function silentLogger(): Logger {
  const noop: Logger = {
    child: () => noop,
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return noop;
}

type LiveHarness = {
  client: Client;
  workspaceRoot: string;
  lastPublishedGistId?: string | undefined;
  dispose(): Promise<void>;
};

async function makeLiveHarness(token: string): Promise<LiveHarness> {
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gistjet-live-"));
  const redactor = createRedactor();
  const logger = silentLogger();
  const fs = createNodeFileSystem({ workspaceRoot });
  const store = createFsWorkspaceStore({ fs });
  const gistPort = createOctokitGistAdapter({
    auth: token,
    throttleId: `live-${Math.random().toString(36).slice(2)}`,
  });
  const ignoreEngine = createIgnoreEngine();
  const secretScanner = createSecretScanner();
  const visibilityGuard = createVisibilityGuard();
  const filenameFlattener = createFilenameFlattener();
  const conflictResolver = createConflictResolver();
  const localOverwriteGate = createLocalOverwriteGate();
  const diffService = createDiffService();
  const workspaceService = createWorkspaceService({ fs, store, workspaceRoot });
  const publishService = createPublishService({
    fs,
    store,
    gistPort,
    ignoreEngine,
    secretScanner,
    visibilityGuard,
    filenameFlattener,
    workspaceRoot,
  });
  const syncService = createSyncService({
    fs,
    store,
    gistPort,
    conflictResolver,
    localOverwriteGate,
    ignoreEngine,
    workspaceRoot,
  });
  const statusService = createStatusService({
    fs,
    store,
    gistPort,
    conflictResolver,
    diffService,
    workspaceRoot,
  });
  const mappingService = createMappingService({ store, gistPort, workspaceRoot });
  const browserService = createGistBrowserService({ store, gistPort, workspaceRoot });
  const authService = createAuthService({ redactor, portFactory: () => gistPort });

  const resolved = authService.resolve({ GISTJET_GITHUB_TOKEN: token });
  if (!resolved.ok || !resolved.value) throw new Error("failed to resolve live token");
  const verified = await authService.verifyAccess(resolved.value);
  if (!verified.ok) {
    throw new Error(`live token verification failed: ${verified.error.code}`);
  }
  const surface = authService.toolSurface({ hasToken: true });

  const services: DomainServices & ResourceServices = {
    workspace: workspaceService,
    publish: publishService,
    sync: syncService,
    status: statusService,
    mapping: mappingService,
    browser: browserService,
  };

  const mcpServer = new McpServer({ name: "gistjet-live", version: "0.0.0-test" });
  createMcpToolFacade({ redactor, logger }).registerAll(
    mcpServer as unknown as ToolRegistrar,
    services,
    { allowedTools: surface.available },
  );
  createMcpResourceFacade({ redactor, logger }).registerAll(
    mcpServer as unknown as ResourceRegistrar,
    services,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gistjet-live-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

  const harness: LiveHarness = {
    client,
    workspaceRoot,
    async dispose() {
      // Best-effort cleanup of the remote gist if a test left one behind.
      if (harness.lastPublishedGistId) {
        await gistPort.delete(harness.lastPublishedGistId).catch(() => null);
      }
      await client.close();
      await mcpServer.close();
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
    },
  };
  return harness;
}

describe.skipIf(skipLive)("Live sandbox smoke test (task 10.5, req 14.3, 16.1)", () => {
  let harness: LiveHarness;

  // The default MSW harness in tests/setup.ts intercepts all HTTP and rejects
  // unhandled requests — stop it for this suite so real GitHub calls go
  // through, and restore it after so other suites remain offline.
  beforeAll(() => {
    mswServer.close();
  });

  afterAll(() => {
    mswServer.listen({ onUnhandledRequest: "error" });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("runs init → publish → list → sync → unlink against a real account and cleans up", async () => {
    harness = await makeLiveHarness(LIVE_TOKEN!);

    // init
    const initRes = await harness.client.callTool({
      name: "init_workspace",
      arguments: { target_dir: harness.workspaceRoot },
    });
    expect(initRes.isError).toBeFalsy();

    // publish
    const file = path.join(harness.workspaceRoot, "smoke.md");
    const body = `gistjet live smoke test — ${new Date().toISOString()}\n`;
    await fsp.writeFile(file, body, "utf8");
    const pubRes = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file, description: "gistjet live smoke test" },
    });
    expect(pubRes.isError).toBeFalsy();
    const pub = pubRes.structuredContent as {
      gist_id: string;
      visibility: string;
      mapping: { id: string };
    };
    expect(pub.visibility).toBe("secret");
    harness.lastPublishedGistId = pub.gist_id;

    // list — published gist must be present and flagged as mapped.
    const listRes = await harness.client.callTool({ name: "list_gists", arguments: {} });
    const list = listRes.structuredContent as {
      items: ReadonlyArray<{ gist_id: string; is_mapped: boolean }>;
    };
    const found = list.items.find((i) => i.gist_id === pub.gist_id);
    expect(found?.is_mapped).toBe(true);

    // sync — nothing changed locally or remotely, should classify in_sync.
    const syncRes = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id },
    });
    expect(syncRes.isError).toBeFalsy();
    const sync = syncRes.structuredContent as { classification: string };
    expect(sync.classification).toBe("in_sync");

    // unlink with delete
    const unlinkRes = await harness.client.callTool({
      name: "unlink_mapping",
      arguments: {
        mapping_id: pub.mapping.id,
        delete_remote_gist: true,
        confirm_delete: true,
      },
    });
    expect(unlinkRes.isError).toBeFalsy();
    const unlink = unlinkRes.structuredContent as { deleted_remote: boolean };
    expect(unlink.deleted_remote).toBe(true);
    // Remote cleanup succeeded — avoid double-deletion during dispose.
    harness.lastPublishedGistId = undefined;
  });
});
