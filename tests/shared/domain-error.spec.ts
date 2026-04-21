import { describe, expect, it } from "vitest";

import type { DomainError, ErrorCode } from "../../src/shared/error";
import { ERROR_CODES } from "../../src/shared/error";

const CANONICAL_CODES = [
  "E_INPUT",
  "E_NOT_FOUND",
  "E_EXISTS",
  "E_AUTH",
  "E_RATE_LIMIT",
  "E_CONFLICT",
  "E_ORPHANED",
  "E_LOCAL_MISSING",
  "E_LOCAL_OVERWRITE_CONFIRM",
  "E_SECRET_DETECTED",
  "E_VISIBILITY_CONFIRM",
  "E_VISIBILITY_CHANGE_REFUSED",
  "E_TOO_LARGE",
  "E_TOO_MANY_FILES",
  "E_BINARY",
  "E_FILENAME_COLLISION",
  "E_POST_PUBLISH_MISMATCH",
  "E_SCHEMA_NEWER",
  "E_PARSE",
  "E_IO",
  "E_INTERNAL",
] as const;

describe("DomainError codes (task 2.1)", () => {
  it("exports ERROR_CODES for every canonical code in design.md", () => {
    for (const code of CANONICAL_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it("ERROR_CODES has exactly the canonical count with no extras", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES.length).toBe(CANONICAL_CODES.length);
  });

  it("every ERROR_CODES entry is assignable to ErrorCode", () => {
    const assign = (c: (typeof ERROR_CODES)[number]): ErrorCode => c;
    for (const code of ERROR_CODES) {
      expect(assign(code)).toBe(code);
    }
  });
});

describe("DomainError variant payloads (task 2.1)", () => {
  it("E_INPUT carries a human message", () => {
    const e: DomainError = { code: "E_INPUT", message: "bad field" };
    expect(e.code).toBe("E_INPUT");
  });

  it("E_NOT_FOUND carries resource + identifier", () => {
    const e: DomainError = { code: "E_NOT_FOUND", resource: "gist", identifier: "abc123" };
    expect(e.code).toBe("E_NOT_FOUND");
  });

  it("E_EXISTS carries the conflicting path", () => {
    const e: DomainError = { code: "E_EXISTS", path: "/work/.gistjet.json" };
    expect(e.code).toBe("E_EXISTS");
  });

  it("E_AUTH detail is one of invalid_token / missing_permission / network / missing_token", () => {
    const invalid: DomainError = { code: "E_AUTH", detail: "invalid_token" };
    const missingPerm: DomainError = { code: "E_AUTH", detail: "missing_permission" };
    const network: DomainError = { code: "E_AUTH", detail: "network" };
    const missingTok: DomainError = { code: "E_AUTH", detail: "missing_token" };
    expect([invalid, missingPerm, network, missingTok].every((e) => e.code === "E_AUTH")).toBe(
      true,
    );
  });

  it("E_RATE_LIMIT carries resetAt timestamp", () => {
    const e: DomainError = { code: "E_RATE_LIMIT", resetAt: "2026-04-17T20:00:00Z" };
    expect(e.code).toBe("E_RATE_LIMIT");
  });

  it("E_LOCAL_MISSING carries mappingId + path", () => {
    const e: DomainError = { code: "E_LOCAL_MISSING", mappingId: "01HX", path: "scratch/a.md" };
    expect(e.code).toBe("E_LOCAL_MISSING");
  });

  it("E_LOCAL_OVERWRITE_CONFIRM carries the planned file list", () => {
    const e: DomainError = {
      code: "E_LOCAL_OVERWRITE_CONFIRM",
      files: [{ path: "a.md", sizeBytes: 10 }],
    };
    expect(e.files[0]?.path).toBe("a.md");
  });

  it("E_TOO_LARGE carries file + sizeBytes + limit", () => {
    const e: DomainError = {
      code: "E_TOO_LARGE",
      file: "big.bin",
      sizeBytes: 2_000_000,
      limit: 1_000_000,
    };
    expect(e.code).toBe("E_TOO_LARGE");
  });

  it("E_TOO_MANY_FILES carries count + limit", () => {
    const e: DomainError = { code: "E_TOO_MANY_FILES", count: 301, limit: 300 };
    expect(e.code).toBe("E_TOO_MANY_FILES");
  });

  it("E_BINARY carries file", () => {
    const e: DomainError = { code: "E_BINARY", file: "blob.bin" };
    expect(e.code).toBe("E_BINARY");
  });

  it("E_FILENAME_COLLISION carries grouped flattened collisions", () => {
    const e: DomainError = {
      code: "E_FILENAME_COLLISION",
      groups: [{ flattened: "a__b.md", sources: ["a/b.md", "a-b.md"] }],
    };
    expect(e.groups[0]?.sources.length).toBe(2);
  });

  it("E_POST_PUBLISH_MISMATCH carries gistId, htmlUrl, mismatched", () => {
    const e: DomainError = {
      code: "E_POST_PUBLISH_MISMATCH",
      gistId: "abc",
      htmlUrl: "https://gist.github.com/abc",
      mismatched: ["x.md"],
    };
    expect(e.mismatched.length).toBe(1);
  });

  it("E_SCHEMA_NEWER carries required + found", () => {
    const e: DomainError = { code: "E_SCHEMA_NEWER", required: 1, found: 2 };
    expect(e.code).toBe("E_SCHEMA_NEWER");
  });

  it("E_PARSE carries cause", () => {
    const e: DomainError = { code: "E_PARSE", cause: "unexpected token" };
    expect(e.code).toBe("E_PARSE");
  });

  it("E_IO carries path + cause", () => {
    const e: DomainError = { code: "E_IO", path: "/tmp/x", cause: "EACCES" };
    expect(e.code).toBe("E_IO");
  });

  it("E_INTERNAL is valid with or without cause", () => {
    const bare: DomainError = { code: "E_INTERNAL" };
    const withCause: DomainError = { code: "E_INTERNAL", cause: new Error("boom") };
    expect(bare.code).toBe("E_INTERNAL");
    expect(withCause.code).toBe("E_INTERNAL");
  });
});

describe("DomainError exhaustiveness (task 2.1)", () => {
  // Compile-time + runtime exhaustive switch over every variant.
  function describeCode(e: DomainError): string {
    switch (e.code) {
      case "E_INPUT":
      case "E_NOT_FOUND":
      case "E_EXISTS":
      case "E_AUTH":
      case "E_RATE_LIMIT":
      case "E_CONFLICT":
      case "E_ORPHANED":
      case "E_LOCAL_MISSING":
      case "E_LOCAL_OVERWRITE_CONFIRM":
      case "E_SECRET_DETECTED":
      case "E_VISIBILITY_CONFIRM":
      case "E_VISIBILITY_CHANGE_REFUSED":
      case "E_TOO_LARGE":
      case "E_TOO_MANY_FILES":
      case "E_BINARY":
      case "E_FILENAME_COLLISION":
      case "E_POST_PUBLISH_MISMATCH":
      case "E_SCHEMA_NEWER":
      case "E_PARSE":
      case "E_IO":
      case "E_INTERNAL":
        return e.code;
      default: {
        const _never: never = e;
        return _never;
      }
    }
  }

  it("switch compiles exhaustively and echoes the code", () => {
    const samples: DomainError[] = [
      { code: "E_INPUT", message: "x" },
      { code: "E_VISIBILITY_CONFIRM" },
      { code: "E_INTERNAL" },
    ];
    for (const e of samples) {
      expect(describeCode(e)).toBe(e.code);
    }
  });
});
