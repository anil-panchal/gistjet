import { describe, expect, it } from "vitest";

import { CROCKFORD_BASE32_ALPHABET, createMappingId, isMappingId } from "../../src/shared/id";

describe("createMappingId (task 4.2)", () => {
  it("returns a 26-character Crockford base32 ULID", () => {
    const id = createMappingId();
    expect(id).toHaveLength(26);
    for (const ch of id) {
      expect(CROCKFORD_BASE32_ALPHABET).toContain(ch);
    }
  });

  it("produces distinct values across successive calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 128; i++) {
      seen.add(createMappingId());
    }
    expect(seen.size).toBe(128);
  });

  it("values generated in chronological order sort monotonically non-decreasing by creation time", () => {
    const first = createMappingId();
    // Sleep-free guarantee would be nice but ULIDs only strictly sort across millis.
    // Instead: the time prefix (first 10 chars) is monotonic non-decreasing.
    const second = createMappingId();
    const third = createMappingId();
    const prefixes = [first, second, third].map((v) => v.slice(0, 10));
    const sorted = [...prefixes].sort();
    expect(prefixes).toEqual(sorted);
  });
});

describe("isMappingId (task 4.2)", () => {
  it("accepts a fresh id", () => {
    expect(isMappingId(createMappingId())).toBe(true);
  });

  it("rejects values of the wrong length", () => {
    expect(isMappingId("01HXABC")).toBe(false);
    expect(isMappingId("0".repeat(27))).toBe(false);
  });

  it("rejects values containing disallowed Crockford letters (I, L, O, U)", () => {
    const base = createMappingId();
    const withU = `${base.slice(0, 25)}U`;
    expect(isMappingId(withU)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isMappingId(123 as unknown as string)).toBe(false);
    expect(isMappingId(null as unknown as string)).toBe(false);
    expect(isMappingId(undefined as unknown as string)).toBe(false);
  });
});
