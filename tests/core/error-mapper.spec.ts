import { describe, expect, it } from "vitest";

import { guardAsync, toMcp } from "../../src/core/error-mapper";
import type { DomainError } from "../../src/shared/error";
import { err, ok } from "../../src/shared/result";

const REQUEST_ID = "req-01HXABC";

describe("toMcp — universal envelope fields (task 2.3)", () => {
  it("echoes requestId verbatim", () => {
    const out = toMcp({ code: "E_VISIBILITY_CONFIRM" }, REQUEST_ID);
    expect(out.requestId).toBe(REQUEST_ID);
  });

  it("propagates the code unchanged", () => {
    const out = toMcp({ code: "E_VISIBILITY_CHANGE_REFUSED" }, REQUEST_ID);
    expect(out.code).toBe("E_VISIBILITY_CHANGE_REFUSED");
  });

  it("always includes a non-empty human message", () => {
    const out = toMcp({ code: "E_INTERNAL" }, REQUEST_ID);
    expect(out.message.length).toBeGreaterThan(0);
  });
});

describe("toMcp — per-variant payload translation (task 2.3)", () => {
  it("E_INPUT carries message and forwards details", () => {
    const out = toMcp(
      { code: "E_INPUT", message: "bad visibility", details: { field: "visibility" } },
      REQUEST_ID,
    );
    expect(out.code).toBe("E_INPUT");
    expect(out.message).toContain("bad visibility");
    expect(out.details?.field).toBe("visibility");
  });

  it("E_NOT_FOUND mentions resource + identifier in message and details", () => {
    const out = toMcp({ code: "E_NOT_FOUND", resource: "gist", identifier: "abc123" }, REQUEST_ID);
    expect(out.message).toContain("gist");
    expect(out.message).toContain("abc123");
    expect(out.details?.resource).toBe("gist");
    expect(out.details?.identifier).toBe("abc123");
  });

  it("E_EXISTS echoes the path", () => {
    const out = toMcp({ code: "E_EXISTS", path: "/work/.gistjet.json" }, REQUEST_ID);
    expect(out.message).toContain("/work/.gistjet.json");
    expect(out.details?.path).toBe("/work/.gistjet.json");
  });

  it.each([
    ["invalid_token", /invalid|expired/i],
    ["missing_permission", /permission/i],
    ["missing_token", /token|GISTJET_GITHUB_TOKEN/i],
    ["network", /network/i],
  ] as const)("E_AUTH %s maps to an actionable message", (detail, pattern) => {
    const out = toMcp({ code: "E_AUTH", detail }, REQUEST_ID);
    expect(out.code).toBe("E_AUTH");
    expect(out.message).toMatch(pattern);
    expect(out.details?.detail).toBe(detail);
  });

  it("E_RATE_LIMIT includes resetAt", () => {
    const out = toMcp({ code: "E_RATE_LIMIT", resetAt: "2026-04-17T20:00:00Z" }, REQUEST_ID);
    expect(out.message).toContain("2026-04-17T20:00:00Z");
    expect(out.details?.resetAt).toBe("2026-04-17T20:00:00Z");
  });

  it("E_CONFLICT forwards classification + report", () => {
    const report = {
      classification: "diverged" as const,
      local: { hash: "a" },
      remote: { revision: "b" },
      lastKnown: { localHash: null, remoteRevision: null },
    };
    const out = toMcp({ code: "E_CONFLICT", classification: "diverged", report }, REQUEST_ID);
    expect(out.details?.classification).toBe("diverged");
    expect(out.details?.report).toBe(report);
  });

  it("E_ORPHANED carries mappingId", () => {
    const out = toMcp({ code: "E_ORPHANED", mappingId: "01HX" }, REQUEST_ID);
    expect(out.details?.mappingId).toBe("01HX");
  });

  it("E_LOCAL_MISSING carries mappingId + path", () => {
    const out = toMcp(
      { code: "E_LOCAL_MISSING", mappingId: "01HX", path: "scratch/a.md" },
      REQUEST_ID,
    );
    expect(out.message).toContain("scratch/a.md");
    expect(out.details?.mappingId).toBe("01HX");
    expect(out.details?.path).toBe("scratch/a.md");
  });

  it("E_LOCAL_OVERWRITE_CONFIRM forwards the planned file list", () => {
    const files = [{ path: "a.md", sizeBytes: 10 }];
    const out = toMcp({ code: "E_LOCAL_OVERWRITE_CONFIRM", files }, REQUEST_ID);
    expect(out.message).toMatch(/confirm_overwrite_local/);
    expect(out.details?.files).toEqual(files);
  });

  it("E_SECRET_DETECTED forwards findings", () => {
    const findings = [
      {
        id: "1",
        filename: "a.ts",
        line: 3,
        ruleId: "aws-key",
        confidence: "high" as const,
        redactedExcerpt: "AKIA****",
      },
    ];
    const out = toMcp({ code: "E_SECRET_DETECTED", findings }, REQUEST_ID);
    expect(out.details?.findings).toEqual(findings);
    expect(out.message).toMatch(/1/);
  });

  it("E_VISIBILITY_CONFIRM message references confirm_public", () => {
    const out = toMcp({ code: "E_VISIBILITY_CONFIRM" }, REQUEST_ID);
    expect(out.message).toMatch(/confirm_public/);
  });

  it("E_VISIBILITY_CHANGE_REFUSED message references visibility", () => {
    const out = toMcp({ code: "E_VISIBILITY_CHANGE_REFUSED" }, REQUEST_ID);
    expect(out.message).toMatch(/visibility/i);
  });

  it("E_TOO_LARGE forwards file/sizeBytes/limit", () => {
    const out = toMcp(
      { code: "E_TOO_LARGE", file: "big.bin", sizeBytes: 2_000_000, limit: 1_000_000 },
      REQUEST_ID,
    );
    expect(out.message).toContain("big.bin");
    expect(out.details).toEqual({ file: "big.bin", sizeBytes: 2_000_000, limit: 1_000_000 });
  });

  it("E_TOO_MANY_FILES forwards count + limit", () => {
    const out = toMcp({ code: "E_TOO_MANY_FILES", count: 301, limit: 300 }, REQUEST_ID);
    expect(out.message).toContain("301");
    expect(out.details).toEqual({ count: 301, limit: 300 });
  });

  it("E_BINARY forwards file and mentions allow_binary", () => {
    const out = toMcp({ code: "E_BINARY", file: "blob.bin" }, REQUEST_ID);
    expect(out.message).toMatch(/allow_binary/);
    expect(out.details?.file).toBe("blob.bin");
  });

  it("E_FILENAME_COLLISION forwards groups", () => {
    const groups = [{ flattened: "a__b.md", sources: ["a/b.md", "a-b.md"] }];
    const out = toMcp({ code: "E_FILENAME_COLLISION", groups }, REQUEST_ID);
    expect(out.details?.groups).toEqual(groups);
  });

  it("E_POST_PUBLISH_MISMATCH forwards gistId/htmlUrl/mismatched", () => {
    const payload = {
      code: "E_POST_PUBLISH_MISMATCH" as const,
      gistId: "abc",
      htmlUrl: "https://gist.github.com/abc",
      mismatched: ["x.md"],
    };
    const out = toMcp(payload, REQUEST_ID);
    expect(out.message).toContain("abc");
    expect(out.details).toEqual({
      gistId: "abc",
      htmlUrl: "https://gist.github.com/abc",
      mismatched: ["x.md"],
    });
  });

  it("E_SCHEMA_NEWER forwards required + found", () => {
    const out = toMcp({ code: "E_SCHEMA_NEWER", required: 1, found: 2 }, REQUEST_ID);
    expect(out.message).toMatch(/newer/i);
    expect(out.details).toEqual({ required: 1, found: 2 });
  });

  it("E_PARSE forwards cause", () => {
    const out = toMcp({ code: "E_PARSE", cause: "unexpected token" }, REQUEST_ID);
    expect(out.message).toContain("unexpected token");
    expect(out.details?.cause).toBe("unexpected token");
  });

  it("E_IO forwards path + cause", () => {
    const out = toMcp({ code: "E_IO", path: "/tmp/x", cause: "EACCES" }, REQUEST_ID);
    expect(out.message).toContain("/tmp/x");
    expect(out.details).toEqual({ path: "/tmp/x", cause: "EACCES" });
  });

  it("E_INTERNAL without cause omits details", () => {
    const out = toMcp({ code: "E_INTERNAL" }, REQUEST_ID);
    expect(out.code).toBe("E_INTERNAL");
    expect(out.details).toBeUndefined();
  });

  it("E_INTERNAL serializes an Error cause into name + message", () => {
    const out = toMcp({ code: "E_INTERNAL", cause: new Error("boom") }, REQUEST_ID);
    expect(out.details?.cause).toEqual({ name: "Error", message: "boom" });
  });

  it("E_INTERNAL passes non-Error cause through verbatim", () => {
    const out = toMcp({ code: "E_INTERNAL", cause: "str" }, REQUEST_ID);
    expect(out.details?.cause).toBe("str");
  });
});

