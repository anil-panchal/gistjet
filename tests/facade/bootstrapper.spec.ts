import { describe, expect, it } from "vitest";

import type { AuthService, ToolSurface } from "../../src/core/auth-service";
import type { Redactor } from "../../src/core/redactor";
import {
  createBootstrapper,
  type BootstrapDeps,
  type McpServerLike,
  type ProcessLike,
  type TransportLike,
} from "../../src/facade/bootstrapper";
import type { ResourceServices } from "../../src/facade/mcp-resource-facade";
import type { DomainServices } from "../../src/facade/mcp-tool-facade";
import type { Logger } from "../../src/shared/ports/logger";
import { ok } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

// ---- Helpers ---------------------------------------------------------------

function stubRedactor(): Redactor {
  return {
    registerTokenValue() {},
    registerPattern() {},
    redactString: (s) => s,
    redactPayload: <T>(p: T) => p,
  };
}

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

const SAMPLE_MAPPING: Mapping = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  local_path: "notes.md",
  gist_id: "g1",
  kind: "file",
  visibility: "secret",
  sync_mode: "manual",
  status: "active",
  created_at: "2026-04-17T00:00:00Z",
  last_synced_at: null,
  last_remote_revision: null,
  last_local_hash: null,
  file_snapshots: [],
};

const SAMPLE_CONFIG: WorkspaceFile = {
  schema_version: 1,
  workspace_id: "ws-1",
  scratch_dir: "./scratch/",
  defaults: { visibility: "secret" },
  ignore: { workspace_patterns: [], respect_gitignore: false },
  mappings: [SAMPLE_MAPPING],
};

type ServerEntry = {
  readonly kind: "tool" | "resource";
  readonly name: string;
};

function createFakeServer(): McpServerLike & {
  entries: ServerEntry[];
  connected: boolean;
  closed: boolean;
} {
  const entries: ServerEntry[] = [];
  let connected = false;
  let closed = false;
  const server: McpServerLike & { entries: ServerEntry[]; connected: boolean; closed: boolean } = {
    entries,
    get connected() {
      return connected;
    },
    get closed() {
      return closed;
    },
    registerTool(name: string) {
      entries.push({ kind: "tool", name });
    },
    registerResource(name: string) {
      entries.push({ kind: "resource", name });
    },
    async connect() {
      connected = true;
    },
    async close() {
      closed = true;
    },
  };
  return server;
}

function createFakeTransport(): TransportLike & { started: boolean; closedCalls: number } {
  let started = false;
  let closedCalls = 0;
  return {
    get started() {
      return started;
    },
    get closedCalls() {
      return closedCalls;
    },
    async start() {
      started = true;
    },
    async close() {
      closedCalls += 1;
    },
  } as TransportLike & { started: boolean; closedCalls: number };
}

