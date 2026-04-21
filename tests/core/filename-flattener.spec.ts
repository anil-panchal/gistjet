import { describe, expect, it } from "vitest";

import { createFilenameFlattener, unflatten } from "../../src/core/filename-flattener";
import { isErr, isOk } from "../../src/shared/result";

describe("FilenameFlattener.flatten deterministic output (task 7.7, req 2.7)", () => {
  it("leaves a flat filename unchanged", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([{ relativePath: "README.md", sizeBytes: 10 }]);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.files[0]?.flattenedFilename).toBe("README.md");
  });

  it("replaces POSIX path separators with __", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([{ relativePath: "src/components/button.tsx", sizeBytes: 42 }]);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.files[0]?.flattenedFilename).toBe("src__components__button.tsx");
  });

  it("normalizes Windows-style backslashes to the same flattened output as forward slashes", () => {
    const flattener = createFilenameFlattener();
    const a = flattener.flatten([{ relativePath: "src\\components\\btn.tsx", sizeBytes: 1 }]);
    const b = flattener.flatten([{ relativePath: "src/components/btn.tsx", sizeBytes: 1 }]);
    if (!isOk(a) || !isOk(b)) throw new Error("unexpected err");
    expect(a.value.files[0]?.flattenedFilename).toBe(b.value.files[0]?.flattenedFilename);
  });

  it("percent-encodes disallowed characters (including underscore, space, and unicode)", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([
      { relativePath: "notes/my_file.ts", sizeBytes: 1 },
      { relativePath: "docs/hello world.md", sizeBytes: 2 },
      { relativePath: "i18n/résumé.txt", sizeBytes: 3 },
    ]);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const names = r.value.files.map((f) => f.flattenedFilename);
    expect(names[0]).toBe("notes__my%5Ffile.ts");
    expect(names[1]).toBe("docs__hello%20world.md");
    expect(names[2]).toContain("i18n__");
    expect(names[2]).not.toContain("é");
  });

  it("is deterministic — same input produces same output across calls", () => {
    const flattener = createFilenameFlattener();
    const input = [
      { relativePath: "a/b/c.md", sizeBytes: 1 },
      { relativePath: "d/e/f.ts", sizeBytes: 2 },
    ];
    const a = flattener.flatten(input);
    const b = flattener.flatten(input);
    expect(a).toEqual(b);
  });

  it("preserves the original relativePath and sizeBytes on every output entry", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([{ relativePath: "deep/nested/tree/leaf.md", sizeBytes: 77 }]);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.files[0]?.relativePath).toBe("deep/nested/tree/leaf.md");
    expect(r.value.files[0]?.sizeBytes).toBe(77);
  });
});

describe("FilenameFlattener reversibility (task 7.7, req 2.7)", () => {
  it("unflatten(flatten(path)) returns the original path for every realistic shape", () => {
    const flattener = createFilenameFlattener();
    const paths = [
      "README.md",
      "src/index.ts",
      "deep/nested/tree/leaf.md",
      "notes/my_file.ts",
      "docs/hello world.md",
      "with.multiple.dots/file.name.ts",
    ];
    const r = flattener.flatten(paths.map((p) => ({ relativePath: p, sizeBytes: 1 })));
    if (!isOk(r)) throw new Error("expected ok");
    for (let i = 0; i < paths.length; i += 1) {
      expect(unflatten(r.value.files[i]!.flattenedFilename)).toBe(paths[i]);
    }
  });
});

describe("FilenameFlattener collision detection (task 7.7, req 2.7)", () => {
  it("returns E_FILENAME_COLLISION when two sources flatten to the same name", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([
      { relativePath: "a__b.md", sizeBytes: 1 },
      { relativePath: "a/b.md", sizeBytes: 2 },
    ]);
    // Without encoding `_`, both would collide on `a__b.md`. With `_` encoded as %5F,
    // `a__b.md` becomes `a%5F%5Fb.md` and `a/b.md` becomes `a__b.md` — no collision.
    // To force a collision we use two paths that trivially produce the same flatten.
    expect(isOk(r)).toBe(true); // confirm our encoding avoids trivial collisions
    if (!isOk(r)) return;
    const r2 = flattener.flatten([
      { relativePath: "same/name.md", sizeBytes: 1 },
      { relativePath: "same/name.md", sizeBytes: 2 },
    ]);
    expect(isErr(r2)).toBe(true);
    if (!isErr(r2)) return;
    expect(r2.error.code).toBe("E_FILENAME_COLLISION");
    expect(r2.error.groups).toHaveLength(1);
    expect(r2.error.groups[0]?.flattened).toBe("same__name.md");
    expect(r2.error.groups[0]?.sources).toEqual(["same/name.md", "same/name.md"]);
  });

  it("reports every colliding group when multiple collisions exist", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([
      { relativePath: "dup/a.md", sizeBytes: 1 },
      { relativePath: "dup/a.md", sizeBytes: 2 },
      { relativePath: "other/b.txt", sizeBytes: 3 },
      { relativePath: "other/b.txt", sizeBytes: 4 },
      { relativePath: "unique.md", sizeBytes: 5 },
    ]);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.groups).toHaveLength(2);
    const flattenedNames = r.error.groups.map((g) => g.flattened).sort();
    expect(flattenedNames).toEqual(["dup__a.md", "other__b.txt"]);
  });

  it("does not report groups for non-colliding inputs", () => {
    const flattener = createFilenameFlattener();
    const r = flattener.flatten([
      { relativePath: "a.md", sizeBytes: 1 },
      { relativePath: "sub/b.md", sizeBytes: 2 },
      { relativePath: "deeper/sub/c.md", sizeBytes: 3 },
    ]);
    expect(isOk(r)).toBe(true);
  });
});
