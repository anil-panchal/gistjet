import { describe, expect, it } from "vitest";

import type { Redactor } from "../../src/core/redactor";
import { createMcpToolFacade, type DomainServices } from "../../src/facade/mcp-tool-facade";
import { toolSchemas } from "../../src/facade/tool-schemas";
import type { Logger } from "../../src/shared/ports/logger";
import { err, ok } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

type RegisteredEntry = {
  readonly name: string;
  readonly config: {
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  };
  readonly handler: (
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
};

function createFakeServer(): {
  registerTool: (
    name: string,
    config: { description?: string; inputSchema?: unknown; outputSchema?: unknown },
    handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>,
  ) => void;
  entries: RegisteredEntry[];
} {
  const entries: RegisteredEntry[] = [];
  return {
    registerTool(name, config, handler) {
      entries.push({ name, config, handler });
    },
    entries,
  };
}

function createStubRedactor(mask: (s: string) => string = (s) => s): Redactor & {
  calls: number;
} {
  let calls = 0;
  const redactString = (s: string) => mask(s);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };
  return {
    registerTokenValue() {},
    registerPattern() {},
    redactString,
    redactPayload<T>(payload: T): T {
      calls += 1;
      return walk(payload) as T;
    },
    get calls() {
      return calls;
    },
  } as unknown as Redactor & { calls: number };
}

function createSilentLogger(): Logger {
  const noop: Logger = {
    child: () => noop,
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return noop;
}

function errorPayload<T = Record<string, unknown>>(res: unknown): T {
  const r = res as { content?: ReadonlyArray<{ type: string; text: string }> };
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing error text block");
  return JSON.parse(text) as T;
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
  workspace_id: "ws-id",
  scratch_dir: "./scratch/",
  defaults: { visibility: "secret" },
  ignore: { workspace_patterns: [], respect_gitignore: false },
  mappings: [],
};

function createServices(overrides: Partial<DomainServices> = {}): DomainServices {
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
      async get(id: string) {
        return ok({ ...SAMPLE_MAPPING, id });
      },
      async unlink() {
        return ok({ removedMapping: SAMPLE_MAPPING, deletedRemote: false });
      },
    },
    browser: {
      async list() {
        return ok({
          items: [
            {
              gistId: "g1",
              htmlUrl: "https://gist.github.com/u/g1",
              description: "scratch",
              public: false,
              updatedAt: "2026-04-17T00:00:00Z",
              filenames: ["notes.md"],
              isMapped: false,
            },
          ],
        });
      },
      async open(gistId: string) {
        return ok({
          gistId,
          htmlUrl: `https://gist.github.com/u/${gistId}`,
          description: null,
          public: false,
          updatedAt: "2026-04-17T00:00:00Z",
          revision: "rev1",
          files: [
            {
              filename: "notes.md",
              sizeBytes: 10,
              truncated: false,
              content: "hello",
              encoding: "utf8" as const,
            },
          ],
          isMapped: false,
        });
      },
    },
    ...overrides,
  };
}

