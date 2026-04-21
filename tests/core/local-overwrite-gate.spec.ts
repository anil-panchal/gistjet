import { describe, expect, it } from "vitest";

import { createIgnoreEngine } from "../../src/core/ignore-engine";
import { createLocalOverwriteGate } from "../../src/core/local-overwrite-gate";
import { isErr, isOk } from "../../src/shared/result";

function matcher(
  overrides: Partial<{
    workspacePatterns: readonly string[];
    respectGitignore: boolean;
    gitignoreContents: string;
  }> = {},
) {
  return createIgnoreEngine().build({
    workspaceRoot: "/tmp/ws",
    workspacePatterns: overrides.workspacePatterns ?? [],
    respectGitignore: overrides.respectGitignore ?? false,
    ...(overrides.gitignoreContents !== undefined
      ? { gitignoreContents: overrides.gitignoreContents }
      : {}),
  });
}

describe("LocalOverwriteGate.authorize (task 7.6, req 17.1, 17.2, 17.4)", () => {
  it("splits approved vs ignored_on_pull using the IgnoreEngine", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [
        { relativePath: "src/index.ts", sizeBytes: 120 },
        { relativePath: ".env", sizeBytes: 40 },
        { relativePath: ".git/HEAD", sizeBytes: 50 },
      ],
      confirmOverwriteLocal: true,
      ignoreMatcher: matcher(),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approved).toEqual([{ relativePath: "src/index.ts", sizeBytes: 120 }]);
    expect(result.value.ignoredOnPull.slice().sort()).toEqual([".env", ".git/HEAD"].sort());
  });

  it("rejects with E_LOCAL_OVERWRITE_CONFIRM when approved is non-empty and confirmOverwriteLocal is missing", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [
        { relativePath: "src/index.ts", sizeBytes: 10 },
        { relativePath: "docs/readme.md", sizeBytes: 20 },
      ],
      ignoreMatcher: matcher(),
    });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("E_LOCAL_OVERWRITE_CONFIRM");
    expect(result.error.files.length).toBe(2);
    expect(result.error.files.map((f) => f.relativePath).sort()).toEqual([
      "docs/readme.md",
      "src/index.ts",
    ]);
  });

  it("rejects with E_LOCAL_OVERWRITE_CONFIRM when confirmOverwriteLocal is explicitly false", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [{ relativePath: "a.ts", sizeBytes: 1 }],
      confirmOverwriteLocal: false,
      ignoreMatcher: matcher(),
    });
    expect(isErr(result)).toBe(true);
  });

  it("approves every non-ignored write when confirmOverwriteLocal is true", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [
        { relativePath: "a.ts", sizeBytes: 1 },
        { relativePath: "b.ts", sizeBytes: 2 },
      ],
      confirmOverwriteLocal: true,
      ignoreMatcher: matcher(),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approved).toHaveLength(2);
    expect(result.value.ignoredOnPull).toHaveLength(0);
  });

  it("returns ok silently when every planned write is ignored (no confirmation required)", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [
        { relativePath: ".env", sizeBytes: 1 },
        { relativePath: ".git/config", sizeBytes: 2 },
      ],
      ignoreMatcher: matcher(),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approved).toEqual([]);
    expect(result.value.ignoredOnPull.slice().sort()).toEqual([".env", ".git/config"].sort());
  });

  it("returns ok silently when the planned write list is empty", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [],
      ignoreMatcher: matcher(),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approved).toEqual([]);
    expect(result.value.ignoredOnPull).toEqual([]);
  });

  it("drops hardened-ignore paths regardless of confirmOverwriteLocal (req 17.4)", () => {
    const gate = createLocalOverwriteGate();
    const result = gate.authorize({
      plannedWrites: [
        { relativePath: ".env.local", sizeBytes: 10 },
        { relativePath: ".git/HEAD", sizeBytes: 5 },
        { relativePath: "ok.ts", sizeBytes: 30 },
      ],
      confirmOverwriteLocal: true,
      ignoreMatcher: matcher({ workspacePatterns: ["!.env.local", "!.git/HEAD"] }),
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.approved.map((f) => f.relativePath)).toEqual(["ok.ts"]);
    expect(result.value.ignoredOnPull.slice().sort()).toEqual([".env.local", ".git/HEAD"]);
  });

  it("does not mutate its input arrays", () => {
    const gate = createLocalOverwriteGate();
    const input = [
      { relativePath: "a.ts", sizeBytes: 1 },
      { relativePath: ".env", sizeBytes: 2 },
    ];
    gate.authorize({
      plannedWrites: input,
      confirmOverwriteLocal: true,
      ignoreMatcher: matcher(),
    });
    expect(input).toEqual([
      { relativePath: "a.ts", sizeBytes: 1 },
      { relativePath: ".env", sizeBytes: 2 },
    ]);
  });
});
