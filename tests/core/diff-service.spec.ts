import { describe, expect, it } from "vitest";

import { createDiffService } from "../../src/core/diff-service";

describe("DiffService textual diff branch (task 7.3, req 4.3)", () => {
  it("returns a unified patch when both sides are text and within the size cap", () => {
    const svc = createDiffService();
    const result = svc.diff({
      filename: "notes.md",
      local: "hello\nworld\n",
      remote: "hello\nmoon\n",
      limitBytes: 8 * 1024,
    });
    expect(result.kind).toBe("diff");
    if (result.kind !== "diff") return;
    expect(result.unified).toContain("notes.md");
    expect(result.unified).toContain("-moon");
    expect(result.unified).toContain("+world");
  });

  it("returns a diff result even when local and remote are identical", () => {
    const svc = createDiffService();
    const result = svc.diff({
      filename: "x.txt",
      local: "same\n",
      remote: "same\n",
      limitBytes: 1024,
    });
    expect(result.kind).toBe("diff");
  });
});

describe("DiffService oversize summary branch (task 7.3, req 4.4)", () => {
  it("returns a too_large summary when the local content exceeds limitBytes", () => {
    const svc = createDiffService();
    const huge = "x".repeat(2_000);
    const result = svc.diff({
      filename: "big.txt",
      local: huge,
      remote: "small",
      limitBytes: 1_000,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.reason).toBe("too_large");
    expect(result.localSize).toBe(2_000);
    expect(result.remoteSize).toBe(5);
  });

  it("returns a too_large summary when the remote content exceeds limitBytes", () => {
    const svc = createDiffService();
    const huge = "y".repeat(5_000);
    const result = svc.diff({
      filename: "big.txt",
      local: "small",
      remote: huge,
      limitBytes: 1_000,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.reason).toBe("too_large");
  });

  it("returns a too_large summary when both sides fit but the unified patch itself exceeds the cap", () => {
    const svc = createDiffService();
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    const local = lines.map((l, i) => (i % 2 === 0 ? `${l}-changed` : l)).join("\n");
    const remote = lines.join("\n");
    const result = svc.diff({
      filename: "diff.txt",
      local,
      remote,
      limitBytes: 400,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.reason).toBe("too_large");
  });
});

describe("DiffService binary summary branch (task 7.3, req 11.2)", () => {
  it("returns a binary summary when local contains a null byte", () => {
    const svc = createDiffService();
    const result = svc.diff({
      filename: "image.bin",
      local: "abc\0def",
      remote: "abc",
      limitBytes: 1_000,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.reason).toBe("binary");
    expect(result.localSize).toBe(7);
    expect(result.remoteSize).toBe(3);
  });

  it("returns a binary summary when remote contains a null byte", () => {
    const svc = createDiffService();
    const result = svc.diff({
      filename: "image.bin",
      local: "abc",
      remote: "a\0b\0c",
      limitBytes: 1_000,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.reason).toBe("binary");
  });

  it("prefers the binary reason over too_large when both conditions are present", () => {
    const svc = createDiffService();
    const binaryOversize = "a\0".repeat(2_000);
    const result = svc.diff({
      filename: "big.bin",
      local: binaryOversize,
      remote: "small",
      limitBytes: 10,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.reason).toBe("binary");
  });
});

describe("DiffService size accounting (task 7.3)", () => {
  it("reports sizes as UTF-8 byte lengths (not JavaScript string length) for multi-byte content", () => {
    const svc = createDiffService();
    // Each '✓' is 3 bytes in UTF-8 but a single JS string code unit.
    const multibyte = "✓".repeat(100);
    const result = svc.diff({
      filename: "uni.txt",
      local: multibyte,
      remote: "a",
      limitBytes: 50,
    });
    expect(result.kind).toBe("summary");
    if (result.kind !== "summary") return;
    expect(result.localSize).toBe(300);
    expect(result.remoteSize).toBe(1);
  });
});