describe("McpToolFacade (task 9.2, req 16.3, 16.5, 15.1, 15.2)", () => {
  it("registerAll registers all 8 MVP tools with the server", () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const names = server.entries.map((e) => e.name).sort();
    expect(names).toEqual(Object.keys(toolSchemas).sort());
  });

  it("registrations carry description, inputSchema, and outputSchema", () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    for (const entry of server.entries) {
      expect(entry.config.description, `${entry.name} description`).toBeTruthy();
      expect(entry.config.inputSchema, `${entry.name} inputSchema`).toBeTruthy();
      expect(entry.config.outputSchema, `${entry.name} outputSchema`).toBeTruthy();
    }
  });

  it("returns structuredContent on successful tool call (init_workspace)", async () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = server.entries.find((e) => e.name === "init_workspace");
    expect(entry).toBeDefined();
    const result = (await entry!.handler({ target_dir: "/tmp/ws" }, {})) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent).toMatchObject({
      workspace_path: "/tmp/ws/.gistjet.json",
      gitignore: { action: "appended" },
    });
    expect(result.content[0]?.type).toBe("text");
  });

  it("maps domain errors through the error mapper and marks isError", async () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        publish: {
          async publishPath() {
            return err({ code: "E_VISIBILITY_CONFIRM" });
          },
          async publishSelection() {
            return err({ code: "E_VISIBILITY_CONFIRM" });
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "publish_path_to_gist");
    const result = (await entry!.handler(
      { path: "/tmp/ws/notes.md", visibility: "public" },
      {},
    )) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = errorPayload<{ code: string; requestId: string }>(result);
    expect(payload.code).toBe("E_VISIBILITY_CONFIRM");
    expect(payload.requestId).toHaveLength(26);
  });

  it("catches unexpected exceptions and emits E_INTERNAL without crashing", async () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        mapping: {
          async list() {
            return ok([]);
          },
          async get() {
            return ok(SAMPLE_MAPPING);
          },
          async unlink() {
            throw new Error("boom");
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "unlink_mapping");
    const result = (await entry!.handler({ mapping_id: "abc" }, {})) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = errorPayload<{ code: string; requestId: string }>(result);
    expect(payload.code).toBe("E_INTERNAL");
    expect(payload.requestId).toHaveLength(26);
  });

  it("routes success payloads through the redactor", async () => {
    const redactor = createStubRedactor((s) => s.replace(/ghp_SECRET_TOKEN_VALUE/g, "[REDACTED]"));
    const facade = createMcpToolFacade({ redactor, logger: createSilentLogger() });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        browser: {
          async list() {
            return ok({
              items: [
                {
                  gistId: "g1",
                  htmlUrl: "https://gist.github.com/u/g1",
                  description: "leaked ghp_SECRET_TOKEN_VALUE inline",
                  public: false,
                  updatedAt: "2026-04-17T00:00:00Z",
                  filenames: ["notes.md"],
                  isMapped: false,
                },
              ],
            });
          },
          async open() {
            throw new Error("unused");
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "list_gists");
    const result = (await entry!.handler({}, {})) as {
      structuredContent?: { items: Array<{ description: string }> };
    };
    expect(result.structuredContent?.items[0]?.description).toBe("leaked [REDACTED] inline");
  });

  it("routes error payloads through the redactor", async () => {
    const redactor = createStubRedactor((s) => s.replace(/ghp_SECRET_TOKEN_VALUE/g, "[REDACTED]"));
    const facade = createMcpToolFacade({ redactor, logger: createSilentLogger() });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        publish: {
          async publishPath() {
            return err({
              code: "E_IO",
              cause: "failed with token ghp_SECRET_TOKEN_VALUE attached",
            });
          },
          async publishSelection() {
            throw new Error("unused");
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "publish_path_to_gist");
    const result = (await entry!.handler({ path: "/tmp/ws/notes.md" }, {})) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = errorPayload<{ message: string; details?: { cause?: string } }>(result);
    expect(payload.details?.cause ?? "").not.toContain("ghp_SECRET_TOKEN_VALUE");
    expect(payload.message ?? "").not.toContain("ghp_SECRET_TOKEN_VALUE");
  });

  it("generates a unique requestId per invocation", async () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        publish: {
          async publishPath() {
            return err({ code: "E_VISIBILITY_CONFIRM" });
          },
          async publishSelection() {
            throw new Error("unused");
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "publish_path_to_gist");
    const first = await entry!.handler({ path: "a" }, {});
    const second = await entry!.handler({ path: "a" }, {});
    const firstId = errorPayload<{ requestId: string }>(first).requestId;
    const secondId = errorPayload<{ requestId: string }>(second).requestId;
    expect(firstId).not.toBe(secondId);
  });

  it("propagates requestId through async context while a handler runs", async () => {
    const captured: string[] = [];
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        status: {
          async forAll() {
            captured.push(facade.getCurrentRequestId() ?? "MISSING");
            return ok([]);
          },
          async forMapping(mappingId: string) {
            captured.push(facade.getCurrentRequestId() ?? "MISSING");
            return ok({ mappingId, classification: "in_sync", files: [] });
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "sync_status");
    await entry!.handler({}, {});
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toBe("MISSING");
    expect(captured[0]).toHaveLength(26);
    expect(facade.getCurrentRequestId()).toBeUndefined();
  });

  it("dispatches sync_status with mapping_id to forMapping, and without to forAll", async () => {
    let forMappingCalls = 0;
    let forAllCalls = 0;
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        status: {
          async forMapping(mappingId: string) {
            forMappingCalls += 1;
            return ok({ mappingId, classification: "in_sync", files: [] });
          },
          async forAll() {
            forAllCalls += 1;
            return ok([]);
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "sync_status");
    await entry!.handler({ mapping_id: "abc" }, {});
    await entry!.handler({}, {});
    expect(forMappingCalls).toBe(1);
    expect(forAllCalls).toBe(1);
  });

  it("snake_cases the sync_path_to_gist output shape to match the schema", async () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        sync: {
          async sync() {
            return ok({
              classification: "local_ahead" as const,
              plan: [{ filename: "notes.md", kind: "modified" as const, sizeBytes: 42 }],
              applied: true,
              newMappingState: SAMPLE_MAPPING,
              ignoredOnPull: [".env"],
            });
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "sync_path_to_gist");
    const result = (await entry!.handler({ mapping_id: "abc" }, {})) as {
      structuredContent?: {
        classification: string;
        plan: Array<{ filename: string; kind: string; size_bytes?: number }>;
        applied: boolean;
        new_mapping_state: { id: string };
        ignored_on_pull?: string[];
      };
    };
    expect(result.structuredContent?.classification).toBe("local_ahead");
    expect(result.structuredContent?.plan[0]).toEqual({
      filename: "notes.md",
      kind: "modified",
      size_bytes: 42,
    });
    expect(result.structuredContent?.new_mapping_state.id).toBe(SAMPLE_MAPPING.id);
    expect(result.structuredContent?.ignored_on_pull).toEqual([".env"]);
  });

  it("maps sync_path selector choices correctly (mapping_id vs path)", async () => {
    let received: { selector: { mappingId: string } | { path: string } } | undefined;
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        sync: {
          async sync(req) {
            received = { selector: req.selector };
            return ok({
              classification: "in_sync",
              plan: [],
              applied: false,
              newMappingState: SAMPLE_MAPPING,
            });
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "sync_path_to_gist");
    await entry!.handler({ mapping_id: "abc" }, {});
    expect(received?.selector).toEqual({ mappingId: "abc" });
    await entry!.handler({ path: "notes.md" }, {});
    expect(received?.selector).toEqual({ path: "notes.md" });
  });

  it("maps unlink_mapping selector choices correctly (mapping_id vs gist_id)", async () => {
    let received: { selector?: unknown } = {};
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        mapping: {
          async list() {
            return ok([]);
          },
          async get() {
            return ok(SAMPLE_MAPPING);
          },
          async unlink(req) {
            received = { selector: req.selector };
            return ok({ removedMapping: SAMPLE_MAPPING, deletedRemote: false });
          },
        },
      }),
    );
    const entry = server.entries.find((e) => e.name === "unlink_mapping");
    await entry!.handler({ mapping_id: "abc" }, {});
    expect(received.selector).toEqual({ mappingId: "abc" });
    await entry!.handler({ gist_id: "g1" }, {});
    expect(received.selector).toEqual({ gistId: "g1" });
  });

  it("produces E_INPUT when sync_path_to_gist receives neither selector", async () => {
    const facade = createMcpToolFacade({
      redactor: createStubRedactor(),
      logger: createSilentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());
    const entry = server.entries.find((e) => e.name === "sync_path_to_gist");
    const result = (await entry!.handler({}, {})) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(errorPayload<{ code: string }>(result).code).toBe("E_INPUT");
  });
});
