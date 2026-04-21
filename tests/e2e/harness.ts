// End-to-end harness for task 10. Drives the real domain graph through the
// MCP in-memory transport so scenario tests assert on tool/resource outputs
// exactly as an MCP client would see them. GitHub is simulated via MSW
// handlers wired to a small in-memory `FakeGistStore` per test.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { http, HttpResponse } from "msw";

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

export const E2E_TEST_TOKEN = "test-gh-token-for-e2e-not-a-real-secret";

// MSW handlers targeting these fake API endpoints are registered per test via
// `mswServer.use(...)`. They override the permissive handlers in
// tests/msw/handlers.ts so the Octokit adapter talks to our in-memory store.
const API_BASE = "https://api.github.com";

// --- Fake GitHub gist store ------------------------------------------------

type FakeFileData = {
  readonly content: string;
  readonly truncated?: boolean;
  readonly rawUrl?: string;
  readonly size?: number;
};

export type FakeGist = {
  id: string;
  description: string | null;
  public: boolean;
  updatedAt: string;
  revision: string;
  files: Record<string, FakeFileData>;
};

function makeApiFile(filename: string, data: FakeFileData): Record<string, unknown> {
  const content = data.content;
  const size = data.size ?? Buffer.byteLength(content, "utf8");
  return {
    filename,
    type: "text/plain",
    language: null,
    raw_url: data.rawUrl ?? `https://gist.githubusercontent.com/raw/${filename}`,
    size,
    truncated: data.truncated ?? false,
    // When truncated is true, the API returns null content and a raw_url to
    // fetch. Matches the real GitHub gist payload shape.
    content: data.truncated === true ? null : content,
  };
}

function toApiGist(g: FakeGist, login: string): Record<string, unknown> {
  return {
    id: g.id,
    html_url: `https://gist.github.com/${login}/${g.id}`,
    description: g.description,
    public: g.public,
    updated_at: g.updatedAt,
    files: Object.fromEntries(
      Object.entries(g.files).map(([name, data]) => [name, makeApiFile(name, data)]),
    ),
    history: [{ version: g.revision }],
    owner: { login },
    truncated: false,
  };
}

export type RawFetchOverride = {
  readonly url: string;
  readonly body: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
};

type Tamperer = (files: Record<string, FakeFileData>) => Record<string, FakeFileData>;

export type FakeGistStore = {
  readonly gists: Map<string, FakeGist>;
  readonly rawOverrides: Map<string, RawFetchOverride>;
  add(gist: FakeGist): void;
  tamperNextCreate(transformer: Tamperer): void;
  takeTamperer(): Tamperer | null;
  nextId(): string;
};

function createFakeGistStore(): FakeGistStore {
  const gists = new Map<string, FakeGist>();
  const rawOverrides = new Map<string, RawFetchOverride>();
  let counter = 1;
  let tamperer: Tamperer | null = null;
  return {
    gists,
    rawOverrides,
    add(gist) {
      gists.set(gist.id, gist);
    },
    tamperNextCreate(fn) {
      tamperer = fn;
    },
    takeTamperer() {
      const t = tamperer;
      tamperer = null;
      return t;
    },
    nextId() {
      return `gist-${counter++}`;
    },
  };
}

export function installFakeGistHandlers(
  store: FakeGistStore,
  opts: {
    readonly login?: string;
    readonly scopesHeader?: string | null;
  } = {},
): void {
  const login = opts.login ?? "e2e-user";
  const scopesHeader = opts.scopesHeader === undefined ? "gist" : opts.scopesHeader;
  const headersForProbe: Record<string, string> = scopesHeader
    ? { "x-oauth-scopes": scopesHeader }
    : {};

  mswServer.use(
    // List gists (probe + `list_gists`).
    http.get(`${API_BASE}/gists`, ({ request }) => {
      const url = new URL(request.url);
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = Array.from(store.gists.values());
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage).map((g) => toApiGist(g, login));
      return HttpResponse.json(slice, { headers: headersForProbe });
    }),
    // /user fallback used when probe's /gists returns empty.
    http.get(`${API_BASE}/user`, () => HttpResponse.json({ login }, { headers: headersForProbe })),
    http.get(`${API_BASE}/gists/:id`, ({ params }) => {
      const id = String(params.id);
      const gist = store.gists.get(id);
      if (!gist) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(toApiGist(gist, login));
    }),
    http.post(`${API_BASE}/gists`, async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        description?: string;
        public?: boolean;
        files?: Record<string, { content?: string } | null>;
      };
      const filesIn = body.files ?? {};
      const tamperer = store.takeTamperer();
      let files: Record<string, FakeFileData> = {};
      for (const [name, val] of Object.entries(filesIn)) {
        if (val && typeof val.content === "string") {
          files[name] = { content: val.content };
        }
      }
      if (tamperer) {
        files = tamperer(files);
      }
      const id = store.nextId();
      const gist: FakeGist = {
        id,
        description: body.description ?? null,
        public: body.public === true,
        updatedAt: new Date().toISOString(),
        revision: `rev-${id}`,
        files,
      };
      store.gists.set(id, gist);
      return HttpResponse.json(toApiGist(gist, login), { status: 201 });
    }),
    http.patch(`${API_BASE}/gists/:id`, async ({ params, request }) => {
      const id = String(params.id);
      const gist = store.gists.get(id);
      if (!gist) return new HttpResponse(null, { status: 404 });
      const body = (await request.json().catch(() => ({}))) as {
        description?: string;
        files?: Record<string, { content?: string; filename?: string } | null>;
      };
      const nextFiles: Record<string, FakeFileData> = { ...gist.files };
      for (const [name, val] of Object.entries(body.files ?? {})) {
        if (val === null) {
          delete nextFiles[name];
          continue;
        }
        const targetName = val.filename ?? name;
        if (targetName !== name) delete nextFiles[name];
        nextFiles[targetName] = {
          content: val.content !== undefined ? val.content : (gist.files[name]?.content ?? ""),
        };
      }
      const updated: FakeGist = {
        ...gist,
        description: body.description ?? gist.description,
        files: nextFiles,
        updatedAt: new Date().toISOString(),
        revision: `${gist.revision}-upd`,
      };
      store.gists.set(id, updated);
      return HttpResponse.json(toApiGist(updated, login));
    }),
    http.delete(`${API_BASE}/gists/:id`, ({ params }) => {
      const id = String(params.id);
      if (!store.gists.has(id)) return new HttpResponse(null, { status: 404 });
      store.gists.delete(id);
      return new HttpResponse(null, { status: 204 });
    }),
    // Raw-content fallback used for truncated files.
    http.get("https://gist.githubusercontent.com/raw/:filename", ({ params }) => {
      const key = `raw:${String(params.filename)}`;
      const override = store.rawOverrides.get(key);
      if (override) {
        return new HttpResponse(override.body, {
          status: override.status ?? 200,
          headers: override.headers ?? { "content-type": "text/plain" },
        });
      }
      return new HttpResponse("raw content", { status: 200 });
    }),
  );
}

