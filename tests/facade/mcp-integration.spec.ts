import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Redactor } from "../../src/core/redactor";
import {
  createMcpResourceFacade,
  type ResourceRegistrar,
} from "../../src/facade/mcp-resource-facade";
import {
  createMcpToolFacade,
  type DomainServices,
  type ToolRegistrar,
} from "../../src/facade/mcp-tool-facade";
import type { Logger } from "../../src/shared/ports/logger";
import { err, ok } from "../../src/shared/result";
import type { Mapping, WorkspaceFile } from "../../src/shared/workspace";

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

function buildServices(): DomainServices & {
  readonly workspace: DomainServices["workspace"];
} {
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
      async sync(req) {
        if ("mappingId" in req.selector && req.selector.mappingId === "missing") {
          return err({ code: "E_NOT_FOUND", selector: req.selector });
        }
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
        return ok([
          {
            mappingId: SAMPLE_MAPPING.id,
            classification: "in_sync" as const,
            files: [],
          },
        ]);
      },
    },
    mapping: {
      async list() {
        return ok([SAMPLE_MAPPING]);
      },
      async get(id: string) {
        if (id === "missing") return err({ code: "E_NOT_FOUND", mappingId: id });
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
              isMapped: true,
              mappingId: SAMPLE_MAPPING.id,
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
  };
}

type Harness = {
  readonly client: Client;
  readonly server: McpServer;
  readonly dispose: () => Promise<void>;
};