describe("toMcp exhaustiveness (task 2.3)", () => {
  it("maps every canonical ERROR_CODES entry", () => {
    // Spot-check every code resolves to a defined message. Using representative
    // payloads — the per-variant tests above cover the specifics.
    const samples: DomainError[] = [
      { code: "E_INPUT", message: "x" },
      { code: "E_NOT_FOUND", resource: "r" },
      { code: "E_EXISTS", path: "/x" },
      { code: "E_AUTH", detail: "invalid_token" },
      { code: "E_RATE_LIMIT", resetAt: "2026-01-01T00:00:00Z" },
      {
        code: "E_CONFLICT",
        classification: "diverged",
        report: {
          classification: "diverged",
          local: { hash: null },
          remote: { revision: null },
          lastKnown: { localHash: null, remoteRevision: null },
        },
      },
      { code: "E_ORPHANED", mappingId: "m" },
      { code: "E_LOCAL_MISSING", mappingId: "m", path: "/p" },
      { code: "E_LOCAL_OVERWRITE_CONFIRM", files: [] },
      { code: "E_SECRET_DETECTED", findings: [] },
      { code: "E_VISIBILITY_CONFIRM" },
      { code: "E_VISIBILITY_CHANGE_REFUSED" },
      { code: "E_TOO_LARGE", file: "f", sizeBytes: 2, limit: 1 },
      { code: "E_TOO_MANY_FILES", count: 2, limit: 1 },
      { code: "E_BINARY", file: "b" },
      { code: "E_FILENAME_COLLISION", groups: [] },
      { code: "E_POST_PUBLISH_MISMATCH", gistId: "g", htmlUrl: "u", mismatched: [] },
      { code: "E_SCHEMA_NEWER", required: 1, found: 2 },
      { code: "E_PARSE", cause: "c" },
      { code: "E_IO", path: "/p", cause: "c" },
      { code: "E_INTERNAL" },
    ];
    for (const e of samples) {
      const out = toMcp(e, REQUEST_ID);
      expect(out.code).toBe(e.code);
      expect(out.message.length).toBeGreaterThan(0);
      expect(out.requestId).toBe(REQUEST_ID);
    }
    expect(samples).toHaveLength(21);
  });
});

describe("guardAsync (task 2.3)", () => {
  it("returns ok(value) when fn resolves to ok", async () => {
    const result = await guardAsync(async () => ok(42));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("returns err(domainError) when fn resolves to err", async () => {
    const result = await guardAsync(async () => err({ code: "E_INPUT" as const, message: "bad" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_INPUT");
  });

  it("catches thrown Error and emits E_INTERNAL with the cause", async () => {
    const boom = new Error("boom");
    const result = await guardAsync(async () => {
      throw boom;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_INTERNAL");
      if (result.error.code === "E_INTERNAL") {
        expect(result.error.cause).toBe(boom);
      }
    }
  });

  it("catches non-Error throw (e.g., string) and emits E_INTERNAL", async () => {
    const result = await guardAsync(async () => {
      throw "raw string";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_INTERNAL");
  });
});