// --- Test harness ----------------------------------------------------------

export type E2EHarness = {
  readonly client: Client;
  readonly workspaceRoot: string;
  readonly gistStore: FakeGistStore;
  readonly services: DomainServices & ResourceServices;
  dispose(): Promise<void>;
};

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

export type HarnessOptions = {
  readonly token?: string | null;
  readonly fakeStoreSeed?: (store: FakeGistStore) => void;
  readonly mswOptions?: {
    readonly login?: string;
    readonly scopesHeader?: string | null;
  };
};

export async function makeE2EHarness(opts: HarnessOptions = {}): Promise<E2EHarness> {
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gistjet-e2e-"));
  const tokenValue = opts.token === null ? null : (opts.token ?? E2E_TEST_TOKEN);

  const gistStore = createFakeGistStore();
  if (opts.fakeStoreSeed) opts.fakeStoreSeed(gistStore);
  installFakeGistHandlers(gistStore, opts.mswOptions ?? {});

  const redactor = createRedactor();
  const logger = silentLogger();
  const fs = createNodeFileSystem({ workspaceRoot });
  const store = createFsWorkspaceStore({ fs });
  const gistPort = createOctokitGistAdapter({
    ...(tokenValue ? { auth: tokenValue } : {}),
    throttleId: `e2e-${Math.random().toString(36).slice(2)}`,
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

  const authService = createAuthService({
    redactor,
    portFactory: () => gistPort,
  });

  // Resolve and optionally verify token up front so the tool surface reflects
  // what a booted server would expose.
  const env: NodeJS.ProcessEnv = tokenValue ? { GISTJET_GITHUB_TOKEN: tokenValue } : {};
  const resolved = authService.resolve(env);
  const hasToken = resolved.ok && resolved.value !== null;
  if (hasToken && resolved.ok && resolved.value) {
    await authService.verifyAccess(resolved.value);
  }
  const surface = authService.toolSurface({ hasToken });

  const services: DomainServices & ResourceServices = {
    workspace: workspaceService,
    publish: publishService,
    sync: syncService,
    status: statusService,
    mapping: mappingService,
    browser: browserService,
  };

  const mcpServer = new McpServer({ name: "gistjet-e2e", version: "0.0.0-test" });

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
  const client = new Client({ name: "gistjet-e2e-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

  return {
    client,
    workspaceRoot,
    gistStore,
    services,
    async dispose() {
      await client.close();
      await mcpServer.close();
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

// --- Helpers exposed to tests ---------------------------------------------

// Accept the raw `CallToolResult` shape from the MCP client. The SDK types
// that result as a discriminated union whose non-structured variant lacks
// `structuredContent`; tests never hit that variant, so we widen to `unknown`
// and pull `structuredContent` off at runtime.
export function callStructured<T = Record<string, unknown>>(res: unknown): T {
  const r = res as { structuredContent?: unknown };
  return r.structuredContent as T;
}

// Error envelopes ride in `content[0].text` (JSON) only — the facade deliberately
// omits `structuredContent` on errors so real MCP clients don't reject the
// response when validating against the declared success outputSchema.
export function callError<T = Record<string, unknown>>(res: unknown): T {
  const r = res as { content?: ReadonlyArray<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing error text block");
  return JSON.parse(text) as T;
}
