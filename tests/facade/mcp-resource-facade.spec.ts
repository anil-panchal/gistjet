import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import type { Redactor } from "../../src/core/redactor";
import {
  createMcpResourceFacade,
  createRequestMemo,
  type ResourceServices,
} from "../../src/facade/mcp-resource-facade";
import type { Logger } from "../../src/shared/ports/logger";
import { err, ok } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

type Registered = {
  readonly name: string;
  readonly uriOrTemplate: string | ResourceTemplate;
  readonly metadata: { description?: string; mimeType?: string };
  readonly readCallback: (
    uri: URL,
    variables: Record<string, string | string[]>,
    extra: Record<string, unknown>,
  ) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>;
};

function createFakeServer(): {
  registerResource: (
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    metadata: { description?: string; mimeType?: string },
    readCallback: Registered["readCallback"],
  ) => void;
  entries: Registered[];
} {
  const entries: Registered[] = [];
  return {
    registerResource(name, uriOrTemplate, metadata, readCallback) {
      entries.push({ name, uriOrTemplate, metadata, readCallback });
    },
    entries,
  };
}

function stubRedactor(mask: (s: string) => string = (s) => s): Redactor {
  const redactString = (s: string) => mask(s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return {
    registerTokenValue() {},
    registerPattern() {},
    redactString,
    redactPayload<T>(payload: T): T {
      return walk(payload) as T;
    },
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
  ignore: { workspace_patterns: ["dist/"], respect_gitignore: false },
  mappings: [SAMPLE_MAPPING],
};

function createServices(overrides: Partial<ResourceServices> = {}): ResourceServices {
  return {
    workspace: {
      async get() {
        return ok(SAMPLE_CONFIG);
      },
    },
    mapping: {
      async list() {
        return ok([SAMPLE_MAPPING]);
      },
      async get(mappingId: string) {
        if (mappingId !== SAMPLE_MAPPING.id) {
          return err({ code: "E_NOT_FOUND", mappingId });
        }
        return ok(SAMPLE_MAPPING);
      },
    },
    status: {
      async forMapping(mappingId: string) {
        if (mappingId !== SAMPLE_MAPPING.id) {
          return err({ code: "E_NOT_FOUND", mappingId });
        }
        return ok({
          mappingId,
          classification: "in_sync" as const,
          files: [],
        });
      },
    },
    browser: {
      async open(gistId: string) {
        if (gistId !== "g1") {
          return err({ code: "E_NOT_FOUND", gistId });
        }
        return ok({
          gistId,
          htmlUrl: `https://gist.github.com/u/${gistId}`,
          description: "scratch",
          public: false,
          updatedAt: "2026-04-17T00:00:00Z",
          revision: "rev1",
          files: [
            {
              filename: "notes.md",
              sizeBytes: 5,
              truncated: false,
              content: "hello",
              encoding: "utf8" as const,
            },
          ],
          isMapped: true,
          mappingId: SAMPLE_MAPPING.id,
        });
      },
    },
    ...overrides,
  };
}

function findEntry(entries: Registered[], name: string): Registered {
  const entry = entries.find((e) => e.name === name);
  if (!entry) throw new Error(`resource ${name} not registered`);
  return entry;
}

function templateUri(entry: Registered): string {
  if (typeof entry.uriOrTemplate === "string") return entry.uriOrTemplate;
  return entry.uriOrTemplate.uriTemplate.toString();
}

async function readJson(
  entry: Registered,
  uri: string,
  variables: Record<string, string> = {},
): Promise<unknown> {
  const result = await entry.readCallback(new URL(uri), variables, {});
  const first = result.contents[0];
  if (!first || !("text" in first)) {
    throw new Error("expected text content");
  }
  return JSON.parse(first.text);
}

describe("McpResourceFacade (task 9.3, req 13.1-13.5, 5.4)", () => {
  it("registers all six MVP resources", () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const byName = server.entries.map((e) => ({
      name: e.name,
      uri: templateUri(e),
    }));
    expect(byName).toEqual(
      expect.arrayContaining([
        { name: "workspace", uri: "gistjet://workspace" },
        { name: "mappings", uri: "gistjet://mappings" },
        { name: "mapping", uri: "gistjet://mappings/{mapping_id}" },
        { name: "mapping_status", uri: "gistjet://mappings/{mapping_id}/status" },
        { name: "gist", uri: "gistjet://gists/{gist_id}" },
        { name: "gist_file", uri: "gistjet://gists/{gist_id}/files/{filename}" },
      ]),
    );
    expect(byName).toHaveLength(6);
  });

  it("registrations carry a description on each resource", () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());
    for (const entry of server.entries) {
      expect(entry.metadata.description, `${entry.name} description`).toBeTruthy();
    }
  });

  it("reads gistjet://workspace with mapping_count and no full mappings", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "workspace");
    const payload = (await readJson(entry, "gistjet://workspace")) as {
      schema_version: number;
      mapping_count: number;
      mappings?: unknown;
    };
    expect(payload.schema_version).toBe(1);
    expect(payload.mapping_count).toBe(1);
    expect(payload.mappings).toBeUndefined();
  });

  it("reads gistjet://mappings as a list", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "mappings");
    const payload = (await readJson(entry, "gistjet://mappings")) as {
      mappings: Array<{ id: string }>;
    };
    expect(payload.mappings).toHaveLength(1);
    expect(payload.mappings[0]?.id).toBe(SAMPLE_MAPPING.id);
  });

  it("reads gistjet://mappings/{mapping_id}", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "mapping");
    const payload = (await readJson(entry, `gistjet://mappings/${SAMPLE_MAPPING.id}`, {
      mapping_id: SAMPLE_MAPPING.id,
    })) as { id: string };
    expect(payload.id).toBe(SAMPLE_MAPPING.id);
  });

  it("rejects invalid mapping_id in templated URI with a descriptive error", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "mapping");
    await expect(
      entry.readCallback(new URL("gistjet://mappings/"), { mapping_id: "" }, {}),
    ).rejects.toThrow();
  });

  it("surfaces a not-found error when the mapping is missing", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "mapping");
    await expect(
      entry.readCallback(new URL("gistjet://mappings/missing"), { mapping_id: "missing" }, {}),
    ).rejects.toThrow(/E_NOT_FOUND/);
  });

  it("reads gistjet://mappings/{mapping_id}/status", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "mapping_status");
    const payload = (await readJson(entry, `gistjet://mappings/${SAMPLE_MAPPING.id}/status`, {
      mapping_id: SAMPLE_MAPPING.id,
    })) as { mapping_id: string; classification: string };
    expect(payload.mapping_id).toBe(SAMPLE_MAPPING.id);
    expect(payload.classification).toBe("in_sync");
  });

  it("reads gistjet://gists/{gist_id} metadata", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "gist");
    const payload = (await readJson(entry, "gistjet://gists/g1", { gist_id: "g1" })) as {
      gist_id: string;
      is_mapped: boolean;
    };
    expect(payload.gist_id).toBe("g1");
    expect(payload.is_mapped).toBe(true);
  });

  it("reads gistjet://gists/{gist_id}/files/{filename}", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "gist_file");
    const payload = (await readJson(entry, "gistjet://gists/g1/files/notes.md", {
      gist_id: "g1",
      filename: "notes.md",
    })) as { filename: string; content: string; encoding: string };
    expect(payload.filename).toBe("notes.md");
    expect(payload.content).toBe("hello");
    expect(payload.encoding).toBe("utf8");
  });

  it("returns an error when the requested gist file is not in the gist", async () => {
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    facade.registerAll(server, createServices());

    const entry = findEntry(server.entries, "gist_file");
    await expect(
      entry.readCallback(
        new URL("gistjet://gists/g1/files/missing.md"),
        { gist_id: "g1", filename: "missing.md" },
        {},
      ),
    ).rejects.toThrow(/E_NOT_FOUND/);
  });

  it("redacts payloads through the redactor on success", async () => {
    const redactor = stubRedactor((s) => s.replace(/ghp_SECRET/g, "[REDACTED]"));
    const facade = createMcpResourceFacade({ redactor, logger: silentLogger() });
    const server = createFakeServer();
    facade.registerAll(
      server,
      createServices({
        mapping: {
          async list() {
            return ok([{ ...SAMPLE_MAPPING, local_path: "ghp_SECRET-leaked/path" }]);
          },
          async get() {
            return ok(SAMPLE_MAPPING);
          },
        },
      }),
    );
    const entry = findEntry(server.entries, "mappings");
    const payload = (await readJson(entry, "gistjet://mappings")) as {
      mappings: Array<{ local_path: string }>;
    };
    expect(payload.mappings[0]?.local_path).toBe("[REDACTED]-leaked/path");
  });

  it("does not mutate service state as a side effect (workspace.get called without update)", async () => {
    let updateCalls = 0;
    const facade = createMcpResourceFacade({
      redactor: stubRedactor(),
      logger: silentLogger(),
    });
    const server = createFakeServer();
    const services = createServices({
      workspace: {
        async get() {
          return ok(SAMPLE_CONFIG);
        },
      },
    });
    // Augment the mapping service with update spy — resource reads must not call it.
    (services as unknown as { workspace: { update?: () => void } }).workspace.update = () => {
      updateCalls += 1;
    };
    facade.registerAll(server, services);
    const entry = findEntry(server.entries, "workspace");
    await readJson(entry, "gistjet://workspace");
    expect(updateCalls).toBe(0);
  });

  it("createRequestMemo returns the same value for the same key and fetches only once", async () => {
    const memo = createRequestMemo<string, number>();
    let fetches = 0;
    const first = await memo.get("k", async () => {
      fetches += 1;
      return 42;
    });
    const second = await memo.get("k", async () => {
      fetches += 1;
      return 7;
    });
    expect(first).toBe(42);
    expect(second).toBe(42);
    expect(fetches).toBe(1);
  });

  it("createRequestMemo refetches under a new key", async () => {
    const memo = createRequestMemo<string, number>();
    const a = await memo.get("a", async () => 1);
    const b = await memo.get("b", async () => 2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
