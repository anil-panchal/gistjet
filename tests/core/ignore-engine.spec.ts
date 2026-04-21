import { describe, expect, it } from "vitest";

import { createIgnoreEngine, HARDENED_IGNORE_PATTERNS } from "../../src/core/ignore-engine";

function buildMatcher(
  overrides: Partial<{
    workspacePatterns: readonly string[];
    respectGitignore: boolean;
    gitignoreContents: string;
  }> = {},
) {
  const engine = createIgnoreEngine();
  return engine.build({
    workspaceRoot: "/tmp/workspace",
    workspacePatterns: overrides.workspacePatterns ?? [],
    respectGitignore: overrides.respectGitignore ?? false,
    ...(overrides.gitignoreContents !== undefined
      ? { gitignoreContents: overrides.gitignoreContents }
      : {}),
  });
}

describe("IgnoreEngine hardened defaults (task 7.1, req 10.1)", () => {
  it("ignores `.env` by default", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored(".env")).toBe(true);
  });

  it("ignores `.env.local` by default", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored(".env.local")).toBe(true);
  });

  it("ignores files under `.git/` by default", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored(".git/config")).toBe(true);
    expect(matcher.isIgnored(".git/HEAD")).toBe(true);
  });

  it("ignores `node_modules/`, `dist/`, `build/`, `coverage/` contents by default", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored("node_modules/foo/index.js")).toBe(true);
    expect(matcher.isIgnored("dist/bundle.js")).toBe(true);
    expect(matcher.isIgnored("build/output.txt")).toBe(true);
    expect(matcher.isIgnored("coverage/lcov.info")).toBe(true);
  });

  it("ignores `.DS_Store` and `*.log` by default", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored(".DS_Store")).toBe(true);
    expect(matcher.isIgnored("server.log")).toBe(true);
    expect(matcher.isIgnored("logs/run.log")).toBe(true);
  });

  it("ignores common binary/archive extensions by default", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored("asset.zip")).toBe(true);
    expect(matcher.isIgnored("photo.png")).toBe(true);
    expect(matcher.isIgnored("backup.tar.gz")).toBe(true);
    expect(matcher.isIgnored("release.exe")).toBe(true);
  });

  it("does NOT ignore ordinary source files", () => {
    const matcher = buildMatcher();
    expect(matcher.isIgnored("src/index.ts")).toBe(false);
    expect(matcher.isIgnored("README.md")).toBe(false);
    expect(matcher.isIgnored("docs/guide.md")).toBe(false);
  });
});

describe("IgnoreEngine workspace patterns (task 7.1, req 10.2)", () => {
  it("combines workspace patterns with built-in defaults", () => {
    const matcher = buildMatcher({ workspacePatterns: ["*.bak", "tmp/"] });
    expect(matcher.isIgnored("notes.bak")).toBe(true);
    expect(matcher.isIgnored("tmp/cache.json")).toBe(true);
    // built-ins still apply
    expect(matcher.isIgnored("node_modules/foo.js")).toBe(true);
    expect(matcher.isIgnored("src/index.ts")).toBe(false);
  });
});

describe("IgnoreEngine hardened-pattern protection (task 7.1, req 10.4)", () => {
  it("refuses to un-ignore `.env` when workspace has `!.env` negation", () => {
    const matcher = buildMatcher({ workspacePatterns: ["!.env"] });
    expect(matcher.isIgnored(".env")).toBe(true);
  });

  it("refuses to un-ignore `.env.local` when workspace has `!.env.local` negation", () => {
    const matcher = buildMatcher({ workspacePatterns: ["!.env.local"] });
    expect(matcher.isIgnored(".env.local")).toBe(true);
  });

  it("refuses to un-ignore files in `.git/` when workspace has `!.git/config` negation", () => {
    const matcher = buildMatcher({ workspacePatterns: ["!.git/config"] });
    expect(matcher.isIgnored(".git/config")).toBe(true);
  });

  it("refuses to un-ignore even when gitignore opts to un-ignore the hardened path", () => {
    const matcher = buildMatcher({
      respectGitignore: true,
      gitignoreContents: "!.env\n!.git/\n",
    });
    expect(matcher.isIgnored(".env")).toBe(true);
    expect(matcher.isIgnored(".git/HEAD")).toBe(true);
  });

  it("exposes the hardened pattern list as a readonly export for discovery", () => {
    expect(HARDENED_IGNORE_PATTERNS).toEqual(expect.arrayContaining([".env*", ".git/"]));
  });
});

