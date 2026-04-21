import { describe, expect, it } from "vitest";

import type { FileSystemPort } from "../../src/shared/ports/filesystem";
import type { GitHubGistPort, GhError } from "../../src/shared/ports/github-gist";
import type { Logger } from "../../src/shared/ports/logger";
import type { WorkspaceStorePort } from "../../src/shared/ports/workspace-store";
import { err, ok } from "../../src/shared/result";

describe("GitHubGistPort (task 2.2)", () => {
  it("admits a stub implementation exposing all seven methods", () => {
    const stub: GitHubGistPort = {
      create: async () =>
        ok({
          gistId: "a",
          htmlUrl: "https://gist.github.com/a",
          description: null,
          public: false,
          updatedAt: "2026-04-17T00:00:00Z",
          revision: "sha1",
          files: [],
        }),
      update: async () =>
        ok({
          gistId: "a",
          htmlUrl: "https://gist.github.com/a",
          description: null,
          public: false,
          updatedAt: "2026-04-17T00:00:00Z",
          revision: "sha2",
          files: [],
        }),
      get: async () =>
        ok({
          gistId: "a",
          htmlUrl: "https://gist.github.com/a",
          description: null,
          public: false,
          updatedAt: "2026-04-17T00:00:00Z",
          revision: "sha1",
          files: [],
        }),
      list: async () => ok({ items: [] }),
      delete: async () => ok(undefined),
      fetchRaw: async () => ok("raw content"),
      probeGistAccess: async () => ok({ login: "u", scopesHeader: null }),
    };

    const methods: Array<keyof GitHubGistPort> = [
      "create",
      "update",
      "get",
      "list",
      "delete",
      "fetchRaw",
      "probeGistAccess",
    ];
    for (const m of methods) {
      expect(typeof stub[m]).toBe("function");
    }
  });

  it("GhError covers auth, not-found, rate-limit, input, and internal variants", () => {
    const variants: GhError[] = [
      { code: "E_AUTH", detail: "invalid_token" },
      { code: "E_AUTH", detail: "missing_permission" },
      { code: "E_NOT_FOUND", resource: "gist" },
      { code: "E_RATE_LIMIT", resetAt: "2026-04-17T20:00:00Z" },
      { code: "E_INPUT", issues: ["visibility"] },
      { code: "E_INTERNAL", cause: "boom" },
    ];
    expect(variants.every((v) => v.code.startsWith("E_"))).toBe(true);
  });
});

describe("WorkspaceStorePort (task 2.2)", () => {
  it("admits a stub implementation with load, writeAtomic, and withLock", async () => {
    const stub: WorkspaceStorePort = {
      load: async () => err({ code: "E_NOT_INITIALIZED" }),
      writeAtomic: async () => ok(undefined),
      withLock: async <T>(_root: string, fn: () => Promise<T>) => fn(),
    };
    const loaded = await stub.load("/tmp");
    expect(loaded.ok).toBe(false);
    const guarded = await stub.withLock("/tmp", async () => 7);
    expect(guarded).toBe(7);
  });
});

describe("FileSystemPort (task 2.2)", () => {
  it("admits a stub implementation with stat, read, writeAtomic, and enumerate", async () => {
    const stub: FileSystemPort = {
      stat: async () => err({ code: "E_NOT_FOUND" }),
      read: async () => ok({ kind: "text", value: "", encoding: "utf8" }),
      writeAtomic: async () => ok(undefined),
      enumerate: async function* () {
        yield {
          absolutePath: "/a",
          relativePath: "a",
          sizeBytes: 0,
          isDirectory: false,
          isBinaryHint: false,
          mtimeMs: 0,
        };
      },
    };
    const read = await stub.read("/x");
    expect(read.ok).toBe(true);
    const iter = stub.enumerate("/");
    const first = await iter[Symbol.asyncIterator]().next();
    expect(first.value?.absolutePath).toBe("/a");
  });

  it("FileContent discriminates text and binary kinds", () => {
    type FC = Awaited<ReturnType<FileSystemPort["read"]>>;
    const text: FC = { ok: true, value: { kind: "text", value: "hi", encoding: "utf8" } };
    const bin: FC = { ok: true, value: { kind: "binary", value: new Uint8Array([1, 2, 3]) } };
    expect(text.ok && text.value.kind).toBe("text");
    expect(bin.ok && bin.value.kind).toBe("binary");
  });
});

describe("Logger (task 2.2)", () => {
  it("admits a stub with child() and level methods", () => {
    const events: Array<{ level: string; event: string }> = [];
    const record =
      (level: string) =>
      (event: string, _p?: Record<string, unknown>): void => {
        events.push({ level, event });
      };
    const stub: Logger = {
      child: () => stub,
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: (event, _p) => events.push({ level: "error", event }),
    };
    stub.info("startup");
    stub.error("failure", { reason: "x" });
    expect(events).toEqual([
      { level: "info", event: "startup" },
      { level: "error", event: "failure" },
    ]);
    expect(typeof stub.child({}).info).toBe("function");
  });
});