async function makeHarness(): Promise<Harness> {
  const server = new McpServer({ name: "gistjet", version: "0.0.0-test" });
  const services = buildServices();
  const redactor = stubRedactor();
  const logger = silentLogger();
  // The SDK's McpServer has a narrower overload for registerTool/registerResource
  // than our facades' structural types. The structural shape is compatible at
  // runtime (both accept plain objects + callbacks) — cast is only to satisfy
  // the stricter SDK overload signatures.
  createMcpToolFacade({ redactor, logger }).registerAll(
    server as unknown as ToolRegistrar,
    services,
  );
  // ResourceServices tightens workspace.get()'s generic to WorkspaceFile; at
  // runtime `services` already satisfies this.
  createMcpResourceFacade({ redactor, logger }).registerAll(
    server as unknown as ResourceRegistrar,
    services as unknown as Parameters<ReturnType<typeof createMcpResourceFacade>["registerAll"]>[1],
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gistjet-test-client", version: "0.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    server,
    async dispose() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP in-memory integration (task 9.5, req 13.1, 13.5, 15.1, 16.1-16.5)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("advertises all 8 MVP tools via listTools", async () => {
    const result = await harness.client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "init_workspace",
        "publish_path_to_gist",
        "publish_selection_to_gist",
        "sync_path_to_gist",
        "sync_status",
        "list_gists",
        "open_gist",
        "unlink_mapping",
      ].sort(),
    );
  });

  it("advertises all 6 resources via listResources + listResourceTemplates", async () => {
    const listed = await harness.client.listResources();
    const templated = await harness.client.listResourceTemplates();
    const staticUris = listed.resources.map((r) => r.uri).sort();
    const templateUris = templated.resourceTemplates.map((r) => r.uriTemplate).sort();
    expect(staticUris).toEqual(["gistjet://mappings", "gistjet://workspace"]);
    expect(templateUris).toEqual(
      [
        "gistjet://gists/{gist_id}",
        "gistjet://gists/{gist_id}/files/{filename}",
        "gistjet://mappings/{mapping_id}",
        "gistjet://mappings/{mapping_id}/status",
      ].sort(),
    );
  });

  it("calls init_workspace and receives structured content", async () => {
    const res = await harness.client.callTool({
      name: "init_workspace",
      arguments: { target_dir: "/tmp/ws" },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { workspace_path?: string } | undefined;
    expect(sc?.workspace_path).toBe("/tmp/ws/.gistjet.json");
  });

  it("calls every MVP tool without raising", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "init_workspace", args: { target_dir: "/tmp/ws" } },
      { name: "publish_path_to_gist", args: { path: "/tmp/ws/notes.md" } },
      {
        name: "publish_selection_to_gist",
        args: { filename: "a.md", content: "hi" },
      },
      { name: "sync_path_to_gist", args: { mapping_id: SAMPLE_MAPPING.id } },
      { name: "sync_status", args: {} },
      { name: "list_gists", args: {} },
      { name: "open_gist", args: { gist_id: "g1" } },
      { name: "unlink_mapping", args: { mapping_id: SAMPLE_MAPPING.id } },
    ];
    for (const { name, args } of calls) {
      const res = await harness.client.callTool({ name, arguments: args });
      expect(res.isError, `${name} should succeed`).toBeFalsy();
      expect(res.structuredContent, `${name} structuredContent`).toBeDefined();
    }
  });

  it("returns an error envelope with a requestId when the tool reports a domain error", async () => {
    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: "missing" },
    });
    expect(res.isError).toBe(true);
    // Error details ride in `content` — not `structuredContent`, which would fail
    // client-side JSON-schema validation against the success outputSchema.
    expect(res.structuredContent).toBeUndefined();
    const content = res.content as ReadonlyArray<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as {
      code?: string;
      message?: string;
      requestId?: string;
    };
    expect(payload.code).toBe("E_NOT_FOUND");
    expect(payload.message).toBeTruthy();
    expect(payload.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("different invocations produce distinct requestIds (correlation id is per-call)", async () => {
    const first = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: "missing" },
    });
    const second = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: "missing" },
    });
    const firstContent = first.content as ReadonlyArray<{ type: string; text: string }>;
    const secondContent = second.content as ReadonlyArray<{ type: string; text: string }>;
    const firstId = (JSON.parse(firstContent[0]!.text) as { requestId?: string }).requestId;
    const secondId = (JSON.parse(secondContent[0]!.text) as { requestId?: string }).requestId;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(firstId).not.toBe(secondId);
  });

  it("error responses survive AJV validation after listTools caches validators", async () => {
    // Regression: real MCP hosts (e.g. Cursor) call listTools() on connect,
    // which populates the client's per-tool AJV validators. Every subsequent
    // tools/call with a declared outputSchema then has its structuredContent
    // validated — *regardless of isError*. Attaching the error envelope to
    // structuredContent caused clients to reject valid error responses with
    // JSON-RPC -32602 "Structured content does not match the tool's output
    // schema". The integration tests above skip listTools(), so the bug was
    // invisible there. This test forces the same path a live host takes.
    await harness.client.listTools();
    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: "missing" },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const content = res.content as ReadonlyArray<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text) as { code?: string };
    expect(payload.code).toBe("E_NOT_FOUND");
  });

  it("returns an SDK validation error when required input fields are missing", async () => {
    // open_gist requires gist_id — omit it to trigger Zod validation at the SDK layer.
    const res = await harness.client.callTool({
      name: "open_gist",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    const textBlock = (res.content as Array<{ type: string; text?: string }>)[0];
    expect(textBlock?.text ?? "").toMatch(/Input validation error/i);
    expect(textBlock?.text ?? "").toMatch(/gist_id/);
  });

  it("returns an SDK validation error when input types are wrong", async () => {
    // allow_binary must be boolean; passing a string triggers schema validation.
    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: "/tmp/ws/notes.md", allow_binary: "yes" },
    });
    expect(res.isError).toBe(true);
    const textBlock = (res.content as Array<{ type: string; text?: string }>)[0];
    expect(textBlock?.text ?? "").toMatch(/Input validation error/i);
    expect(textBlock?.text ?? "").toMatch(/allow_binary/);
  });

  it("surfaces the facade's E_INPUT when sync_path_to_gist receives neither selector", async () => {
    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: SAMPLE_MAPPING.id },
    });
    expect(res.isError).toBeFalsy();
  });

  it("reads gistjet://workspace via the resource surface", async () => {
    const res = await harness.client.readResource({ uri: "gistjet://workspace" });
    const first = res.contents[0];
    expect(first).toBeDefined();
    expect(first?.mimeType).toBe("application/json");
    if (!first || !("text" in first)) throw new Error("expected text content");
    const payload = JSON.parse(first.text) as { mapping_count?: number };
    expect(payload.mapping_count).toBe(1);
  });

  it("reads every templated resource via the in-process client", async () => {
    const uris = [
      "gistjet://mappings",
      `gistjet://mappings/${SAMPLE_MAPPING.id}`,
      `gistjet://mappings/${SAMPLE_MAPPING.id}/status`,
      "gistjet://gists/g1",
      "gistjet://gists/g1/files/notes.md",
    ];
    for (const uri of uris) {
      const res = await harness.client.readResource({ uri });
      expect(res.contents.length, uri).toBeGreaterThan(0);
    }
  });

  it("surfaces an error when reading an unknown mapping URI", async () => {
    await expect(
      harness.client.readResource({
        uri: "gistjet://mappings/missing",
      }),
    ).rejects.toThrow();
  });

  it("writes nothing to process.stdout during any tool or resource flow", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdoutBytes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as unknown as { write: (chunk: any) => boolean }).write = (
      chunk: unknown,
    ): boolean => {
      const size =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : chunk instanceof Uint8Array
            ? chunk.byteLength
            : 0;
      stdoutBytes += size;
      return true;
    };
    try {
      await harness.client.callTool({
        name: "init_workspace",
        arguments: { target_dir: "/tmp/ws" },
      });
      await harness.client.callTool({
        name: "list_gists",
        arguments: {},
      });
      await harness.client.readResource({ uri: "gistjet://workspace" });
      await harness.client.readResource({
        uri: `gistjet://mappings/${SAMPLE_MAPPING.id}`,
      });
    } finally {
      (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
    }
    expect(stdoutBytes).toBe(0);
  });
});