describe("IgnoreEngine .gitignore opt-in (task 7.1, req 10.3)", () => {
  it("ignores .gitignore patterns when respectGitignore is true", () => {
    const matcher = buildMatcher({
      respectGitignore: true,
      gitignoreContents: "custom-cache/\n*.generated.ts\n",
    });
    expect(matcher.isIgnored("custom-cache/data.json")).toBe(true);
    expect(matcher.isIgnored("types.generated.ts")).toBe(true);
  });

  it("does NOT apply .gitignore patterns when respectGitignore is false", () => {
    const matcher = buildMatcher({
      respectGitignore: false,
      gitignoreContents: "custom-cache/\n",
    });
    expect(matcher.isIgnored("custom-cache/data.json")).toBe(false);
  });

  it("treats missing .gitignore contents as empty (no crash, no extra rules)", () => {
    const matcher = buildMatcher({ respectGitignore: true });
    expect(matcher.isIgnored("src/index.ts")).toBe(false);
    // built-ins still apply
    expect(matcher.isIgnored(".env")).toBe(true);
  });

  it("skips comments and blank lines in .gitignore", () => {
    const matcher = buildMatcher({
      respectGitignore: true,
      gitignoreContents: "# a comment\n\nscratch/\n   \n",
    });
    expect(matcher.isIgnored("scratch/stuff.txt")).toBe(true);
    expect(matcher.isIgnored("# a comment")).toBe(false);
  });
});

describe("IgnoreEngine.explain (task 7.1, req 10.5)", () => {
  it("returns null for paths that are NOT ignored", () => {
    const matcher = buildMatcher();
    expect(matcher.explain("src/index.ts")).toBeNull();
  });

  it("attributes hardened `.env*` matches to the builtin source", () => {
    const matcher = buildMatcher();
    const explanation = matcher.explain(".env");
    expect(explanation).not.toBeNull();
    expect(explanation?.source).toBe("builtin");
    expect(explanation?.pattern).toBe(".env*");
  });

  it("attributes `.git/` matches to the builtin source", () => {
    const matcher = buildMatcher();
    const explanation = matcher.explain(".git/HEAD");
    expect(explanation?.source).toBe("builtin");
    expect(explanation?.pattern).toBe(".git/");
  });

  it("attributes `node_modules/` matches to the builtin source", () => {
    const matcher = buildMatcher();
    const explanation = matcher.explain("node_modules/foo/index.js");
    expect(explanation?.source).toBe("builtin");
    expect(explanation?.pattern).toBe("node_modules/");
  });

  it("attributes workspace-only matches to the workspace source", () => {
    const matcher = buildMatcher({ workspacePatterns: ["*.bak", "tmp/"] });
    const explanation = matcher.explain("notes.bak");
    expect(explanation?.source).toBe("workspace");
    expect(explanation?.pattern).toBe("*.bak");
  });

  it("attributes gitignore-only matches to the gitignore source", () => {
    const matcher = buildMatcher({
      respectGitignore: true,
      gitignoreContents: "custom-cache/\n",
    });
    const explanation = matcher.explain("custom-cache/data.json");
    expect(explanation?.source).toBe("gitignore");
    expect(explanation?.pattern).toBe("custom-cache/");
  });

  it("prefers the hardened builtin attribution when workspace also ignores the same path", () => {
    const matcher = buildMatcher({ workspacePatterns: [".env"] });
    const explanation = matcher.explain(".env");
    expect(explanation?.source).toBe("builtin");
    expect(explanation?.pattern).toBe(".env*");
  });

  it("does not attribute ignored paths to negation patterns (which un-ignore rather than ignore)", () => {
    const matcher = buildMatcher({ workspacePatterns: ["!ignored-by-builtin"] });
    // build/output.txt is ignored by built-in; explain must not pick up the workspace negation
    const explanation = matcher.explain("build/output.txt");
    expect(explanation?.source).toBe("builtin");
    expect(explanation?.pattern).toBe("build/");
  });
});