function createFakeProcess(): ProcessLike & {
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  exitCalls: number[];
} {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const exitCalls: number[] = [];
  return {
    listeners,
    exitCalls,
    on(event: string, handler: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(handler);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      const list = listeners[event];
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    exit(code: number) {
      exitCalls.push(code);
    },
  } as ProcessLike & {
    listeners: Record<string, Array<(...args: unknown[]) => void>>;
    exitCalls: number[];
  };
}

function createFakeAuthService(
  overrides: Partial<{
    token: string | null;
    verifySucceeds: boolean;
    surface: ToolSurface;
  }> = {},
): AuthService & { resolveCalls: number; verifyCalls: number } {
  const token = overrides.token === undefined ? "ghp_x" : overrides.token;
  const verifySucceeds = overrides.verifySucceeds !== false;
  const surface: ToolSurface =
    overrides.surface ??
    (token !== null
      ? {
          available: [
            "init_workspace",
            "publish_path_to_gist",
            "publish_selection_to_gist",
            "sync_path_to_gist",
            "sync_status",
            "list_gists",
            "open_gist",
            "unlink_mapping",
          ],
          disabled: [],
        }
      : {
          available: ["list_gists", "open_gist", "sync_status"],
          disabled: [
            "init_workspace",
            "publish_path_to_gist",
            "publish_selection_to_gist",
            "sync_path_to_gist",
            "unlink_mapping",
          ],
        });

  let resolveCalls = 0;
  let verifyCalls = 0;
  const resolveResult = (): ReturnType<AuthService["resolve"]> =>
    token === null ? ok(null) : ok(token as unknown as Parameters<AuthService["verifyAccess"]>[0]);
  return {
    resolve() {
      resolveCalls += 1;
      return resolveResult();
    },
    async verifyAccess() {
      verifyCalls += 1;
      if (verifySucceeds) {
        return ok({
          login: "octocat",
          tokenKind: "classic",
          scopesReported: ["gist"],
        });
      }
      return { ok: false, error: { code: "E_AUTH", detail: "invalid_token" } };
    },
    toolSurface() {
      return surface;
    },
    get resolveCalls() {
      return resolveCalls;
    },
    get verifyCalls() {
      return verifyCalls;
    },
  } as AuthService & { resolveCalls: number; verifyCalls: number };
}

function createFakeDomainServices(): DomainServices & ResourceServices {
  return {
    workspace: {
      async init() {
        return ok({
          workspacePath: "/tmp/ws/.gistjet.json",
          config: SAMPLE_CONFIG,
          gitignore: { action: "appended", path: "/tmp/ws/.gitignore" },
        });
      },
      async get() {
        return ok(SAMPLE_CONFIG);
      },
      async update() {
        return ok(SAMPLE_CONFIG);
      },
    },
    publish: {
      async publishPath() {
        return ok({
          gistId: "g1",
          htmlUrl: "https://gist.github.com/u/g1",
          visibility: "secret" as const,
          mapping: SAMPLE_MAPPING,
          ignoredFiles: [],
          warnings: [],
        });
      },
      async publishSelection() {
        return ok({
          gistId: "g2",
          htmlUrl: "https://gist.github.com/u/g2",
          visibility: "secret" as const,
          mapping: SAMPLE_MAPPING,
          ignoredFiles: [],
          warnings: [],
        });
      },
    },
    sync: {
      async sync() {
        return ok({
          classification: "in_sync" as const,
          plan: [],
          applied: false,
          newMappingState: SAMPLE_MAPPING,
        });
      },
    },
    status: {
      async forMapping(mappingId: string) {
        return ok({
          mappingId,
          classification: "in_sync" as const,
          files: [],
        });
      },
      async forAll() {
        return ok([]);
      },
    },
    mapping: {
      async list() {
        return ok([SAMPLE_MAPPING]);
      },
      async get() {
        return ok(SAMPLE_MAPPING);
      },
      async unlink() {
        return ok({ removedMapping: SAMPLE_MAPPING, deletedRemote: false });
      },
    },
    browser: {
      async list() {
        return ok({ items: [] });
      },
      async open(gistId: string) {
        return ok({
          gistId,
          htmlUrl: `https://gist.github.com/u/${gistId}`,
          description: null,
          public: false,
          updatedAt: "2026-04-17T00:00:00Z",
          revision: "rev1",
          files: [],
          isMapped: false,
        });
      },
    },
  };
}

type FakeBundle = BootstrapDeps & {
  server: ReturnType<typeof createFakeServer>;
  transport: ReturnType<typeof createFakeTransport>;
  authService: ReturnType<typeof createFakeAuthService>;
  services: ReturnType<typeof createFakeDomainServices>;
};

function buildDeps(overrides: Partial<BootstrapDeps> = {}): FakeBundle {
  const defaultServer = createFakeServer();
  const defaultTransport = createFakeTransport();
  const defaultAuth = createFakeAuthService();
  const defaultServices = createFakeDomainServices();
  const base: BootstrapDeps = {
    workspaceRoot: "/tmp/ws",
    redactor: stubRedactor(),
    logger: silentLogger(),
    authService: defaultAuth,
    services: defaultServices,
    mcpServer: defaultServer,
    transport: defaultTransport,
  };
  const final = { ...base, ...overrides };
  return {
    ...final,
    server: final.mcpServer as ReturnType<typeof createFakeServer>,
    transport: final.transport as ReturnType<typeof createFakeTransport>,
    authService: final.authService as ReturnType<typeof createFakeAuthService>,
    services: final.services as ReturnType<typeof createFakeDomainServices>,
  };
}

// ---- Tests ----------------------------------------------------------------

describe("Bootstrapper (task 9.4, req 14.1-14.3, 16.1-16.5)", () => {
  describe("start()", () => {
    it("registers all 8 MVP tools and all 6 resources when a valid token is present", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      const result = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      expect(result.status).toBe("running");
      const tools = deps.server.entries.filter((e) => e.kind === "tool").map((e) => e.name);
      const resources = deps.server.entries.filter((e) => e.kind === "resource").map((e) => e.name);
      expect(tools).toHaveLength(8);
      expect(resources).toHaveLength(6);
    });

    it("calls authService.resolve and verifyAccess in order", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      expect(deps.authService.resolveCalls).toBe(1);
      expect(deps.authService.verifyCalls).toBe(1);
    });

    it("registers only read-only tools when no token is configured", async () => {
      const deps = buildDeps({ authService: createFakeAuthService({ token: null }) });
      const bs = createBootstrapper(deps);
      const result = await bs.start({});
      expect(result.status).toBe("running");
      const tools = deps.server.entries.filter((e) => e.kind === "tool").map((e) => e.name);
      expect(tools.sort()).toEqual(["list_gists", "open_gist", "sync_status"].sort());
    });

    it("returns status=auth_failed when verifyAccess rejects the token", async () => {
      const deps = buildDeps({
        authService: createFakeAuthService({ verifySucceeds: false }),
      });
      const bs = createBootstrapper(deps);
      const result = await bs.start({ GISTJET_GITHUB_TOKEN: "bad" });
      expect(result.status).toBe("auth_failed");
      expect(result.authError?.code).toBe("E_AUTH");
      // No tools registered when auth fails
      const tools = deps.server.entries.filter((e) => e.kind === "tool");
      expect(tools).toHaveLength(0);
    });

    it("connects the transport on success", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      expect(deps.server.connected).toBe(true);
    });

    it("does not connect the transport when auth fails", async () => {
      const deps = buildDeps({
        authService: createFakeAuthService({ verifySucceeds: false }),
      });
      const bs = createBootstrapper(deps);
      await bs.start({ GISTJET_GITHUB_TOKEN: "bad" });
      expect(deps.server.connected).toBe(false);
    });

    it("exposes a stop() that closes the transport and server", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      const result = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      await result.stop();
      expect(deps.server.closed).toBe(true);
      expect(deps.transport.closedCalls).toBeGreaterThanOrEqual(1);
    });
  });

  describe("installProcessHandlers()", () => {
    it("registers SIGINT, SIGTERM, uncaughtException, and unhandledRejection handlers", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      const started = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      const proc = createFakeProcess();
      bs.installProcessHandlers(proc, started);
      expect(Object.keys(proc.listeners).sort()).toEqual(
        ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].sort(),
      );
    });

    it("SIGINT handler triggers a clean stop and process.exit(0)", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      const started = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      const proc = createFakeProcess();
      bs.installProcessHandlers(proc, started);
      const handler = proc.listeners.SIGINT?.[0];
      expect(handler).toBeDefined();
      await handler!();
      expect(deps.server.closed).toBe(true);
      expect(proc.exitCalls).toEqual([0]);
    });

    it("uncaughtException handler logs E_INTERNAL without calling process.exit", async () => {
      const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const logger: Logger = {
        child: () => logger,
        debug() {},
        info() {},
        warn() {},
        error(event, payload) {
          logged.push({ event, payload });
        },
      };
      const deps = buildDeps({ logger });
      const bs = createBootstrapper(deps);
      const started = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      const proc = createFakeProcess();
      bs.installProcessHandlers(proc, started);
      const handler = proc.listeners.uncaughtException?.[0];
      expect(handler).toBeDefined();
      expect(() => handler!(new Error("boom"))).not.toThrow();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.payload.code).toBe("E_INTERNAL");
      expect(proc.exitCalls).toEqual([]);
    });

    it("unhandledRejection handler logs E_INTERNAL without calling process.exit", async () => {
      const logged: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const logger: Logger = {
        child: () => logger,
        debug() {},
        info() {},
        warn() {},
        error(event, payload) {
          logged.push({ event, payload });
        },
      };
      const deps = buildDeps({ logger });
      const bs = createBootstrapper(deps);
      const started = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      const proc = createFakeProcess();
      bs.installProcessHandlers(proc, started);
      const handler = proc.listeners.unhandledRejection?.[0];
      expect(handler).toBeDefined();
      handler!(new Error("rejected"));
      expect(logged).toHaveLength(1);
      expect(logged[0]?.payload.code).toBe("E_INTERNAL");
      expect(proc.exitCalls).toEqual([]);
    });

    it("returns a removal function that detaches every listener", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      const started = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      const proc = createFakeProcess();
      const remove = bs.installProcessHandlers(proc, started);
      remove();
      for (const list of Object.values(proc.listeners)) {
        expect(list).toHaveLength(0);
      }
    });

    it("transport.onclose triggers process.exit(0)", async () => {
      const deps = buildDeps();
      const bs = createBootstrapper(deps);
      const started = await bs.start({ GISTJET_GITHUB_TOKEN: "ghp_x" });
      const proc = createFakeProcess();
      bs.installProcessHandlers(proc, started);
      // simulate transport close event
      deps.transport.onclose?.();
      // allow async teardown to run
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
      expect(proc.exitCalls[0]).toBe(0);
    });
  });
});
